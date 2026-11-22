import {
  advanceShell,
  collapseOptionsFor,
  generateTerrain,
  perks,
  PHASES,
  sameDyn,
  STILL_STATE_TICKS,
  Terrain,
  type GameConfig,
  type GameEvent,
  type MovingPoint,
  type Point,
  type TankServerMessage,
  type TankInfo,
  type TankPhase,
} from '@tank/shared';
import type { PlayOptions, SoundName } from './audio';
import { colorCss, escapeHtml } from './html';
import { TerrainRenderer } from './terrainRenderer';

/** The tank game's start-up message: config plus a full snapshot. */
export type TankInit = Extract<TankServerMessage, { t: 'init' }>;

/**
 * How many ticks behind the newest state to draw, to glide smoothly between them: two gaps
 * between states and one over. The server says the gap, so it can send fewer without a stutter.
 */
const interpDelay = (stateEvery: number) => 2 * stateEvery + 1;
/**
 * Events this far behind the moment being drawn were missed (the tab was hidden, the connection
 * stalled): they change the battlefield, but don't explode, play or pop up all at once.
 */
const MISSED_TICKS = 90;
/** The nuke effect starts this long before the new terrain arrives, and lasts this long. */
const NUKE_LEAD_TICKS = 75;
export const NUKE_DURATION_MS = 2800;

interface Sample {
  tick: number;
  x: number;
  y: number;
  angle: number;
  phase: TankPhase;
  tilt: number;
}

export interface ClientTank {
  info: TankInfo;
  samples: Sample[];
  x: number;
  y: number;
  angle: number;
  phase: TankPhase;
  tilt: number;
}

export interface ClientHeli {
  id: number;
  tankId: number;
  dir: number;
  carrying: boolean;
  samples: { tick: number; x: number; y: number }[];
  lastSeen: number;
  x: number;
  y: number;
}

export interface ClientShell {
  id: number;
  owner: number;
  s: MovingPoint;
  prev: Point;
  simTick: number;
  trail: Point[];
}

export type Effect =
  | { kind: 'explosion'; x: number; y: number; r: number; t0: number; dur: number; big?: boolean }
  | { kind: 'shield'; tank: number; t0: number; dur: number }
  | { kind: 'debris'; parts: { x: number; y: number; vx: number; vy: number; c: string; s: number }[]; t0: number; dur: number }
  | { kind: 'smoke'; x: number; y: number; t0: number; dur: number; drift: number }
  | { kind: 'float'; x: number; y: number; text: string; color: string; t0: number; dur: number }
  | { kind: 'heliWreck'; x: number; y: number; vx: number; vy: number; dir: number; t0: number; dur: number }
  | { kind: 'flash'; t0: number; dur: number }
  /** Full-screen nuke: blasts across the screen (positions as 0..1 of the view), shake, white-out. */
  | { kind: 'nuke'; t0: number; dur: number; blasts: { x: number; y: number; delay: number; size: number }[] }
  | { kind: 'muzzle'; x: number; y: number; angle: number; t0: number; dur: number };

export interface UiHooks {
  feed(html: string): void;
  toast(text: string): void;
  banner(html: string | null): void;
  resync(reason: string): void;
  infoChanged(): void;
  /** Play a sound, positioned at a world point (for stereo and distance) or centred. */
  sound(name: SoundName, at?: Point, opts?: PlayOptions): void;
}

