import { DEFAULT_CONFIG, lethalFallDistance, type GameConfig } from './config';
import { Rng } from './rng';
import { generateTerrain, Terrain, type CollapseOptions } from './terrain';
import {
  advanceShell,
  barrelTip,
  clamp,
  HELI_TANK_OFFSET,
  inBox,
  launchVelocity,
  tankHitbox,
} from './physics';
import {
  deathsAllowed,
  levelsForKill,
  MILESTONE_LEVELS,
  moveSpeed,
  spreadCadence,
} from './progression';
import type { ControllerKind, DeathCause, GameEvent, Helicopter, Shell, ShellLaunch, Tank } from './types';
import { botThink, createBotBrain, type BotBrain } from './bot';

export interface WorldOptions {
  cfg?: Partial<GameConfig>;
  seed?: number;
  terrainSeed?: number;
  wind?: number;
  /** Use this terrain instead of generating one (tests). */
  terrain?: Terrain;
}

export type MatchState = { state: 'playing' } | { state: 'won'; winner: number; nukeAt: number };

export interface AddTankOptions {
  id?: number;
  name: string;
  controller: ControllerKind;
  color?: number;
  /** Spawn immediately instead of after the respawn delay. */
  spawnNow?: boolean;
}

/** Columns (relative to the tank centre) that hold the tank up. */
const SUPPORT = [-4, 0, 4];
/** Slope is measured between the ground at x - span and x + span. */
const SLOPE_HALF_SPAN = 12;

interface Probe {
  /** Highest ground under the tank centre. */
  top: number;
  /** The tank centre is inside solid terrain (dirt landed on it). */
  embedded: boolean;
  /** dy/dx of the ground across the tracks; positive means the right side is lower. */
  slope: number;
}

/**
 * The authoritative game simulation. Pure and deterministic given its seed and inputs, so it
 * runs identically in the server and in tests. One `step()` is one tick.
 */
export class World {
  readonly cfg: GameConfig;
  tick = 0;
  terrain: Terrain;
  terrainSeed: number;
  terrainRev = 0;
  /** Integer wind speed; positive pushes right. */
  wind: number;
  rng: Rng;
  tanks = new Map<number, Tank>();
  shells: Shell[] = [];
  helis: Helicopter[] = [];
  bots = new Map<number, BotBrain>();
  match: MatchState = { state: 'playing' };
  private events: GameEvent[] = [];
  private nextShellId = 1;
  private nextHeliId = 1;
  private nextVolley = 1;
  private nextRunId = 1;
  private nextWindChange = 0;

