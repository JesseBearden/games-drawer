/**
 * The rollout tool: runs on the game server, as root, from inside a release bundle
 * (release/deploy/rollout.mjs). games-drawer-deploy calls it:
 *
 *   rollout <release> staging            put this release on staging.DOMAIN
 *   rollout <release> canary [percent]   start it in the free slot and send it that share of new rooms
 *   rollout <release> check              is the canary healthy? (exit 1 if not)
 *   rollout <release> promote            send all new rooms to the canary; the old copy drains
 *   rollout <release> rollback           send everything back to the old copy and stop the canary
 *   rollout <release> status             print what's running where
 *
 * Two copies of the game server live in slots a and b (ports 8801/8802); staging is a third
 * (8803). Room codes say which slot holds a room (slotOfCode), so reconnects and invite links
 * reach the right copy. A deploy never cuts a game off: the old copy gets SIGUSR2, finishes
 * the games it has, then exits by itself.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Slot = 'a' | 'b';
export type Unit = Slot | 'staging';

export const PORTS: Record<Unit, number> = { a: 8801, b: 8802, staging: 8803 };
export const ETC = '/etc/games-drawer';
export const STATE_FILE = `${ETC}/state.json`;
export const UPSTREAMS_FILE = '/etc/caddy/games-drawer-upstreams.caddy';

export interface State {
  /** The slot taking new rooms (all of them, apart from a canary's share). */
  active: Slot | null;
  /** A new version on trial in the other slot. */
  canary: Slot | null;
  /** The release in each slot. */
  releases: Partial<Record<Unit, string>>;
}

export const EMPTY_STATE: State = { active: null, canary: null, releases: {} };

export function otherSlot(s: Slot): Slot {
  return s === 'a' ? 'b' : 'a';
}

/** The slot a new release goes into: whichever one isn't taking new rooms. */
export function canarySlot(state: State): Slot {
  return state.active ? otherSlot(state.active) : 'a';
}

/** The Caddy snippet that decides where new rooms (and page loads) go. */
export function upstreams(state: State, canaryPercent: number): string {
  const { active, canary } = state;
  if (active && canary && canaryPercent < 100) {
    const pct = Math.max(1, Math.min(99, Math.round(canaryPercent)));
    return [
      `# ${100 - pct}% to slot ${active} (${state.releases[active]?.slice(0, 7)}), ${pct}% to the canary in slot ${canary} (${state.releases[canary]?.slice(0, 7)})`,
      `reverse_proxy 127.0.0.1:${PORTS[active]} 127.0.0.1:${PORTS[canary]} {`,
      `\tlb_policy weighted_round_robin ${100 - pct} ${pct}`,
      '}',
      '',
    ].join('\n');
  }
  const only = canary && (!active || canaryPercent >= 100) ? canary : active;
  if (!only) return 'respond "Starting up. Try again in a minute." 503\n';
  return `# Everything to slot ${only} (${state.releases[only]?.slice(0, 7)})\nreverse_proxy 127.0.0.1:${PORTS[only]}\n`;
}

/** The env file for one copy of the server (see games-drawer@.service). */
export function slotEnv(unit: Unit, release: string, releaseDir: string): string {
  const lines = [
    `GAME_PORT=${PORTS[unit]}`,
    unit === 'staging' ? '' : `SLOT=${unit}`,
    `RELEASE=${release}`,
    `RELEASE_DIR=${releaseDir}`,
    `LOG_DIR=/var/log/games-drawer/${unit}`,
    // The admin page adds up both production copies' logs (staging keeps to its own).
    `ADMIN_LOG_DIRS=${unit === 'staging' ? '/var/log/games-drawer/staging' : '/var/log/games-drawer/a,/var/log/games-drawer/b'}`,
  ];
  return lines.filter(Boolean).join('\n') + '\n';
}

export interface Health {
  ok: boolean;
  release: string;
  slot: string | null;
  draining: boolean;
}

export interface CanaryStats {
  handlerErrors: number;
  roomErrors: number;
  restarts: number;
  running: boolean;
}

/** What makes a canary fail its check. Any crash, restart or error counts: real ones are rare. */
export function canaryProblems(s: CanaryStats): string[] {
  const problems: string[] = [];
  if (!s.running) problems.push('the canary is not running');
  if (s.restarts > 0) problems.push(`it restarted ${s.restarts} time(s)`);
  if (s.roomErrors > 0) problems.push(`${s.roomErrors} room(s) crashed`);
  if (s.handlerErrors > 0) problems.push(`${s.handlerErrors} message handler error(s)`);
  return problems;
}

/** Copy build assets each release lacks from the other, so a page from either copy can load. */
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

// ---------------------------------------------------------------- side effects

/** Everything that touches the machine, so tests can swap it out. */
export interface System {
  readState(): State;
  writeState(s: State): void;
  writeFile(file: string, text: string): void;
  sh(cmd: string, args: string[]): string;
  health(unit: Unit): Promise<Health | null>;
  stats(unit: Unit): Promise<Record<string, unknown> | null>;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
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
  async health(unit) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORTS[unit]}/healthz`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? ((await res.json()) as Health) : null;
    } catch {
      return null;
    }
  },
  async stats(unit) {
    try {
      const token = /^STATS_TOKEN=(.*)$/m.exec(fs.readFileSync(`${ETC}/secrets.env`, 'utf8'))?.[1] ?? '';
      const res = await fetch(`http://127.0.0.1:${PORTS[unit]}/stats?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (msg) => console.log(msg),
};

export class Rollout {
  constructor(
    private sys: System,
    private release: string,
    private releaseDir: string,
  ) {}

