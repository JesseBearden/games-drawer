/**
 * The rollout tool: runs on one game server box, as root, from inside a release bundle
 * (release/deploy/rollout.mjs). games-drawer-deploy calls it, and the fleet tool (fleet.ts)
 * calls that through AWS Systems Manager:
 *
 *   rollout <release> start <slot> [previous]  set the box up and start this release as <slot>
 *   rollout <release> route <map>              take the fleet map (base64 JSON) and reroute
 *   rollout <release> share <running>          copy build files between this release and the
 *                                              one this box runs, so pages from either load
 *   rollout <release> check                    is the server healthy? (exit 1 if not)
 *   rollout <release> retire <minutes>         finish the games here, then shut the box down
 *   rollout <release> status                   print what's running
 *
 * Each box runs one copy of the game server; a deploy brings up a new box beside the old one
 * (deploy/README.md). A deploy never cuts a game off: the old box gets SIGUSR2, finishes the
 * games it has, then powers off, and AWS removes it (it was launched to terminate on shutdown).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_PORT, isFleetMap, routesSnippet, soloMap, SLOTS, type FleetMap, type Slot } from './fleetMap';

export const ETC = '/etc/games-drawer';
export const STATE_FILE = `${ETC}/state.json`;
export const ROUTES_FILE = '/etc/caddy/games-drawer-routes.caddy';
export const RELEASES = '/opt/games-drawer/releases';
/** How often a retiring box checks whether its games are done. */
export const RETIRE_POLL_MS = 30_000;

export interface State {
  /** This box's slot (its room codes all name it) and the release it runs. */
  slot: Slot | null;
  release: string | null;
  /** Set once the box is finishing its games before shutting down. */
  retiring: boolean;
}

export const EMPTY_STATE: State = { slot: null, release: null, retiring: false };

/** The env file for this box's game server (see games-drawer@.service). */
export function slotEnv(slot: Slot, release: string, releaseDir: string): string {
  return [`GAME_PORT=${GAME_PORT}`, `SLOT=${slot}`, `RELEASE=${release}`, `RELEASE_DIR=${releaseDir}`].join('\n') + '\n';
}

export interface Health {
  ok: boolean;
  release: string;
  slot: string | null;
  draining: boolean;
}

export interface ServerStats {
  handlerErrors: number;
  roomErrors: number;
  restarts: number;
  running: boolean;
}

/** What makes a new box fail its check. Any crash, restart or error counts: real ones are rare. */
export function serverProblems(s: ServerStats): string[] {
  const problems: string[] = [];
  if (!s.running) problems.push('the game server is not running');
  if (s.restarts > 0) problems.push(`it restarted ${s.restarts} time(s)`);
  if (s.roomErrors > 0) problems.push(`${s.roomErrors} room(s) crashed`);
  if (s.handlerErrors > 0) problems.push(`${s.handlerErrors} message handler error(s)`);
  return problems;
}

/** Copy build assets each release lacks from the other, so a page from either release can load. */
export function shareAssets(dirA: string, dirB: string) {
  const a = path.join(dirA, 'client', 'assets');
  const b = path.join(dirB, 'client', 'assets');
  for (const [from, to] of [
    [a, b],
    [b, a],
  ]) {
    if (!fs.existsSync(from) || !fs.existsSync(to)) continue;
    for (const f of fs.readdirSync(from)) {
      const dest = path.join(to, f);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(from, f), dest);
    }
  }
}

/** The fleet map, as the fleet tool sends it (base64 JSON, so it passes through a shell untouched). */
export function decodeMap(arg: string | undefined): FleetMap {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(arg ?? '', 'base64').toString('utf8'));
  } catch {
    throw new Error('The fleet map is not valid base64 JSON.');
  }
  if (!isFleetMap(v)) throw new Error('That is not a fleet map.');
  return v;
}

// ---------------------------------------------------------------- side effects