export class GameState {
  cfg: GameConfig;
  myTankId: number;
  terrain: Terrain;
  terrainRev: number;
  terrainView: TerrainRenderer;
  wind: number;
  tanks = new Map<number, ClientTank>();
  helis = new Map<number, ClientHeli>();
  shells = new Map<number, ClientShell>();
  effects: Effect[] = [];
  blastWarnings: { tank: number; x: number; y: number; at: number; from: number }[] = [];
  match: TankInit['snapshot']['match'];
  /** Latest server tick seen. */
  serverTick: number;
  renderTick: number;
  private offset: number;
  private tickMs: number;
  private delay: number;
  private queue: GameEvent[] = [];
  /** While catching up on missed events: the ground they changed, painted once at the end. */
  private groundToPaint: { x0: number; x1: number; all: boolean } | null = null;
  private snapshotTick: number;
  latencyMs = 0;
  private nukeStarted = false;
  private lastDyn: TankInit['snapshot']['dyn'];
  /**
   * The last state was a repeat of the one before, with nothing in the air. The server then sends
   * one only every STILL_STATE_TICKS, so time may run that far past the newest one.
   */
  private still = false;
  /** Tanks whose players are talking in voice chat right now (set by the voice module). */
  speaking = new Set<number>();
  /** Touch-screen player (set by the app); changes control hints. */
  touch = false;

  constructor(w: TankInit, private ui: UiHooks) {
    this.cfg = w.config;
    this.myTankId = w.tankId;
    this.tickMs = 1000 / this.cfg.tickRate;
    const snap = w.snapshot;
    this.snapshotTick = snap.tick;
    this.serverTick = snap.tick;
    this.offset = snap.tick - performance.now() / this.tickMs;
    this.delay = interpDelay(this.cfg.stateEvery);
    this.renderTick = snap.tick - this.delay;
    this.terrain = Terrain.fromData(snap.terrain, this.cfg.bedrock);
    this.terrainRev = snap.terrainRev;
    this.terrainView = new TerrainRenderer(this.terrain);
    this.wind = snap.wind;
    this.match = snap.match;
    for (const info of snap.tanks) this.tanks.set(info.id, newTank(info));
    this.lastDyn = snap.dyn;
    this.applyDyn(snap.tick, snap.dyn);
    this.applyHelis(snap.tick, snap.helis);
    for (const s of snap.shells) {
      this.shells.set(s.id, { id: s.id, owner: s.owner, s: { x: s.x, y: s.y, vx: s.vx, vy: s.vy }, prev: { x: s.x, y: s.y }, simTick: snap.tick, trail: [] });
    }
  }

  get me(): ClientTank | undefined {
    return this.tanks.get(this.myTankId);
  }

  // ------------------------------------------------------------------ messages

  onPong(at: number) {
    this.latencyMs = performance.now() - at;
  }

  onMessage(msg: TankServerMessage) {
    switch (msg.t) {
      case 'state':
        this.observeTick(msg.tick);
        this.still = !msg.helis.length && sameDyn(msg.dyn, this.lastDyn);
        this.lastDyn = msg.dyn;
        this.applyDyn(msg.tick, msg.dyn);
        this.applyHelis(msg.tick, msg.helis);
        return;
      case 'events':
        for (const e of msg.events) if (e.tick > this.snapshotTick) this.queue.push(e);
        return;
      case 'info':
        for (const info of msg.tanks) {
          const t = this.tanks.get(info.id);
          if (t) t.info = info;
          else this.tanks.set(info.id, newTank(info));
        }
        this.ui.infoChanged();
        return;
      case 'removed':
        for (const id of msg.tanks) this.tanks.delete(id);
        this.ui.infoChanged();
        return;
      default:
        return;
    }
  }

  private observeTick(tick: number) {
    if (tick > this.serverTick) this.serverTick = tick;
    const sample = tick - performance.now() / this.tickMs;
    const diff = sample - this.offset;
    if (Math.abs(diff) > 30) this.offset = sample;
    else if (diff > 0) this.offset += diff * 0.25;
    else this.offset += diff * 0.02;
  }