  private unitName(u: Unit) {
    return `games-drawer@${u}`;
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

  private async start(unit: Unit) {
    this.sys.writeFile(`${ETC}/slot-${unit}.env`, slotEnv(unit, this.release, this.releaseDir));
    this.sys.sh('install', ['-d', '-m', '750', '-o', 'games', '-g', 'games', `/var/log/games-drawer/${unit}`]);
    this.sys.sh('systemctl', ['restart', this.unitName(unit)]);
    for (let i = 0; i < 60; i++) {
      const h = await this.sys.health(unit);
      if (h?.ok && h.release === this.release) {
        this.sys.log(`Slot ${unit} is up with ${this.release.slice(0, 7)}.`);
        return;
      }
      await this.sys.sleep(1000);
    }
    this.sys.sh('systemctl', ['stop', this.unitName(unit)]);
    throw new Error(`Slot ${unit} didn't come up with release ${this.release.slice(0, 7)} within a minute.`);
  }

  private routeTo(state: State, canaryPercent: number) {
    this.sys.writeFile(UPSTREAMS_FILE, upstreams(state, canaryPercent));
    this.sys.sh('systemctl', ['reload', 'caddy']);
  }

  async staging() {
    this.ensureSetup();
    await this.start('staging');
    this.sys.sh('systemctl', ['enable', this.unitName('staging')]);
    const state = this.sys.readState();
    state.releases.staging = this.release;
    this.sys.writeState(state);
  }

  async canary(percent: number) {
    this.ensureSetup();
    const state = this.sys.readState();
    const slot = canarySlot(state);
    // The slot may still hold an older copy finishing its games from two deploys ago.
    const old = state.releases[slot];
    if (old && old !== this.release) this.sys.log(`Replacing ${old.slice(0, 7)} in slot ${slot}; any games still on it end now.`);
    if (state.active) {
      const activeDir = path.join(path.dirname(this.releaseDir), state.releases[state.active] ?? '');
      shareAssets(this.releaseDir, activeDir);
    }
    await this.start(slot);
    state.canary = slot;
    state.releases[slot] = this.release;
    this.routeTo(state, state.active ? percent : 100);
    this.sys.writeState(state);
    this.sys.log(`CANARY_SLOT=${slot}`);
    this.sys.log(state.active ? `Slot ${slot} gets ${percent}% of new rooms.` : `First deploy: slot ${slot} gets everything.`);
  }

  async check(): Promise<boolean> {
    const state = this.sys.readState();
    const slot = state.canary;
    if (!slot) {
      this.sys.log('No canary running.');
      return false;
    }
    let running = false;
    try {
      running = this.sys.sh('systemctl', ['is-active', this.unitName(slot)]).trim() === 'active';
    } catch {
      /* is-active exits non-zero when the unit isn't running */
    }
    const restarts = Number(/NRestarts=(\d+)/.exec(this.sys.sh('systemctl', ['show', '-p', 'NRestarts', this.unitName(slot)]))?.[1] ?? 0);
    const s = (await this.sys.stats(slot)) ?? {};
    const stats: CanaryStats = { running, restarts, handlerErrors: Number(s.handlerErrors ?? 0), roomErrors: Number(s.roomErrors ?? 0) };
    const problems = canaryProblems(stats);
    this.sys.log(`Canary in slot ${slot}: ${s.players ?? 0} players in ${s.roomCount ?? 0} rooms. ${problems.length ? `Problems: ${problems.join('; ')}.` : 'Healthy.'}`);
    return problems.length === 0;
  }

  async promote() {
    const state = this.sys.readState();
    const slot = state.canary;
    if (!slot) throw new Error('No canary to promote.');
    const old = state.active;
    state.active = slot;
    state.canary = null;
    this.routeTo(state, 100);
    this.sys.sh('systemctl', ['enable', this.unitName(slot)]);
    if (old) {
      this.sys.sh('systemctl', ['disable', this.unitName(old)]);
      // Finish the games in progress, then exit (see SIGUSR2 in packages/server/src/main.ts).
      this.sys.sh('systemctl', ['kill', '--signal=SIGUSR2', '--kill-whom=main', this.unitName(old)]);
    }
    this.sys.writeState(state);
    this.sys.log(`Slot ${slot} (${state.releases[slot]?.slice(0, 7)}) now takes all new rooms.${old ? ` Slot ${old} is finishing its games.` : ''}`);
  }

  async rollback() {
    const state = this.sys.readState();
    const slot = state.canary;
    if (!slot) {
      this.sys.log('No canary to roll back.');
      return;
    }
    state.canary = null;
    this.routeTo(state, 100);
    this.sys.sh('systemctl', ['stop', this.unitName(slot)]);
    delete state.releases[slot];
    this.sys.writeState(state);
    this.sys.log(`Rolled back: slot ${slot} stopped${state.active ? `, slot ${state.active} takes everything again` : ''}.`);
  }

  async status() {
    const state = this.sys.readState();
    this.sys.log(JSON.stringify(state, null, 2));
    for (const u of ['a', 'b', 'staging'] as Unit[]) {
      const h = await this.sys.health(u);
      this.sys.log(`${u}: ${h ? `${h.release.slice(0, 7)}${h.draining ? ' (finishing its games)' : ''}` : 'not running'}`);
    }
  }
}

async function main() {
  const [release, cmd, arg] = process.argv.slice(2);
  const releaseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = new Rollout(realSystem, release, releaseDir);
  switch (cmd) {
    case 'staging':
      return r.staging();
    case 'canary':
      return r.canary(Number(arg ?? 10));
    case 'check':
      if (!(await r.check())) process.exitCode = 1;
      return;
    case 'promote':
      return r.promote();
    case 'rollback':
      return r.rollback();
    case 'status':
      return r.status();
    default:
      console.error('usage: rollout <release> staging|canary [percent]|check|promote|rollback|status');
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