/** Everything that touches the machine, so tests can swap it out. */
export interface System {
  readState(): State;
  writeState(s: State): void;
  writeFile(file: string, text: string): void;
  sh(cmd: string, args: string[]): string;
  health(): Promise<Health | null>;
  stats(): Promise<Record<string, unknown> | null>;
  /** This box's private IP and the site's domain (from the instance and deploy.env). */
  privateIp(): string;
  domain(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
}

function envValue(file: string, key: string): string {
  try {
    return new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(file, 'utf8'))?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

export const realSystem: System = {
  readState() {
    try {
      return { ...structuredClone(EMPTY_STATE), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  },
  writeState(s) {
    this.writeFile(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
  },
  writeFile(file, text) {
    fs.writeFileSync(file + '.tmp', text);
    fs.renameSync(file + '.tmp', file);
  },
  sh(cmd, args) {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  },
  async health() {
    try {
      const res = await fetch(`http://127.0.0.1:${GAME_PORT}/healthz`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? ((await res.json()) as Health) : null;
    } catch {
      return null;
    }
  },
  async stats() {
    try {
      const token = envValue(`${ETC}/secrets.env`, 'STATS_TOKEN');
      const res = await fetch(`http://127.0.0.1:${GAME_PORT}/stats?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },
  privateIp: () => envValue(`${ETC}/box.env`, 'PRIVATE_IP'),
  domain: () => envValue(`${ETC}/deploy.env`, 'DOMAIN'),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (msg) => console.log(msg),
};

export class Rollout {
  constructor(
    private sys: System,
    private release: string,
    private releaseDir: string,
  ) {}

  private unit(slot: Slot) {
    return `games-drawer@${slot}`;
  }

  private mySlot(): Slot {
    const { slot } = this.sys.readState();
    if (!slot) throw new Error('This box has no game server yet (run start first).');
    return slot;
  }

  /** Run this release's setup.sh if it differs from the last one that ran. */
  ensureSetup() {
    const script = path.join(this.releaseDir, 'deploy', 'setup.sh');
    const hash = createHash('sha256').update(fs.readFileSync(script)).digest('hex');
    let last = '';
    try {
      last = fs.readFileSync(`${ETC}/setup.sha256`, 'utf8').trim();
    } catch {
      /* first run */
    }
    if (last === hash) return;
    this.sys.log('Running setup.sh (machine setup changed)…');
    this.sys.log(this.sys.sh('bash', [script, path.dirname(script)]).trim());
    this.sys.writeFile(`${ETC}/setup.sha256`, hash + '\n');
  }

  private writeRoutes(map: FleetMap, slot: Slot) {
    this.sys.writeFile(ROUTES_FILE, routesSnippet(map, slot, this.sys.domain()));
    this.sys.sh('systemctl', ['reload', 'caddy']);
  }

  /** Set the box up and start this release as `slot`. A new box serves everything itself until the fleet tool says otherwise. */
  async start(slot: Slot, previous?: string) {
    if (!SLOTS.includes(slot)) throw new Error(`Unknown slot ${slot}.`);
    const state = this.sys.readState();
    if (state.slot && state.slot !== slot) throw new Error(`This box is already slot ${state.slot}.`);
    this.ensureSetup();
    // Pages loaded from the box this one replaces ask for that release's build files. Nice to
    // have, not essential: releases expire from storage after 60 days, and a quiet two months
    // mustn't block the next deploy (those pages just reload into the new build).
    if (previous && previous !== this.release) {
      try {
        this.sys.sh('/usr/local/bin/games-drawer-deploy', [previous, 'fetch']);
        shareAssets(this.releaseDir, path.join(RELEASES, previous));
      } catch (err) {
        this.sys.log(`Couldn't fetch the running release ${previous.slice(0, 7)} to share its build files (${err instanceof Error ? err.message : err}); carrying on without them.`);
      }
    }
    this.sys.writeFile(`${ETC}/slot-${slot}.env`, slotEnv(slot, this.release, this.releaseDir));
    this.sys.sh('systemctl', ['restart', this.unit(slot)]);
    for (let i = 0; i < 60; i++) {
      const h = await this.sys.health();
      if (h?.ok && h.release === this.release) {
        this.sys.sh('systemctl', ['enable', this.unit(slot)]);
        this.sys.writeState({ slot, release: this.release, retiring: false });
        if (!state.slot) this.writeRoutes(soloMap(slot, this.sys.privateIp()), slot);
        this.sys.log(`Slot ${slot} is up with ${this.release.slice(0, 7)}.`);
        return;
      }
      await this.sys.sleep(1000);
    }
    this.sys.sh('systemctl', ['stop', this.unit(slot)]);
    throw new Error(`Slot ${slot} didn't come up with release ${this.release.slice(0, 7)} within a minute.`);
  }

  /** Reroute this box from the fleet map. */
  route(map: FleetMap) {
    const slot = this.mySlot();
    if (!map.boxes[slot]) throw new Error(`The fleet map doesn't include this box (slot ${slot}).`);
    this.writeRoutes(map, slot);
    this.sys.log(`Box ${slot}: new tables → ${map.newTables.map(([s, w]) => `${s} ${w}%`).join(', ')}; staging → ${map.staging ?? 'none'}.`);
  }

  /** This release (just fetched) and the one this box runs swap build files. */
  share(running: string) {
    shareAssets(this.releaseDir, path.join(RELEASES, running));
    this.sys.log(`Shared build files between ${this.release.slice(0, 7)} and ${running.slice(0, 7)}.`);
  }

  async check(): Promise<boolean> {
    const slot = this.mySlot();
    let running = false;
    try {
      running = this.sys.sh('systemctl', ['is-active', this.unit(slot)]).trim() === 'active';
    } catch {
      /* is-active exits non-zero when the unit isn't running */
    }
    const restarts = Number(/NRestarts=(\d+)/.exec(this.sys.sh('systemctl', ['show', '-p', 'NRestarts', this.unit(slot)]))?.[1] ?? 0);
    // No answer is a problem, not "nothing wrong": a server that has frozen answers nothing, and
    // systemd still calls it active. Asked three times, a second apart, because a box that has
    // just booted can be slow for a moment.
    let answer = await this.sys.stats();
    for (let again = 0; again < 2 && !answer; again++) {
      await this.sys.sleep(1000);
      answer = await this.sys.stats();
    }
    const s = answer ?? {};
    const stats: ServerStats = { running, restarts, handlerErrors: Number(s.handlerErrors ?? 0), roomErrors: Number(s.roomErrors ?? 0) };
    const problems = serverProblems(stats);
    if (running && !answer) problems.push("the game server is running but didn't answer");
    this.sys.log(`Box ${slot}: ${s.players ?? 0} players in ${s.roomCount ?? 0} rooms. ${problems.length ? `Problems: ${problems.join('; ')}.` : 'Healthy.'}`);
    return problems.length === 0;
  }

  /**
   * Finish the games here, then shut down. The server gets SIGUSR2 (it exits once its games
   * end, or after DRAIN_MAX_MS); a background job powers the box off once it has, and not
   * before `graceMinutes` (until then, players still reaching this box for the front door's
   * old address are passed to the new one).
   */
  retire(graceMinutes: number) {
    const slot = this.mySlot();
    const state = this.sys.readState();
    if (state.retiring) {
      this.sys.log(`Box ${slot} is already finishing its games.`);
      return;
    }
    this.sys.sh('systemctl', ['disable', this.unit(slot)]);
    this.sys.sh('systemctl', ['kill', '--signal=SIGUSR2', '--kill-whom=main', this.unit(slot)]);
    const notBefore = this.sys.now() + graceMinutes * 60_000;
    const self = path.join(this.releaseDir, 'deploy', 'rollout.mjs');
    this.sys.sh('systemd-run', ['--unit=games-drawer-retire', '--description=Games Drawer: shut down once the games are done', '/usr/local/bin/node', self, this.release, 'finish', String(notBefore)]);
    this.sys.writeState({ ...state, retiring: true });
    this.sys.log(`Box ${slot} is finishing its games; it shuts down once they're done (not before ${graceMinutes} minutes).`);
  }

  /** The background half of retire: wait for the server to exit and the grace time to pass, then power off. */
  async finish(notBefore: number) {
    const slot = this.mySlot();
    for (;;) {
      let active = true;
      try {
        active = this.sys.sh('systemctl', ['is-active', this.unit(slot)]).trim() === 'active';
      } catch {
        active = false;
      }
      if (!active && this.sys.now() >= notBefore) break;
      await this.sys.sleep(RETIRE_POLL_MS);
    }
    this.sys.log(`Box ${slot}'s games are done. Shutting down.`);
    this.sys.sh('systemctl', ['poweroff']);
  }

  async status() {
    const state = this.sys.readState();
    const h = await this.sys.health();
    this.sys.log(JSON.stringify(state));
    this.sys.log(h ? `Running ${h.release.slice(0, 7)} as slot ${h.slot}${h.draining ? ' (finishing its games)' : ''}.` : 'The game server is not running.');
  }
}

async function main() {
  const [release, cmd, arg, arg2] = process.argv.slice(2);
  const releaseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = new Rollout(realSystem, release, releaseDir);
  switch (cmd) {
    case 'fetch':
      return; // games-drawer-deploy already fetched the release
    case 'start':
      return r.start(arg as Slot, arg2 && arg2 !== 'none' ? arg2 : undefined);
    case 'route':
      return r.route(decodeMap(arg));
    case 'share':
      return r.share(arg);
    case 'check':
      if (!(await r.check())) process.exitCode = 1;
      return;
    case 'retire':
      return r.retire(Number(arg ?? 15));
    case 'finish':
      return r.finish(Number(arg));
    case 'status':
      return r.status();
    default:
      console.error('usage: rollout <release> start <slot> [previous]|route <map>|share <running>|check|retire [minutes]|status');
      process.exitCode = 2;
  }
}

// Run only when executed directly (tests import this file).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  });
}