  private applyDyn(tick: number, dyn: TankInit['snapshot']['dyn']) {
    for (const [id, x, y, angle, phase, tilt] of dyn) {
      const t = this.tanks.get(id);
      if (!t) continue;
      // States left out were repeats: it stood where it was until a state ago, not sliding here all along.
      const last = t.samples.at(-1);
      const before = tick - this.cfg.stateEvery;
      if (last && before > last.tick) t.samples.push({ ...last, tick: before });
      t.samples.push({ tick, x, y, angle, phase: PHASES[phase], tilt });
      if (t.samples.length > 40) t.samples.splice(0, t.samples.length - 40);
    }
  }

  private applyHelis(tick: number, helis: TankInit['snapshot']['helis']) {
    for (const [id, tankId, x, y, dir, carrying] of helis) {
      let h = this.helis.get(id);
      if (!h) {
        h = { id, tankId, dir, carrying: !!carrying, samples: [], lastSeen: tick, x, y };
        this.helis.set(id, h);
      }
      h.samples.push({ tick, x, y });
      if (h.samples.length > 40) h.samples.shift();
      h.lastSeen = tick;
      h.dir = dir;
      // Carrying flips to false at the drop tick; apply it when rendering reaches that state.
      if (!carrying) h.carrying = false;
    }
  }

  // ------------------------------------------------------------------ per-frame update

  update(now: number) {
    const target = now / this.tickMs + this.offset - this.delay;
    // Ease render time toward its target so clock corrections never jump.
    const step = target - this.renderTick;
    this.renderTick += Math.abs(step) > 20 ? step : step * 0.2 + 0;
    const quiet = this.still && !this.shells.size && !this.queue.length && this.match.state !== 'won';
    const newest = this.serverTick + (quiet ? STILL_STATE_TICKS : 0);
    if (this.renderTick > newest) this.renderTick = newest;
    const rt = this.renderTick;

    this.queue.sort((a, b) => a.tick - b.tick);
    if (this.queue.length && this.queue[0].tick < rt - MISSED_TICKS) this.catchUp(rt - MISSED_TICKS, now);
    while (this.queue.length && this.queue[0].tick <= rt) this.applyEvent(this.queue.shift()!, now);

    for (const sh of this.shells.values()) {
      while (sh.simTick + 1 <= rt) {
        sh.prev = { x: sh.s.x, y: sh.s.y };
        advanceShell(this.cfg, sh.s, this.wind);
        sh.simTick++;
        sh.trail.push({ x: sh.s.x, y: sh.s.y });
        if (sh.trail.length > 24) sh.trail.shift();
        // Safety: the explode event normally removes the shell first.
        if (sh.simTick - rt > 600 || sh.s.y > this.cfg.worldHeight + 200) this.shells.delete(sh.id);
      }
    }

    for (const t of this.tanks.values()) interpolateTank(t, rt);
    for (const h of this.helis.values()) {
      interpolateHeli(h, rt);
      if (rt > h.lastSeen + 2) this.helis.delete(h.id);
    }

    // The screen starts exploding a moment before the server swaps in the new battlefield.
    if (this.match.state === 'won' && !this.nukeStarted && rt >= this.match.nukeAt - NUKE_LEAD_TICKS) this.startNuke(now);

    this.effects = this.effects.filter((e) => now - e.t0 < e.dur);
    this.blastWarnings = this.blastWarnings.filter((b) => b.at > rt);
  }

  shellRenderPos(sh: ClientShell): Point {
    const f = Math.max(0, Math.min(1, this.renderTick - (sh.simTick - 1)));
    return { x: sh.prev.x + (sh.s.x - sh.prev.x) * f, y: sh.prev.y + (sh.s.y - sh.prev.y) * f };
  }

  isProtected(t: ClientTank) {
    return t.phase === 'carried' || t.phase === 'chute' || t.info.protectedUntil > this.renderTick;
  }

  nameOf(id: number | null) {
    if (id === null) return '';
    const t = this.tanks.get(id);
    return t ? t.info.name : 'someone';
  }

  colorOf(id: number) {
    return this.tanks.get(id)?.info.color ?? 0;
  }

  // ------------------------------------------------------------------ events

