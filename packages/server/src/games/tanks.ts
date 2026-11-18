import {
  TANK_BOT_NAMES,
  heliDyns,
  Rng,
  randomSeed,
  tankDyn,
  tankInfo,
  uniqueName,
  World,
  type GameConfig,
  type GameEvent,
  type Snapshot,
  type Tank,
  type TankInfo,
  type GameInput,
} from '@tank/shared';
import type { GameHost, Member, ServerGame } from './types';

/** A player may ask for a fresh snapshot at most this often. */
const RESYNC_COOLDOWN_MS = 2000;

/**
 * The artillery game. Every member drives a tank; bots fill the room to `botMinTanks`, give
 * their tank to a newcomer, and drive for anyone who disconnects until they come back.
 */
export class TanksGame implements ServerGame {
  readonly id = 'tanks' as const;
  readonly world: World;
  /** session -> tank id. Held while the member is disconnected. */
  private seats = new Map<string, number>();
  private pending: GameEvent[] = [];
  private removed: number[] = [];
  private rng: Rng;
  private lastResync = new Map<string, number>();

  constructor(
    private host: GameHost,
    opts: { cfg?: Partial<GameConfig>; seed?: number } = {},
  ) {
    const seed = opts.seed ?? randomSeed();
    this.rng = new Rng(seed ^ 0x5bd1e995);
    this.world = new World({ cfg: opts.cfg, seed });
    this.rebalanceBots();
  }

  get capacity() {
    return this.world.cfg.maxTanksPerRoom;
  }

  tankIdOf(session: string): number | null {
    return this.seats.get(session) ?? null;
  }

  private ownerOf(tankId: number): Member | undefined {
    for (const [session, id] of this.seats) if (id === tankId) return this.host.member(session);
    return undefined;
  }

  private isSeat(tankId: number) {
    for (const id of this.seats.values()) if (id === tankId) return true;
    return false;
  }

  private unreservedBots(): Tank[] {
    return [...this.world.tanks.values()].filter((t) => t.controller === 'bot' && !this.isSeat(t.id));
  }

  // ------------------------------------------------------------------ seats

  addPlayer(m: Member): boolean {
    if (this.seats.has(m.session)) return true;
    this.freeNameFromBots(m.name);
    if (!this.seatNewcomer(m)) return false;
    this.rebalanceBots();
    return true;
  }

  reconnect(m: Member): boolean {
    const id = this.seats.get(m.session);
    if (id !== undefined && this.world.tanks.has(id)) {
      const t = this.world.tanks.get(id)!;
      const fromBot = t.controller === 'bot';
      this.world.setController(id, 'human');
      t.infoDirty = true;
      this.host.log('reclaim', { pid: m.pid, success: true, device: m.device });
      return fromBot;
    }
    this.seats.delete(m.session);
    this.host.log('reclaim', { pid: m.pid, success: false, device: m.device });
    this.addPlayer(m);
    return false;
  }

  disconnect(m: Member, reason: string): string | null {
    const id = this.seats.get(m.session);
    if (id === undefined || !this.world.tanks.has(id)) return null;
    this.world.setController(id, 'bot');
    this.markInfo(id);
    this.host.log('bot_handoff', { pid: m.pid, tank: id, reason, device: m.device });
    return 'A bot is driving their tank.';
  }

  removePlayer(m: Member) {
    const id = this.seats.get(m.session);
    this.seats.delete(m.session);
    this.lastResync.delete(m.session);
    if (id !== undefined) this.markInfo(id);
    this.rebalanceBots();
  }

  renamed(m: Member) {
    this.freeNameFromBots(m.name);
    const id = this.seats.get(m.session);
    const t = id !== undefined ? this.world.tanks.get(id) : undefined;
    if (t) {
      t.name = m.name;
      t.infoDirty = true;
    }
  }

  /** Give a member a fresh tank: replace an unreserved bot, or take a free slot. */
  private seatNewcomer(m: Member): boolean {
    const w = this.world;
    const bots = this.unreservedBots();
    let id: number;
    if (bots.length) {
      // Prefer replacing a bot that is dead or still on its helicopter.
      const bot = bots.find((b) => b.phase === 'dead' || b.phase === 'carried') ?? bots[0];
      id = bot.id;
      w.removeTank(id);
      this.removed.push(id);
      this.host.log('bot_replaced', { tank: id });
    } else if (w.tanks.size < w.cfg.maxTanksPerRoom) {
      id = w.freeTankId();
    } else {
      return false;
    }
    // People keep their room colour in every game; a bot wearing it changes.
    const clash = [...w.tanks.values()].filter((t) => t.color === m.color);
    const t = w.addTank({ id, name: m.name, controller: m.conn ? 'human' : 'bot', color: m.color });
    for (const other of clash) {
      other.color = w.freeColor();
      other.infoDirty = true;
    }
    this.seats.set(m.session, t.id);
    return true;
  }

  /** Bots give up a name a person wants (they share the default name list). */
  private freeNameFromBots(name: string) {
    const lower = name.toLowerCase();
    for (const t of this.world.tanks.values()) {
      if (t.controller === 'bot' && !this.isSeat(t.id) && t.name.toLowerCase() === lower) {
        t.name = this.botName();
        t.infoDirty = true;
      }
    }
  }

