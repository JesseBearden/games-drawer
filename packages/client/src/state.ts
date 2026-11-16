import {
  advanceShell,
  generateTerrain,
  PHASES,
  TANK_COLORS,
  Terrain,
  type ChatMessage,
  type GameConfig,
  type GameEvent,
  type MovingPoint,
  type Point,
  type ServerMessage,
  type TankInfo,
  type TankPhase,
} from '@tank/shared';
import { TerrainRenderer } from './terrainRenderer';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/** Render this many ticks behind the newest server state, to interpolate smoothly. */
const INTERP_DELAY = 7;

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
  | { kind: 'muzzle'; x: number; y: number; angle: number; t0: number; dur: number };

export interface UiHooks {
  feed(html: string): void;
  toast(text: string): void;
  banner(html: string | null): void;
  chat(msg: ChatMessage): void;
  resync(reason: string): void;
  infoChanged(): void;
}

export class GameState {
  cfg: GameConfig;
  myTankId: number;
  room: Welcome['room'];
  terrain: Terrain;
  terrainRev: number;
  terrainView: TerrainRenderer;
  wind: number;
  tanks = new Map<number, ClientTank>();
  helis = new Map<number, ClientHeli>();
  shells = new Map<number, ClientShell>();
  effects: Effect[] = [];
  blastWarnings: { tank: number; x: number; y: number; at: number; from: number }[] = [];
  match: Welcome['snapshot']['match'];
  /** Latest server tick seen. */
  serverTick: number;
  renderTick: number;
  private offset: number;
  private tickMs: number;
  private queue: GameEvent[] = [];
  private snapshotTick: number;
  latencyMs = 0;

  constructor(w: Welcome, private ui: UiHooks) {
    this.cfg = w.config;
    this.myTankId = w.tankId;
    this.room = w.room;
    this.tickMs = 1000 / this.cfg.tickRate;
    const snap = w.snapshot;
    this.snapshotTick = snap.tick;
    this.serverTick = snap.tick;
    this.offset = snap.tick - performance.now() / this.tickMs;
    this.renderTick = snap.tick - INTERP_DELAY;
    this.terrain = Terrain.fromData(snap.terrain, this.cfg.bedrock);
    this.terrainRev = snap.terrainRev;
    this.terrainView = new TerrainRenderer(this.terrain);
    this.wind = snap.wind;
    this.match = snap.match;
    for (const info of snap.tanks) this.tanks.set(info.id, newTank(info));
    this.applyDyn(snap.tick, snap.dyn);
    this.applyHelis(snap.tick, snap.helis);
    for (const s of snap.shells) {
      this.shells.set(s.id, { id: s.id, owner: s.owner, s: { x: s.x, y: s.y, vx: s.vx, vy: s.vy }, prev: { x: s.x, y: s.y }, simTick: snap.tick, trail: [] });
    }
    for (const m of snap.chat) ui.chat(m);
  }

  get me(): ClientTank | undefined {
    return this.tanks.get(this.myTankId);
  }

  // ------------------------------------------------------------------ messages

  onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case 'state':
        this.observeTick(msg.tick);
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
      case 'chat':
        this.ui.chat(msg.msg);
        return;
      case 'pong':
        this.latencyMs = performance.now() - msg.at;
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

  private applyDyn(tick: number, dyn: Welcome['snapshot']['dyn']) {
    for (const [id, x, y, angle, phase, tilt] of dyn) {
      const t = this.tanks.get(id);
      if (!t) continue;
      t.samples.push({ tick, x, y, angle, phase: PHASES[phase], tilt });
      if (t.samples.length > 40) t.samples.splice(0, t.samples.length - 40);
    }
  }