  /** Apply what was missed before `until`: the battlefield as it now is, without the show. */
  private catchUp(until: number, now: number) {
    const { ui, effects } = this;
    this.ui = { ...ui, sound() {}, feed() {}, toast() {} };
    this.effects = [];
    this.groundToPaint = { x0: Infinity, x1: -Infinity, all: false };
    while (this.queue.length && this.queue[0].tick < until) this.applyEvent(this.queue.shift()!, now);
    const ground = this.groundToPaint;
    this.groundToPaint = null;
    this.ui = ui;
    this.effects = effects;
    if (ground.all) this.terrainView.reset(this.terrain);
    else if (ground.x0 <= ground.x1) this.terrainView.redraw(ground.x0, ground.x1);
  }

  private carve(x: number, y: number, r: number, rev: number) {
    if (rev <= this.terrainRev) return;
    if (rev !== this.terrainRev + 1) {
      this.ui.resync(`terrain rev ${this.terrainRev} -> ${rev}`);
      return;
    }
    const dirty = this.terrain.carve(x, y, r, collapseOptionsFor(this.cfg));
    this.terrainRev = rev;
    if (!dirty) return;
    const later = this.groundToPaint;
    if (!later) return this.terrainView.redraw(dirty.x0, dirty.x1);
    later.x0 = Math.min(later.x0, dirty.x0);
    later.x1 = Math.max(later.x1, dirty.x1);
  }