  /** Keep at least botMinTanks tanks; trim surplus unreserved bots. */
  private rebalanceBots() {
    const w = this.world;
    const target = Math.min(w.cfg.maxTanksPerRoom, Math.max(w.cfg.botMinTanks, this.seats.size));
    while (w.tanks.size < target) {
      const t = w.addTank({ name: this.botName(), controller: 'bot' });
      this.markInfo(t.id);
    }
    if (w.tanks.size > target) {
      const surplus = this.unreservedBots().sort((a, b) => rank(a) - rank(b));
      while (w.tanks.size > target && surplus.length) {
        const bot = surplus.shift()!;
        w.removeTank(bot.id);
        this.removed.push(bot.id);
      }
    }
  }

  private botName() {
    const taken = new Set<string>();
    for (const t of this.world.tanks.values()) taken.add(t.name.toLowerCase());
    for (const m of this.host.members()) taken.add(m.name.toLowerCase());
    const free = TANK_BOT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
    return free.length ? this.rng.pick(free) : uniqueName(this.rng.pick(TANK_BOT_NAMES), taken);
  }

  // ------------------------------------------------------------------ input

  handle(m: Member, input: GameInput) {
    const id = this.seats.get(m.session);
    if (id === undefined) return;
    const w = this.world;
    const tank = w.tanks.get(id);
    const msg = input;
    switch (msg.t) {
      case 'aim':
      case 'fire':
      case 'move':
      case 'drop': {
        if (!tank) return;
        // Any gameplay input while carried is consumed as the drop.
        if (tank.phase === 'carried') {
          w.requestDrop(id);
          return;
        }
        if (msg.t === 'aim') w.setAim(id, msg.angle, msg.power);
        else if (msg.t === 'fire') w.fire(id, msg.angle, msg.power);
        else if (msg.t === 'move') w.setMove(id, msg.dir);
        return;
      }
      case 'resync': {
        const now = this.host.now();
        if (now - (this.lastResync.get(m.session) ?? -Infinity) < RESYNC_COOLDOWN_MS) return;
        this.lastResync.set(m.session, now);
        this.sendInit(m, false);
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ sync

  private markInfo(tankId: number | null) {
    if (tankId === null) return;
    const t = this.world.tanks.get(tankId);
    if (t) t.infoDirty = true;
  }

  private info(t: Tank): TankInfo {
    const owner = this.ownerOf(t.id);
    return tankInfo(t, owner ? { name: owner.name, alias: owner.alias } : null, !!owner && !owner.conn);
  }

  snapshot(): Snapshot {
    const w = this.world;
    return {
      tick: w.tick,
      terrain: w.terrain.toData(),
      terrainSeed: w.terrainSeed,
      terrainRev: w.terrainRev,
      wind: w.wind,
      tanks: [...w.tanks.values()].map((t) => this.info(t)),
      dyn: [...w.tanks.values()].map(tankDyn),
      helis: heliDyns(w),
      shells: w.shells.map((s) => ({ id: s.id, owner: s.owner, x: s.x, y: s.y, vx: s.vx, vy: s.vy })),
      match: w.match,
    };
  }

  sendInit(m: Member, reclaimed: boolean) {
    const id = this.seats.get(m.session);
    if (id === undefined) return;
    this.host.send(m, { t: 'init', tankId: id, reclaimed, config: this.world.cfg, snapshot: this.snapshot() });
  }

  step() {
    const w = this.world;
    const events = w.step();
    if (events.length) {
      this.pending.push(...events);
      this.logGameEvents(events);
      // Winners get a line in room chat (and its history, so late joiners see it too).
      for (const e of events) if (e.type === 'win') this.host.systemChat(`${e.name} won!`);
    }
    if (w.tick % w.cfg.stateEvery === 0) this.flush();
  }

  private flush() {
    const w = this.world;
    if (this.removed.length) {
      this.host.broadcast({ t: 'removed', tanks: this.removed });
      this.removed = [];
    }
    const dirty: TankInfo[] = [];
    for (const t of w.tanks.values()) {
      if (t.infoDirty) {
        t.infoDirty = false;
        dirty.push(this.info(t));
      }
    }
    if (dirty.length) this.host.broadcast({ t: 'info', tanks: dirty });
    if (this.pending.length) {
      this.host.broadcast({ t: 'events', tick: w.tick, events: this.pending });
      this.pending = [];
    }
    this.host.broadcast({ t: 'state', tick: w.tick, dyn: [...w.tanks.values()].map(tankDyn), helis: heliDyns(w) });
  }

  dispose() {
    this.seats.clear();
  }

  stats() {
    const tanks = [...this.world.tanks.values()];
    return { tanks: tanks.length, bots: tanks.filter((t) => t.controller === 'bot').length };
  }

  private logGameEvents(events: GameEvent[]) {
    const humans = this.host.members().filter((m) => m.conn).length;
    for (const e of events) {
      switch (e.type) {
        case 'fire':
          this.host.log('shot', { tank: e.tank, spread: e.spread, controller: e.controller, level: e.level, humans });
          break;
        case 'death':
        case 'kill':
        case 'milestone':
        case 'runStart':
        case 'runReset':
        case 'win':
        case 'nuke':
        case 'heliDown': {
          const { type, ...rest } = e;
          const tankId = 'tank' in e ? e.tank : 'killer' in e ? e.killer : null;
          const t = tankId !== null ? this.world.tanks.get(tankId) : undefined;
          this.host.log(type, { ...rest, runId: t?.runId, humans });
          break;
        }
        default:
          break;
      }
    }
  }
}

/** Bots to remove first: dead or still on the helicopter, then the rest. */
function rank(t: Tank) {
  return t.phase === 'dead' ? 0 : t.phase === 'carried' ? 1 : 2;
}