  constructor(opts: WorldOptions = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...opts.cfg };
    this.rng = new Rng(opts.seed ?? 1);
    this.terrainSeed = opts.terrainSeed ?? this.rng.int(1, 0x7fffffff);
    this.terrain = opts.terrain ?? generateTerrain(this.cfg, this.terrainSeed);
    this.wind = opts.wind ?? this.rollWind();
    this.scheduleWindChange();
  }

  get collapseOptions(): CollapseOptions {
    return { minSliverThickness: this.cfg.minSliverThickness, detachedDirtFalls: this.cfg.detachedDirtFalls };
  }

  // ------------------------------------------------------------------ tanks

  addTank(o: AddTankOptions): Tank {
    const id = o.id ?? this.freeTankId();
    const color = o.color ?? this.freeColor();
    const t: Tank = {
      id,
      color,
      name: o.name,
      controller: o.controller,
      x: this.cfg.worldWidth / 2,
      y: -100,
      vy: 0,
      phase: 'dead',
      angle: 60,
      power: 55,
      move: 0,
      tilt: 0,
      fallStartY: null,
      fallCause: null,
      protectedUntil: 0,
      awaitingProtection: false,
      shellsInFlight: 0,
      shotsFired: 0,
      shotsUntilSpread: 0,
      lastImpact: null,
      runId: 0,
      runStartTick: this.tick,
      kills: 0,
      level: 0,
      deaths: 0,
      extraLife: false,
      respawnAt: o.spawnNow === false ? this.tick + this.cfg.respawnDelayTicks : this.tick,
      blastAt: 0,
      blastPos: null,
      infoDirty: true,
    };
    this.tanks.set(id, t);
    this.startRun(t);
    if (o.controller === 'bot') this.bots.set(id, createBotBrain(this.rng));
    return t;
  }

  removeTank(id: number) {
    this.tanks.delete(id);
    this.bots.delete(id);
    this.helis = this.helis.filter((h) => h.tankId !== id);
  }

  setController(id: number, controller: ControllerKind) {
    const t = this.tanks.get(id);
    if (!t) return;
    t.controller = controller;
    t.move = 0;
    t.infoDirty = true;
    if (controller === 'bot') {
      const brain = createBotBrain(this.rng);
      this.bots.set(id, brain);
      // A bot inheriting a tank on a helicopter picks a drop spot right away.
      const heli = this.helis.find((h) => h.tankId === id && h.carrying);
      if (heli) heli.dropX = this.pickDropX(heli.dir);
    } else {
      this.bots.delete(id);
      const heli = this.helis.find((h) => h.tankId === id && h.carrying);
      if (heli) heli.dropX = null;
    }
  }

  freeTankId(): number {
    for (let i = 0; i < this.cfg.maxTanksPerRoom; i++) if (!this.tanks.has(i)) return i;
    throw new Error('room full');
  }

  freeColor(): number {
    const used = new Set([...this.tanks.values()].map((t) => t.color));
    for (let i = 0; i < 10; i++) if (!used.has(i)) return i;
    return 0;
  }

  setAim(id: number, angle: number, power: number) {
    const t = this.tanks.get(id);
    if (!t) return;
    if (Number.isFinite(angle)) t.angle = clamp(Math.round(angle * 10) / 10, 0, 180);
    if (Number.isFinite(power)) t.power = clamp(Math.round(power * 10) / 10, this.cfg.minPower, this.cfg.maxPower);
  }

  setMove(id: number, dir: number) {
    const t = this.tanks.get(id);
    if (!t) return;
    t.move = dir > 0 ? 1 : dir < 0 ? -1 : 0;
  }

  /** Any gameplay input while carried releases the tank. Returns true if it dropped. */
  requestDrop(id: number): boolean {
    const heli = this.helis.find((h) => h.tankId === id && h.carrying);
    if (!heli) return false;
    this.release(heli, false);
    return true;
  }

  canFire(t: Tank) {
    return (
      this.match.state === 'playing' &&
      (t.phase === 'ground' || t.phase === 'slide') &&
      t.shellsInFlight === 0
    );
  }

  fire(id: number, angle?: number, power?: number): boolean {
    const t = this.tanks.get(id);
    if (!t) return false;
    if (angle !== undefined || power !== undefined) this.setAim(id, angle ?? t.angle, power ?? t.power);
    if (!this.canFire(t)) return false;

    const cadence = spreadCadence(t.level);
    let spread = false;
    if (cadence > 0) {
      if (t.shotsUntilSpread <= 0) {
        spread = true;
        t.shotsUntilSpread = cadence - 1;
      } else {
        t.shotsUntilSpread--;
      }
    }
    const angles = spread
      ? [t.angle - this.cfg.spreadAngleDeg, t.angle, t.angle + this.cfg.spreadAngleDeg]
      : [t.angle];
    const volley = this.nextVolley++;
    const launches: ShellLaunch[] = [];
    for (const a of angles) {
      const tip = barrelTip(this.cfg, t.x, t.y, a);
      const v = launchVelocity(this.cfg, a, t.power, t.level);
      const s: Shell = {
        id: this.nextShellId++,
        owner: t.id,
        x: tip.x,
        y: tip.y,
        vx: v.vx,
        vy: v.vy,
        bornTick: this.tick,
        ownerController: t.controller,
        volley,
      };
      this.shells.push(s);
      launches.push({ id: s.id, x: s.x, y: s.y, vx: s.vx, vy: s.vy });
    }
    t.shellsInFlight = launches.length;
    t.shotsFired++;
    // Firing ends spawn protection immediately.
    if (t.protectedUntil > this.tick || t.awaitingProtection) {
      t.protectedUntil = 0;
      t.awaitingProtection = false;
    }
    t.infoDirty = true;
    this.emit({
      type: 'fire',
      tick: this.tick,
      tank: t.id,
      shells: launches,
      spread,
      controller: t.controller,
      level: t.level,
    });
    return true;
  }

  isProtected(t: Tank) {
    return t.phase === 'carried' || t.phase === 'chute' || t.protectedUntil > this.tick;
  }

  // ------------------------------------------------------------------ main loop

  /**
   * Advance one tick. Returns every event since the previous step, including ones caused by
   * player input between ticks (fire, drop), which carry the tick they happened on.
   */
  step(): GameEvent[] {
    this.tick++;

    if (this.match.state === 'won' && this.tick >= this.match.nukeAt) this.nuke();
    if (this.cfg.windChangeSeconds > 0 && this.tick >= this.nextWindChange) {
      this.wind = this.rollWind();
      this.scheduleWindChange();
    }

    for (const t of this.tanks.values()) {
      if (t.controller === 'bot') {
        const brain = this.bots.get(t.id);
        if (brain) botThink(this, t, brain);
      }
    }

    this.updateHelis();

    for (const t of this.tanks.values()) {
      if (t.phase === 'dead') {
        if (this.match.state === 'playing' && this.tick >= t.respawnAt) this.spawnHeli(t);
        continue;
      }
      this.updateTank(t);
    }

    this.updateShells();

    for (const t of this.tanks.values()) {
      if (t.blastAt && this.tick >= t.blastAt) this.detonateBlast(t);
    }

    const out = this.events;
    this.events = [];
    return out;
  }

  private emit(e: GameEvent) {
    this.events.push(e);
  }

  // ------------------------------------------------------------------ helicopters

  private spawnHeli(t: Tank) {
    const dir: 1 | -1 = this.rng.chance(0.5) ? 1 : -1;
    const heli: Helicopter = {
      id: this.nextHeliId++,
      tankId: t.id,
      x: dir > 0 ? -90 : this.cfg.worldWidth + 90,
      y: this.cfg.heliAltitude,
      dir,
      carrying: true,
      dropX: t.controller === 'bot' ? this.pickDropX(dir) : null,
    };
    this.helis.push(heli);
    t.phase = 'carried';
    t.x = clamp(heli.x, this.cfg.tankWidth / 2, this.cfg.worldWidth - this.cfg.tankWidth / 2);
    t.y = heli.y + HELI_TANK_OFFSET;
    t.vy = 0;
    t.fallStartY = null;
    t.fallCause = null;
    t.awaitingProtection = true;
    t.protectedUntil = 0;
    t.move = 0;
    t.tilt = 0;
    t.infoDirty = true;
    this.emit({ type: 'heliSpawn', tick: this.tick, heli: heli.id, tank: t.id });
  }

  /** Bots drop over reasonably flat ground. */
  pickDropX(dir: 1 | -1): number {
    const W = this.cfg.worldWidth;
    let best = W / 2;
    let bestScore = Infinity;
    for (let i = 0; i < 12; i++) {
      const x = this.rng.range(W * 0.08, W * 0.85);
      const xx = dir > 0 ? x : W - x;
      const a = this.terrain.topAt(xx - 14);
      const b = this.terrain.topAt(xx + 14);
      const c = this.terrain.topAt(xx);
      const score = Math.abs(a - b) + Math.abs(2 * c - a - b) + this.rng.range(0, 6);
      if (score < bestScore) {
        bestScore = score;
        best = xx;
      }
    }
    return best;
  }

  private updateHelis() {
    const dt = 1 / this.cfg.tickRate;
    const W = this.cfg.worldWidth;
    for (const h of this.helis) {
      const prevX = h.x;
      h.x += h.dir * this.cfg.heliSpeed * dt;
      if (!h.carrying) continue;
      const t = this.tanks.get(h.tankId);
      if (!t) {
        h.carrying = false;
        continue;
      }
      t.x = clamp(h.x, this.cfg.tankWidth / 2, W - this.cfg.tankWidth / 2);
      t.y = h.y + HELI_TANK_OFFSET;
      const progress = h.dir > 0 ? h.x / W : (W - h.x) / W;
      const crossedBotDrop =
        h.dropX !== null && ((h.dir > 0 && prevX < h.dropX && h.x >= h.dropX) || (h.dir < 0 && prevX > h.dropX && h.x <= h.dropX));
      if (progress >= this.cfg.autoDropAt || crossedBotDrop) this.release(h, false);
    }
    this.helis = this.helis.filter((h) => h.x > -200 && h.x < W + 200);
  }

  private release(h: Helicopter, forced: boolean) {
    h.carrying = false;
    const t = this.tanks.get(h.tankId);
    if (!t || t.phase !== 'carried') return;
    t.phase = 'chute';
    t.x = clamp(h.x, this.cfg.tankWidth / 2 + 1, this.cfg.worldWidth - this.cfg.tankWidth / 2 - 1);
    t.y = h.y + HELI_TANK_OFFSET;
    t.infoDirty = true;
    this.emit({ type: 'drop', tick: this.tick, tank: t.id, x: t.x, y: t.y, forced });
  }

  // ------------------------------------------------------------------ tank physics

  /** Ground in column x starting at fromY; returns fromY if fromY is inside solid (a wall). */
  private columnGround(x: number, fromY: number): number {
    const t = this.terrain;
    const cx = clamp(Math.floor(x), 0, t.width - 1);
    const c = t.cols[cx];
    for (let i = 0; i < c.length; i += 2) {
      if (c[i] <= fromY && c[i + 1] > fromY) return fromY;
      if (c[i] > fromY) return c[i];
    }
    return t.height;
  }

  /**
   * Support under the tank's centre: the highest ground among three central columns that
   * starts at or below `fromY`. Columns already solid at `fromY` are walls and ignored.
   */
  private centerGround(x: number, fromY: number): { top: number; embedded: boolean } {
    let top = Infinity;
    let walls = 0;
    for (const dx of SUPPORT) {
      const g = this.columnGround(x + dx, fromY);
      if (g <= fromY) walls++;
      else if (g < top) top = g;
    }
    if (walls >= 2 || top === Infinity) return { top: fromY, embedded: true };
    return { top, embedded: false };
  }

  /** Surface height of column x near a tank standing at y, clamped to y +/- 30. */
  private localSurface(x: number, y: number): number {
    const t = this.terrain;
    const c = t.cols[clamp(Math.floor(x), 0, t.width - 1)];
    const probeY = y - this.cfg.stepUp;
    for (let i = 0; i < c.length; i += 2) {
      if (c[i] <= probeY && c[i + 1] > probeY) return Math.max(c[i], y - 30);
      if (c[i] > probeY) return Math.min(c[i], y + 30);
    }
    return y + 30;
  }

  /** Ground contact for a tank standing (or about to stand) at (x, y). */
  private probe(x: number, y: number): Probe {
    const g = this.centerGround(x, y - this.cfg.stepUp);
    if (g.embedded) return { top: g.top, embedded: true, slope: 0 };
    const surfaceY = Math.min(g.top, y);
    const sl = this.localSurface(x - SLOPE_HALF_SPAN, surfaceY);
    const sr = this.localSurface(x + SLOPE_HALF_SPAN, surfaceY);
    return { top: g.top, embedded: false, slope: (sr - sl) / (2 * SLOPE_HALF_SPAN) };
  }

  /** A wall (or a ceiling lower than the tank) at the leading edge blocks horizontal motion. */
  private blocked(t: Tank, nx: number, dir: number): boolean {
    if (this.centerGround(nx, t.y - this.cfg.stepUp).embedded) return true;
    const edge = nx + dir * (this.cfg.tankWidth / 2 - 3);
    return this.terrain.solidAt(edge, t.y - this.cfg.tankBodyHeight);
  }

  private maxSlope() {
    return Math.tan((this.cfg.maxSettleSlopeDeg * Math.PI) / 180);
  }

  private updateTank(t: Tank) {
    const cfg = this.cfg;
    const dt = 1 / cfg.tickRate;
    switch (t.phase) {
      case 'carried':
        return;
      case 'chute': {
        const prevY = t.y;
        const ny = t.y + cfg.parachuteSpeed * dt;
        const g = this.centerGround(t.x, prevY);
        if (ny >= g.top) {
          t.y = g.top;
          // A fresh drop measures any fall from where it lands.
          t.fallStartY = t.y;
          t.fallCause = null;
          t.phase = 'slide';
          t.infoDirty = true;
          this.groundUpdate(t);
        } else {
          t.y = ny;
        }
        return;
      }
      case 'air': {
        const prevY = t.y;
        t.vy = Math.min(t.vy + cfg.gravity * dt, cfg.maxFallSpeed);
        const ny = t.y + t.vy * dt;
        const g = this.centerGround(t.x, prevY);
        if (ny >= g.top) {
          t.y = g.top;
          t.vy = 0;
          t.phase = 'slide';
          if (this.checkLethalFall(t)) return;
          this.groundUpdate(t);
        } else {
          t.y = ny;
          if (t.y > cfg.worldHeight) t.y = cfg.worldHeight - cfg.bedrock;
        }
        return;
      }
      case 'ground':
      case 'slide':
        this.groundUpdate(t);
        return;
      case 'dead':
        return;
    }
  }

  private beginFall(t: Tank, cause: number | null) {
    if (t.fallStartY === null) {
      t.fallStartY = t.y;
      t.fallCause = cause;
    }
  }

  /** Returns true if the tank died. */
  private checkLethalFall(t: Tank): boolean {
    if (t.fallStartY === null) return false;
    const drop = t.y - t.fallStartY;
    if (drop >= lethalFallDistance(this.cfg)) {
      const killer = t.fallCause;
      this.killTank(t, killer !== null ? 'fall' : 'environment', killer, drop);
      return true;
    }
    return false;
  }

  private settle(t: Tank) {
    if (this.checkLethalFall(t)) return;
    const wasMoving = t.phase !== 'ground';
    t.fallStartY = null;
    t.fallCause = null;
    t.phase = 'ground';
    if (t.awaitingProtection) {
      t.awaitingProtection = false;
      t.protectedUntil = this.tick + Math.round(this.cfg.spawnProtectionSeconds * this.cfg.tickRate);
      t.infoDirty = true;
      this.emit({ type: 'settled', tick: this.tick, tank: t.id });
    } else if (wasMoving) {
      t.infoDirty = true;
    }
  }

  private groundUpdate(t: Tank) {
    const cfg = this.cfg;
    const dt = 1 / cfg.tickRate;
    const p = this.probe(t.x, t.y);
    if (p.embedded) {
      // Dirt landed on us: climb out onto it.
      t.y -= 2;
      return;
    }
    if (p.top > t.y + 3) {
      // Lost footing.
      this.beginFall(t, null);
      t.phase = 'air';
      t.vy = 0;
      t.infoDirty = true;
      return;
    }
    t.y = p.top;
    t.tilt = Math.atan(clamp(p.slope, -1.2, 1.2)) * 0.8;

    const steep = Math.abs(p.slope) > this.maxSlope();
    if (t.phase === 'ground') {
      if (steep) {
        this.beginFall(t, null);
        t.phase = 'slide';
        t.infoDirty = true;
        return;
      }
      this.tryMove(t);
      return;
    }
    // Sliding.
    if (!steep) {
      this.settle(t);
      return;
    }
    const dir = p.slope > 0 ? 1 : -1;
    const nx = clamp(t.x + dir * cfg.slideSpeed * dt, cfg.tankWidth / 2, cfg.worldWidth - cfg.tankWidth / 2);
    if (nx === t.x || this.blocked(t, nx, dir)) {
      // Wedged against a wall or the world edge: settle here.
      this.settle(t);
      return;
    }
    t.x = nx;
  }

  private tryMove(t: Tank) {
    if (t.move === 0) return;
    const speed = moveSpeed(this.cfg, t.level);
    if (speed <= 0) return;
    const cfg = this.cfg;
    const nx = clamp(t.x + (t.move * speed) / cfg.tickRate, cfg.tankWidth / 2, cfg.worldWidth - cfg.tankWidth / 2);
    if (this.blocked(t, nx, t.move)) return;
    t.x = nx;
  }

  /** After terrain changes, tanks that lost footing start a fall credited to `cause`. */
  private checkFooting(cause: number | null) {
    for (const t of this.tanks.values()) {
      if (t.phase !== 'ground') continue;
      const p = this.probe(t.x, t.y);
      if (p.embedded) continue;
      const lost = p.top > t.y + 3;
      const steep = Math.abs(p.slope) > this.maxSlope();
      if (!lost && !steep) continue;
      this.beginFall(t, cause !== null && cause !== t.id ? cause : null);
      t.phase = lost ? 'air' : 'slide';
      t.vy = 0;
      t.infoDirty = true;
    }
  }

  // ------------------------------------------------------------------ shells

  private updateShells() {
    const cfg = this.cfg;
    const W = cfg.worldWidth;
    const H = cfg.worldHeight;
    const survivors: Shell[] = [];
    type Outcome = { kind: 'gone' } | { kind: 'explode'; tank: Tank | null; heli: Helicopter | null };
    for (const s of this.shells) {
      const res: { o: Outcome | null } = { o: null };
      const age = this.tick - s.bornTick;
      advanceShell(cfg, s, this.wind, (p) => {
        if (p.x < 0 || p.x >= W) {
          res.o = { kind: 'gone' };
          return true;
        }
        if (p.y >= H - 1) {
          p.y = H - 1;
          res.o = { kind: 'explode', tank: null, heli: null };
          return true;
        }
        if (p.y < 0) return false;
        for (const h of this.helis) {
          if (!h.carrying) continue;
          if (Math.abs(p.x - h.x) <= cfg.heliHitWidth / 2 && Math.abs(p.y - h.y) <= cfg.heliHitHeight / 2) {
            res.o = { kind: 'explode', tank: null, heli: h };
            return true;
          }
        }
        for (const t of this.tanks.values()) {
          if (t.phase === 'dead' || t.phase === 'carried' || t.phase === 'chute') continue;
          if (t.id === s.owner && age < 10) continue;
          if (inBox(tankHitbox(cfg, t), p.x, p.y)) {
            res.o = { kind: 'explode', tank: t, heli: null };
            return true;
          }
        }
        if (this.terrain.solidAt(p.x, p.y)) {
          res.o = { kind: 'explode', tank: null, heli: null };
          return true;
        }
        return false;
      });
      const o = res.o;
      if (!o && this.tick - s.bornTick > cfg.shellLifetimeTicks) {
        this.resolveShell(s);
        this.emit({ type: 'shellGone', tick: this.tick, shell: s.id });
        continue;
      }
      if (!o) {
        survivors.push(s);
        continue;
      }
      if (o.kind === 'gone') {
        this.resolveShell(s);
        this.emit({ type: 'shellGone', tick: this.tick, shell: s.id });
        continue;
      }
      this.explodeShell(s, o.tank, o.heli);
    }
    this.shells = survivors;
  }

  private resolveShell(s: Shell) {
    const owner = this.tanks.get(s.owner);
    if (owner && owner.shellsInFlight > 0) {
      owner.shellsInFlight--;
      if (owner.shellsInFlight === 0) owner.infoDirty = true;
    }
  }

  private craterRadius(owner: Tank | undefined) {
    const c = this.cfg;
    if (!owner || c.craterGrowthPerKill <= 0) return c.craterRadius;
    return c.craterRadius + Math.min(c.craterGrowthMax, owner.kills * c.craterGrowthPerKill);
  }

  private explodeShell(s: Shell, hitTank: Tank | null, hitHeli: Helicopter | null) {
    this.resolveShell(s);
    const owner = this.tanks.get(s.owner);
    const r = this.craterRadius(owner);
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    this.terrain.carve(x, y, r, this.collapseOptions);
    this.terrainRev++;
    const shielded = !!hitTank && this.isProtected(hitTank);
    this.emit({
      type: 'explode',
      tick: this.tick,
      shell: s.id,
      owner: s.owner,
      x,
      y,
      r,
      rev: this.terrainRev,
      hitTank: hitTank ? hitTank.id : null,
      shielded,
      hitHeli: hitHeli ? hitHeli.id : null,
    });
    if (owner) {
      owner.lastImpact = { x, y };
      owner.infoDirty = true;
    }
    if (hitHeli) this.destroyHeli(hitHeli, s);
    if (hitTank && !shielded) {
      const killer = hitTank.id === s.owner || !owner ? null : s.owner;
      this.killTank(hitTank, killer !== null ? 'direct' : 'environment', killer, null);
    }
    this.checkFooting(owner ? owner.id : null);
  }

  private destroyHeli(h: Helicopter, s: Shell) {
    const passenger = this.tanks.get(h.tankId);
    this.release(h, true);
    this.helis = this.helis.filter((x) => x !== h);
    this.emit({ type: 'heliDown', tick: this.tick, heli: h.id, tank: h.tankId, by: s.owner, x: h.x, y: h.y });
    const owner = this.tanks.get(s.owner);
    if (owner && passenger && owner.id !== passenger.id) this.awardKill(owner, null, 'heli', null);
  }

  // ------------------------------------------------------------------ deaths and progression

  killTank(t: Tank, cause: DeathCause, killerId: number | null, fallDistance: number | null) {
    if (t.phase === 'dead') return;
    const killer = killerId !== null ? this.tanks.get(killerId) : undefined;
    const levelBefore = t.level;
    t.deaths++;
    const deathNumber = t.deaths;
    const reset = t.deaths >= deathsAllowed(this.cfg, t);
    const x = t.x;
    const y = t.y;
    t.phase = 'dead';
    t.respawnAt = this.tick + this.cfg.respawnDelayTicks;
    t.fallStartY = null;
    t.fallCause = null;
    t.protectedUntil = 0;
    t.awaitingProtection = false;
    t.move = 0;
    t.infoDirty = true;
    this.emit({
      type: 'death',
      tick: this.tick,
      tank: t.id,
      cause,
      killer: killer ? killer.id : null,
      x,
      y,
      levelBefore,
      deathNumber,
      reset,
      victimController: t.controller,
      killerController: killer ? killer.controller : null,
      fallDistance,
    });
    if (this.cfg.deathBlastEnabled && levelBefore >= 30) {
      t.blastAt = this.tick + this.cfg.deathBlastDelayTicks;
      t.blastPos = { x, y };
      this.emit({ type: 'blastWarn', tick: this.tick, tank: t.id, x, y, at: t.blastAt });
    }
    if (reset) {
      this.emit({
        type: 'runReset',
        tick: this.tick,
        tank: t.id,
        runId: t.runId,
        levelBefore,
        deathNumber,
        reason: 'deaths',
        controller: t.controller,
      });
      this.startRun(t);
    }
    if (killer && killer.id !== t.id) this.awardKill(killer, levelBefore, cause, t);
  }

  private startRun(t: Tank) {
    t.runId = this.nextRunId++;
    t.runStartTick = this.tick;
    t.kills = 0;
    t.level = 0;
    t.deaths = 0;
    t.extraLife = false;
    t.shotsUntilSpread = 0;
    t.lastImpact = null;
    t.infoDirty = true;
    this.emit({ type: 'runStart', tick: this.tick, tank: t.id, runId: t.runId, controller: t.controller });
  }

  private awardKill(k: Tank, victimLevel: number | null, cause: DeathCause | 'heli', victim: Tank | null) {
    const levelBefore = k.level;
    const gained = levelsForKill(this.cfg, victimLevel);
    k.kills++;
    k.level = Math.min(this.cfg.winLevel, k.level + gained);
    const after = k.level;
    if (levelBefore < 15 && after >= 15) k.shotsUntilSpread = 9;
    if (levelBefore < 45 && after >= 45) k.shotsUntilSpread = Math.min(k.shotsUntilSpread, 4);
    if (levelBefore < 25 && after >= 25) k.extraLife = true;
    k.infoDirty = true;
    this.emit({
      type: 'kill',
      tick: this.tick,
      killer: k.id,
      victim: victim ? victim.id : null,
      heli: cause === 'heli',
      cause,
      levelsAwarded: after - levelBefore,
      levelBefore,
      levelAfter: after,
      killerController: k.controller,
    });
    for (const m of MILESTONE_LEVELS) {
      if (levelBefore < m && after >= m) {
        this.emit({
          type: 'milestone',
          tick: this.tick,
          tank: k.id,
          level: m,
          runId: k.runId,
          elapsedTicks: this.tick - k.runStartTick,
          controller: k.controller,
        });
      }
    }
    if (after >= this.cfg.winLevel && this.match.state === 'playing') {
      const nukeAt = this.tick + this.cfg.winCelebrationTicks;
      this.match = { state: 'won', winner: k.id, nukeAt };
      this.emit({ type: 'win', tick: this.tick, tank: k.id, name: k.name, controller: k.controller, nukeAt });
    }
  }

  private detonateBlast(t: Tank) {
    const pos = t.blastPos;
    t.blastAt = 0;
    t.blastPos = null;
    if (!pos) return;
    const r = this.cfg.deathBlastRadius;
    this.terrain.carve(pos.x, pos.y, Math.round(r * 0.5), this.collapseOptions);
    this.terrainRev++;
    this.emit({ type: 'blast', tick: this.tick, tank: t.id, x: Math.round(pos.x), y: Math.round(pos.y), r: Math.round(r * 0.5), rev: this.terrainRev });
    for (const v of this.tanks.values()) {
      if (v.id === t.id || v.phase === 'dead' || this.isProtected(v)) continue;
      const dx = v.x - pos.x;
      const dy = v.y - this.cfg.tankBodyHeight / 2 - pos.y;
      if (dx * dx + dy * dy <= r * r) this.killTank(v, 'blast', t.id, null);
    }
    this.checkFooting(t.id);
  }

  private nuke() {
    this.terrainSeed = this.rng.int(1, 0x7fffffff);
    this.terrain = generateTerrain(this.cfg, this.terrainSeed);
    this.terrainRev++;
    this.wind = this.rollWind();
    this.shells = [];
    this.helis = [];
    let i = 0;
    for (const t of this.tanks.values()) {
      this.emit({
        type: 'runReset',
        tick: this.tick,
        tank: t.id,
        runId: t.runId,
        levelBefore: t.level,
        deathNumber: t.deaths,
        reason: 'nuke',
        controller: t.controller,
      });
      this.startRun(t);
      t.phase = 'dead';
      t.shellsInFlight = 0;
      t.blastAt = 0;
      t.blastPos = null;
      t.respawnAt = this.tick + 30 + i * 25;
      t.infoDirty = true;
      i++;
    }
    this.match = { state: 'playing' };
    this.emit({ type: 'nuke', tick: this.tick, seed: this.terrainSeed, wind: this.wind, rev: this.terrainRev });
  }

  // ------------------------------------------------------------------ wind

  private rollWind() {
    const max = this.cfg.windMaxSpeed;
    return this.rng.int(-max, max);
  }

  private scheduleWindChange() {
    this.nextWindChange = this.tick + Math.round(this.cfg.windChangeSeconds * this.cfg.tickRate);
  }
}