  private applyEvent(e: GameEvent, now: number) {
    const me = this.myTankId;
    switch (e.type) {
      case 'fire': {
        for (const l of e.shells) {
          this.shells.set(l.id, { id: l.id, owner: e.tank, s: { x: l.x, y: l.y, vx: l.vx, vy: l.vy }, prev: { x: l.x, y: l.y }, simTick: e.tick, trail: [] });
        }
        const l = e.shells[Math.floor(e.shells.length / 2)];
        this.effects.push({ kind: 'muzzle', x: l.x, y: l.y, angle: Math.atan2(l.vy, l.vx), t0: now, dur: 160 });
        this.ui.sound('fire', l);
        return;
      }
      case 'explode': {
        this.shells.delete(e.shell);
        this.carve(e.x, e.y, e.r, e.rev);
        this.effects.push({ kind: 'explosion', x: e.x, y: e.y, r: e.r, t0: now, dur: 420 });
        this.effects.push({ kind: 'smoke', x: e.x, y: e.y - 6, t0: now, dur: 1400, drift: this.wind * 0.6 });
        this.spawnDebris(e.x, e.y, 10, now);
        if (e.shielded && e.hitTank !== null) {
          this.effects.push({ kind: 'shield', tank: e.hitTank, t0: now, dur: 600 });
          this.ui.sound('shield', e);
        }
        // A direct hit also gets the bigger death sound from the death event.
        this.ui.sound('explosion', e, { size: Math.max(0.35, e.r / 45) });
        return;
      }
      case 'shellGone':
        this.shells.delete(e.shell);
        return;
      case 'death': {
        this.effects.push({ kind: 'explosion', x: e.x, y: e.y - 8, r: 34, t0: now, dur: 650, big: true });
        this.effects.push({ kind: 'smoke', x: e.x, y: e.y - 10, t0: now, dur: 2600, drift: this.wind });
        this.spawnDebris(e.x, e.y - 8, 16, now, this.tanks.get(e.tank)?.info.color);
        this.ui.sound('bigExplosion', e);
        if (e.tank === me) this.ui.sound('myDeath', undefined, { delay: 0.35 });
        const victim = this.nameSpan(e.tank);
        const killer = e.killer !== null ? this.nameSpan(e.killer) : '';
        // In words (no emoji: DESIGN.md).
        const how = { direct: 'hit', fall: 'knocked off', blast: 'blew up', environment: 'got' }[e.cause];
        if (e.killer !== null) this.ui.feed(`${killer} ${how} ${victim}`);
        else this.ui.feed(`${victim} ${e.fallDistance ? 'took a long fall' : 'blew up'}`);
        if (e.tank === me) {
          if (e.reset) this.ui.toast('Out of lives. Run reset to level 0.');
          else if (e.killer !== null) this.ui.toast(`${this.nameOf(e.killer)} got you!`);
          else this.ui.toast(e.fallDistance ? 'That was a long way down.' : 'Oops.');
        }
        return;
      }
      case 'kill': {
        const k = this.tanks.get(e.killer);
        if (k) {
          const label = e.levelsAwarded > 1 ? `+${e.levelsAwarded} LV` : '+1 LV';
          this.effects.push({ kind: 'float', x: k.x, y: k.y - 46, text: label, color: '#ffd23a', t0: now, dur: 1400 });
        }
        if (e.killer === me && e.levelsAwarded > 1) this.ui.toast(`Bounty! +${e.levelsAwarded} levels`);
        if (e.killer === me) this.ui.sound(e.levelsAwarded > 1 ? 'bounty' : 'levelUp', undefined, { delay: 0.15 });
        return;
      }
      case 'heliDown': {
        this.helis.delete(e.heli);
        this.effects.push({ kind: 'explosion', x: e.x, y: e.y, r: 36, t0: now, dur: 600, big: true });
        this.effects.push({ kind: 'heliWreck', x: e.x, y: e.y, vx: 60, vy: -80, dir: 1, t0: now, dur: 2200 });
        this.ui.sound('heliDown', e);
        this.ui.feed(`${this.nameSpan(e.by)} shot down ${this.nameSpan(e.tank)}'s helicopter`);
        if (e.tank === me) this.ui.toast('Your helicopter was shot down!');
        if (e.by === me) this.ui.toast('Helicopter down! +1 LV');
        return;
      }
      case 'drop': {
        const h = [...this.helis.values()].find((x) => x.tankId === e.tank);
        if (h) h.carrying = false;
        this.ui.sound('drop', e, { volume: e.tank === me ? 1 : 0.5 });
        this.ui.sound('chute', e, { delay: 0.3, volume: e.tank === me ? 1 : 0.5 });
        return;
      }
      case 'settled': {
        const t = this.tanks.get(e.tank);
        if (t) this.ui.sound('land', t, { volume: e.tank === me ? 1 : 0.5 });
        return;
      }
      case 'milestone': {
        if (e.tank === me && e.level < this.cfg.winLevel) {
          const perk = perks(this.cfg).find((p) => p.level === e.level);
          if (perk) {
            // Movement controls differ: keys on desktop, on-screen arrows on touch screens.
            const hint = perk.key === 'move' ? (this.touch ? ' (◀ ▶ buttons)' : ' (A / D)') : '';
            this.ui.toast(`Level ${e.level}: ${perk.label}${hint}`);
          }
          this.ui.sound('perk', undefined, { delay: 0.35 });
        }
        return;
      }
      case 'blastWarn':
        this.blastWarnings.push({ tank: e.tank, x: e.x, y: e.y, at: e.at, from: e.tick });
        this.ui.sound('blastWarn', e);
        return;
      case 'blast':
        this.carve(e.x, e.y, e.r, e.rev);
        this.effects.push({ kind: 'explosion', x: e.x, y: e.y, r: this.cfg.deathBlastRadius, t0: now, dur: 800, big: true });
        this.spawnDebris(e.x, e.y, 24, now);
        this.ui.sound('bigExplosion', e, { size: 1.5 });
        return;
      case 'win': {
        this.match = { state: 'won', winner: e.tank, nukeAt: e.nukeAt };
        this.ui.banner(`${escapeHtml(e.name)} wins!`);
        this.ui.sound('win');
        return;
      }
      case 'nuke': {
        this.match = { state: 'playing' };
        this.terrain = generateTerrain(this.cfg, e.seed);
        this.terrainRev = e.rev;
        if (this.groundToPaint) this.groundToPaint.all = true;
        else this.terrainView.reset(this.terrain);
        this.wind = e.wind;
        this.shells.clear();
        this.helis.clear();
        // Normally already running (it starts just before the nuke); covers late joiners.
        if (!this.effects.some((fx) => fx.kind === 'nuke')) this.startNuke(now);
        this.nukeStarted = false;
        this.ui.banner(null);
        this.ui.toast('New battlefield! Everyone back to level 0.');
        return;
      }
      case 'runReset':
      case 'runStart':
      case 'heliSpawn':
        return;
    }
  }