  private applyHelis(tick: number, helis: Welcome['snapshot']['helis']) {
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
    const target = now / this.tickMs + this.offset - INTERP_DELAY;
    // Ease render time toward its target so clock corrections never jump.
    const step = target - this.renderTick;
    this.renderTick += Math.abs(step) > 20 ? step : step * 0.2 + 0;
    if (this.renderTick > this.serverTick) this.renderTick = this.serverTick;
    const rt = this.renderTick;

    this.queue.sort((a, b) => a.tick - b.tick);
    while (this.queue.length && this.queue[0].tick <= rt) this.applyEvent(this.queue.shift()!, now);

    for (const sh of this.shells.values()) {
      while (sh.simTick + 1 <= rt) {
        sh.prev = { x: sh.s.x, y: sh.s.y };
        advanceShell(this.cfg, sh.s, this.wind);
        sh.simTick++;
        sh.trail.push({ x: sh.s.x, y: sh.s.y });
        if (sh.trail.length > 14) sh.trail.shift();
        // Safety: the explode event normally removes the shell first.
        if (sh.simTick - rt > 600 || sh.s.y > this.cfg.worldHeight + 200) this.shells.delete(sh.id);
      }
    }

    for (const t of this.tanks.values()) interpolateTank(t, rt);
    for (const h of this.helis.values()) {
      interpolateHeli(h, rt);
      if (rt > h.lastSeen + 2) this.helis.delete(h.id);
    }

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

  private carve(x: number, y: number, r: number, rev: number) {
    if (rev <= this.terrainRev) return;
    if (rev !== this.terrainRev + 1) {
      this.ui.resync(`terrain rev ${this.terrainRev} -> ${rev}`);
      return;
    }
    const dirty = this.terrain.carve(x, y, r, {
      minSliverThickness: this.cfg.minSliverThickness,
      detachedDirtFalls: this.cfg.detachedDirtFalls,
    });
    this.terrainRev = rev;
    if (dirty) this.terrainView.redraw(dirty.x0, dirty.x1);
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
        return;
      }
      case 'explode': {
        this.shells.delete(e.shell);
        this.carve(e.x, e.y, e.r, e.rev);
        this.effects.push({ kind: 'explosion', x: e.x, y: e.y, r: e.r, t0: now, dur: 420 });
        this.effects.push({ kind: 'smoke', x: e.x, y: e.y - 6, t0: now, dur: 1400, drift: this.wind * 0.6 });
        this.spawnDebris(e.x, e.y, 10, now);
        if (e.shielded && e.hitTank !== null) this.effects.push({ kind: 'shield', tank: e.hitTank, t0: now, dur: 600 });
        return;
      }
      case 'shellGone':
        this.shells.delete(e.shell);
        return;
      case 'death': {
        this.effects.push({ kind: 'explosion', x: e.x, y: e.y - 8, r: 34, t0: now, dur: 650, big: true });
        this.effects.push({ kind: 'smoke', x: e.x, y: e.y - 10, t0: now, dur: 2600, drift: this.wind });
        this.spawnDebris(e.x, e.y - 8, 16, now, this.tanks.get(e.tank)?.info.color);
        const victim = this.nameSpan(e.tank);
        const killer = e.killer !== null ? this.nameSpan(e.killer) : '';
        const how = { direct: '💥', fall: '⬇️', blast: '☢️', environment: '' }[e.cause];
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
        if (e.heli && e.victim === null) {
          /* reported by heliDown */
        }
        return;
      }
      case 'heliDown': {
        this.helis.delete(e.heli);
        this.effects.push({ kind: 'explosion', x: e.x, y: e.y, r: 36, t0: now, dur: 600, big: true });
        this.effects.push({ kind: 'heliWreck', x: e.x, y: e.y, vx: 60, vy: -80, dir: 1, t0: now, dur: 2200 });
        this.ui.feed(`${this.nameSpan(e.by)} 🚁 shot down ${this.nameSpan(e.tank)}'s ride`);
        if (e.tank === me) this.ui.toast('Your helicopter was shot down!');
        if (e.by === me) this.ui.toast('Helicopter down! +1 LV');
        return;
      }
      case 'drop': {
        const h = [...this.helis.values()].find((x) => x.tankId === e.tank);
        if (h) h.carrying = false;
        return;
      }
      case 'settled':
        return;
      case 'milestone': {
        if (e.tank === me) {
          const text: Record<number, string> = {
            5: 'Level 5: shells fly 10% faster',
            10: 'Level 10: movement unlocked (A / D)',
            15: 'Level 15: every 10th shot is a spread',
            20: 'Level 20: your last shot is marked',
            25: 'Level 25: extra life!',
            30: 'Level 30: you explode when destroyed',
            40: 'Level 40: faster movement',
            45: 'Level 45: every 5th shot is a spread',
          };
          if (text[e.level]) this.ui.toast(text[e.level]);
        }
        return;
      }
      case 'blastWarn':
        this.blastWarnings.push({ tank: e.tank, x: e.x, y: e.y, at: e.at, from: e.tick });
        return;
      case 'blast':
        this.carve(e.x, e.y, e.r, e.rev);
        this.effects.push({ kind: 'explosion', x: e.x, y: e.y, r: this.cfg.deathBlastRadius, t0: now, dur: 800, big: true });
        this.spawnDebris(e.x, e.y, 24, now);
        return;
      case 'win': {
        this.match = { state: 'won', winner: e.tank, nukeAt: e.nukeAt };
        this.ui.banner(`${escapeHtml(e.name)} wins!<small>Nuke incoming…</small>`);
        return;
      }
      case 'nuke': {
        this.match = { state: 'playing' };
        this.terrain = generateTerrain(this.cfg, e.seed);
        this.terrainRev = e.rev;
        this.terrainView.reset(this.terrain);
        this.wind = e.wind;
        this.shells.clear();
        this.helis.clear();
        this.effects.push({ kind: 'flash', t0: now, dur: 1600 });
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
    const css = t ? colorCss(t.info.color) : '#fff';
    return `<span style="color:${css}">${escapeHtml(this.nameOf(id))}</span>`;
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
        c: color !== undefined && i % 2 ? colorCss(color) : ['#8a3a86', '#e9803a', '#6b2a6a', '#78d648'][i % 4],
        s: 2 + Math.random() * 3,
      });
    }
    this.effects.push({ kind: 'debris', parts, t0: now, dur: 1100 });
  }
}

export function colorCss(i: number) {
  return TANK_COLORS[i]?.css ?? '#fff';
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
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