  private nameSpan(id: number) {
    const t = this.tanks.get(id);
    const css = t ? colorCss(t.info.color) : '#c9cfdf';
    // The name in ink, underlined in the tank's colour (coloured text is hard to read on paper).
    return `<span class="tank-name" style="--c:${css}">${escapeHtml(this.nameOf(id))}</span>`;
  }

  private startNuke(now: number) {
    this.nukeStarted = true;
    this.ui.sound('nuke');
    const blasts = [];
    for (let i = 0; i < 46; i++) {
      blasts.push({ x: Math.random(), y: Math.random() * 0.95, delay: Math.random() * 0.42, size: 0.12 + Math.random() * 0.22 });
    }
    this.effects.push({ kind: 'nuke', t0: now, dur: NUKE_DURATION_MS, blasts });
  }

  private spawnDebris(x: number, y: number, n: number, now: number, color?: number) {
    const parts = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * (0.1 + Math.random() * 0.8);
      const v = 120 + Math.random() * 220;
      parts.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        c: color !== undefined && i % 2 ? colorCss(color) : ['#bb926a', '#f2bd96', '#9c7a58', '#478653'][i % 4],
        s: 2 + Math.random() * 3,
      });
    }
    this.effects.push({ kind: 'debris', parts, t0: now, dur: 1100 });
  }
}

function newTank(info: TankInfo): ClientTank {
  return { info, samples: [], x: -100, y: -100, angle: 60, phase: 'dead', tilt: 0 };
}

function interpolateTank(t: ClientTank, rt: number) {
  const s = t.samples;
  if (!s.length) return;
  while (s.length > 2 && s[1].tick <= rt) s.shift();
  const a = s[0];
  const b = s[1];
  if (!b || rt <= a.tick) {
    set(t, a);
    return;
  }
  if (rt >= b.tick) {
    set(t, b);
    return;
  }
  // Snap instead of sliding across the map when a tank respawns or teleports.
  if (a.phase !== b.phase && (a.phase === 'dead' || b.phase === 'dead' || b.phase === 'carried')) {
    set(t, a);
    return;
  }
  const f = (rt - a.tick) / (b.tick - a.tick);
  t.x = a.x + (b.x - a.x) * f;
  t.y = a.y + (b.y - a.y) * f;
  t.angle = a.angle + (b.angle - a.angle) * f;
  t.tilt = a.tilt + (b.tilt - a.tilt) * f;
  t.phase = a.phase;
}

function set(t: ClientTank, s: Sample) {
  t.x = s.x;
  t.y = s.y;
  t.angle = s.angle;
  t.tilt = s.tilt;
  t.phase = s.phase;
}

function interpolateHeli(h: ClientHeli, rt: number) {
  const s = h.samples;
  if (!s.length) return;
  while (s.length > 2 && s[1].tick <= rt) s.shift();
  const a = s[0];
  const b = s[1];
  if (!b || rt <= a.tick) {
    h.x = a.x;
    h.y = a.y;
    return;
  }
  const f = Math.min(1, (rt - a.tick) / (b.tick - a.tick));
  h.x = a.x + (b.x - a.x) * f;
  h.y = a.y + (b.y - a.y) * f;
}
