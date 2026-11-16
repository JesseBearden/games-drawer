import { createHash, randomUUID } from 'node:crypto';
import {
  cleanName,
  cleanText,
  DEFAULT_NAMES,
  heliDyns,
  PROTOCOL_VERSION,
  Rng,
  randomSeed,
  tankDyn,
  tankInfo,
  uniqueName,
  World,
  type ChatMessage,
  type ClientMessage,
  type Device,
  type GameConfig,
  type GameEvent,
  type RoomKind,
  type ServerMessage,
  type Snapshot,
  type Tank,
  type TankInfo,
} from '@tank/shared';
import { MAX_CHAT_LENGTH, RateLimiter, RULE_VERSION, type ChatModerator } from './chat';
import type { LogSink } from './eventlog';

/** A client connection. `send` takes pre-serialised JSON so broadcasts serialise once. */
export interface Conn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RoomDeps {
  now: () => number;
  log: LogSink;
  moderator: ChatModerator;
  /** Room closes this long after the last human leaves. */
  emptyRoomMs: number;
  /** Public-room reclaim window. Private rooms hold reservations for the room's lifetime. */
  publicReclaimMs: number;
  cfg?: Partial<GameConfig>;
  seed?: number;
  chatHistorySize: number;
}

interface Player {
  session: string;
  /** Pseudonymous id for logs (never the session credential). */
  pid: string;
  name: string;
  conn: Conn | null;
  tankId: number | null;
  device: Device;
  connectedAt: number;
  /** When a disconnected player's reservation ends (Infinity in private rooms). */
  reservedUntil: number;
  limiter: RateLimiter;
  lastRename: number;
  /** Last arrival / departure notice, so reconnect loops cannot spam chat. */
  lastArrive: number;
  lastLeave: number;
  lastNotice: number;
}

/** One rename per this many ms. */
export const RENAME_COOLDOWN_MS = 10_000;
/** Join/leave/back notices for the same player at most this often. */
export const ANNOUNCE_COOLDOWN_MS = 20_000;

export type JoinResult =
  | { ok: true; tankId: number; reclaimed: boolean; name: string }
  | { ok: false; code: 'room-full'; message: string };

export function pseudonym(session: string) {
  return createHash('sha256').update('tank-pid:' + session).digest('hex').slice(0, 16);
}

export class Room {
  readonly world: World;
  readonly players = new Map<string, Player>();
  readonly chatHistory: ChatMessage[] = [];
  readonly createdAt: number;
  emptySince: number | null;
  closed = false;
  private pending: GameEvent[] = [];
  private removed: number[] = [];
  private rng: Rng;

  constructor(
    readonly code: string,
    readonly kind: RoomKind,
    private deps: RoomDeps,
  ) {
    const seed = deps.seed ?? randomSeed();
    this.rng = new Rng(seed ^ 0x5bd1e995);
    this.world = new World({ cfg: deps.cfg, seed });
    this.createdAt = deps.now();
    // A brand-new room is "empty" until its creator's connection lands.
    this.emptySince = this.createdAt;
    this.log('room_created', {});
    this.rebalanceBots();
  }

  // ------------------------------------------------------------------ queries

  humansConnected() {
    let n = 0;
    for (const p of this.players.values()) if (p.conn) n++;
    return n;
  }

  /** Slots a newcomer could take: free slots plus bots holding no reservation. */
  openSlots() {
    const max = this.world.cfg.maxTanksPerRoom;
    return max - this.world.tanks.size + this.unreservedBots().length;
  }

  hasSession(session: string) {
    return this.players.has(session);
  }

  private ownerOf(tankId: number): Player | undefined {
    for (const p of this.players.values()) if (p.tankId === tankId) return p;
    return undefined;
  }

  private unreservedBots(): Tank[] {
    return [...this.world.tanks.values()].filter((t) => t.controller === 'bot' && !this.ownerOf(t.id));
  }

  // ------------------------------------------------------------------ joining and leaving

  join(conn: Conn, session: string, requestedName: string, device: Device): JoinResult {
    const now = this.deps.now();
    const existing = this.players.get(session);
    if (existing) {
      if (existing.conn && existing.conn !== conn) {
        existing.conn.send(JSON.stringify({ t: 'error', code: 'replaced', message: 'Opened in another tab.' } satisfies ServerMessage));
        existing.conn.close(4000, 'replaced');
      }
      const wasAway = !existing.conn;
      existing.conn = conn;
      existing.device = device;
      existing.connectedAt = now;
      existing.reservedUntil = Infinity;
      let reclaimed = false;
      if (existing.tankId !== null && this.world.tanks.has(existing.tankId)) {
        this.world.setController(existing.tankId, 'human');
        reclaimed = wasAway;
      } else {
        existing.tankId = null;
      }
      this.log('reclaim', { pid: existing.pid, success: existing.tankId !== null, device });
      if (existing.tankId === null) {
        const r = this.seatNewcomer(existing);
        if (!r) return { ok: false, code: 'room-full', message: 'Room is full.' };
      }
      this.emptySince = null;
      this.rebalanceBots();
      this.markInfo(existing.tankId!);
      if (wasAway) this.announce(existing, 'arrive', `${existing.name} is back.`);
      return { ok: true, tankId: existing.tankId!, reclaimed, name: existing.name };
    }

    if (this.openSlots() <= 0) return { ok: false, code: 'room-full', message: 'Room is full.' };
    const wanted = this.acceptableName(requestedName);
    if (wanted) this.freeNameFromBots(wanted);
    const name = uniqueName(wanted ?? this.botName(), this.takenNames());
    const p: Player = {
      session,
      pid: pseudonym(session),
      name,
      conn,
      tankId: null,
      device,
      connectedAt: now,
      reservedUntil: Infinity,
      limiter: new RateLimiter(),
      lastRename: -Infinity,
      lastArrive: -Infinity,
      lastLeave: -Infinity,
      lastNotice: -Infinity,
    };
    if (!this.seatNewcomer(p)) return { ok: false, code: 'room-full', message: 'Room is full.' };
    this.players.set(session, p);
    this.emptySince = null;
    this.rebalanceBots();
    this.log('join', { pid: p.pid, device, tank: p.tankId });
    this.announce(p, 'arrive', `${p.name} joined.`);
    return { ok: true, tankId: p.tankId!, reclaimed: false, name: p.name };
  }

  /** A cleaned name that passes the filter, or null. */
  private acceptableName(raw: string): string | null {
    const name = cleanName(raw);
    if (!name) return null;
    try {
      return this.deps.moderator.screen(name).ok ? name : null;
    } catch {
      return null;
    }
  }

  /** Bots give up a name a person wants (they share the default name list). */
  private freeNameFromBots(name: string) {
    const lower = name.toLowerCase();
    for (const t of this.world.tanks.values()) {
      if (t.controller === 'bot' && !this.ownerOf(t.id) && t.name.toLowerCase() === lower) {
        t.name = this.botName();
        t.infoDirty = true;
      }
    }
  }

  private announce(p: Player, kind: 'arrive' | 'leave', text: string) {
    const now = this.deps.now();
    const key = kind === 'arrive' ? 'lastArrive' : 'lastLeave';
    if (now - p[key] < ANNOUNCE_COOLDOWN_MS) return;
    p[key] = now;
    this.systemChat(text);
  }

  /** Give a player a fresh tank: replace an unreserved bot, or take a free slot. */
  private seatNewcomer(p: Player): boolean {
    const w = this.world;
    const bots = this.unreservedBots();
    let id: number;
    if (bots.length) {
      // Prefer replacing a bot that is dead or still on its helicopter.
      const bot = bots.find((b) => b.phase === 'dead' || b.phase === 'carried') ?? bots[0];
      id = bot.id;
      w.removeTank(id);
      this.removed.push(id);
      this.log('bot_replaced', { tank: id });
    } else if (w.tanks.size < w.cfg.maxTanksPerRoom) {
      id = w.freeTankId();
    } else {
      return false;
    }
    const t = w.addTank({ id, name: p.name, controller: 'human' });
    p.tankId = t.id;
    return true;
  }

  disconnect(session: string, conn: Conn | null, reason: string) {
    const p = this.players.get(session);
    if (!p || (conn && p.conn !== conn)) return;
    const now = this.deps.now();
    p.conn = null;
    p.reservedUntil = this.kind === 'public' ? now + this.deps.publicReclaimMs : Infinity;
    if (p.tankId !== null && this.world.tanks.has(p.tankId)) {
      this.world.setController(p.tankId, 'bot');
      this.log('bot_handoff', { pid: p.pid, tank: p.tankId, reason, sessionMs: now - p.connectedAt, device: p.device });
    }
    this.log('disconnect', { pid: p.pid, reason, sessionMs: now - p.connectedAt, device: p.device });
    if (this.humansConnected() === 0) this.emptySince = now;
    this.markInfo(p.tankId);
    this.announce(p, 'leave', `${p.name} left. A bot is driving their tank.`);
  }

  /** Expire public reservations; returns true if the room should close. */
  housekeeping(): boolean {
    const now = this.deps.now();
    this.flushRateLimitCounts();
    let changed = false;
    for (const p of [...this.players.values()]) {
      if (!p.conn && now >= p.reservedUntil) {
        this.players.delete(p.session);
        this.log('reservation_expired', { pid: p.pid, tank: p.tankId });
        if (p.tankId !== null) this.markInfo(p.tankId);
        changed = true;
      }
    }
    if (changed) this.rebalanceBots();
    return this.emptySince !== null && now - this.emptySince >= this.deps.emptyRoomMs;
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.players.values()) {
      if (p.conn) {
        p.conn.send(JSON.stringify({ t: 'error', code: 'room-closed', message: 'This room has closed.' } satisfies ServerMessage));
        p.conn.close(4001, 'room closed');
      }
    }
    this.log('room_closed', { reason, lifetimeMs: this.deps.now() - this.createdAt });
  }

  /** Keep at least botMinTanks tanks; trim surplus unreserved bots. */
  rebalanceBots() {
    const w = this.world;
    let reserved = 0;
    for (const p of this.players.values()) if (p.tankId !== null) reserved++;
    const target = Math.min(w.cfg.maxTanksPerRoom, Math.max(w.cfg.botMinTanks, reserved));
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
    const taken = this.takenNames();
    const free = DEFAULT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
    return free.length ? this.rng.pick(free) : uniqueName(this.rng.pick(DEFAULT_NAMES), taken);
  }

  private takenNames() {
    const s = new Set<string>();
    for (const t of this.world.tanks.values()) s.add(t.name.toLowerCase());
    for (const p of this.players.values()) s.add(p.name.toLowerCase());
    return s;
  }

  // ------------------------------------------------------------------ messages

  handle(session: string, msg: ClientMessage) {
    const p = this.players.get(session);
    if (!p || !p.conn || p.tankId === null) return;
    const id = p.tankId;
    const w = this.world;
    const tank = w.tanks.get(id);
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
      case 'chat':
        this.chat(p, msg.text);
        return;
      case 'name':
        this.rename(p, msg.name);
        return;
      case 'ping':
        p.conn.send(JSON.stringify({ t: 'pong', at: msg.at, tick: w.tick } satisfies ServerMessage));
        return;
      case 'leave': {
        const conn = p.conn;
        this.disconnect(session, conn, 'left');
        conn.close(1000, 'left');
        return;
      }
      case 'hello':
        return;
    }
  }

  /** Rate-limited chat attempts since the last housekeeping, logged as counts (not text). */
  private rateLimited = { rapid: 0, repeat: 0 };

  private chat(p: Player, raw: string) {
    const now = this.deps.now();
    // The audit log keeps what was submitted, up to twice the accepted length.
    const submitted = raw.slice(0, MAX_CHAT_LENGTH * 2);
    const text = cleanText(submitted, MAX_CHAT_LENGTH + 1);
    const rate = p.limiter.check(now, text);
    if (rate !== 'ok') {
      this.rateLimited[rate]++;
      this.notice(p, rate === 'repeat' ? 'You just sent that.' : 'Slow down a little.');
      return;
    }
    const msgId = randomUUID();
    const base = { room: this.code, roomKind: this.kind, msgId, sender: p.pid, senderName: p.name, text: submitted, ruleVersion: RULE_VERSION };
    let result;
    try {
      result = this.deps.moderator.screen(text);
    } catch (err) {
      this.deps.log.chat({ ...base, outcome: 'error', reason: String(err) });
      this.deps.log.event('moderation_failure', { room: this.code });
      this.notice(p, "Couldn't send that. Please try again.");
      return;
    }
    const tank = p.tankId !== null ? this.world.tanks.get(p.tankId) : undefined;
    const msg: ChatMessage = { id: msgId, from: p.name, color: tank?.color ?? 0, text: text.trim(), at: now };
    if (!result.ok) {
      this.deps.log.chat({ ...base, outcome: 'blocked', reason: result.reason });
      if (result.reason === 'too-long') this.notice(p, `Messages are limited to ${MAX_CHAT_LENGTH} characters.`);
      else if (result.reason !== 'empty') p.conn?.send(JSON.stringify({ t: 'chat', msg } satisfies ServerMessage));
      return;
    }
    this.deps.log.chat({ ...base, outcome: 'delivered' });
    this.pushHistory(msg);
    this.broadcast({ t: 'chat', msg });
  }

  private rename(p: Player, raw: string) {
    const now = this.deps.now();
    if (now - p.lastRename < RENAME_COOLDOWN_MS) {
      p.conn?.send(JSON.stringify({ t: 'name', name: p.name } satisfies ServerMessage));
      this.notice(p, 'Wait a few seconds before renaming again.');
      return;
    }
    const name = this.acceptableName(raw);
    if (name) this.freeNameFromBots(name);
    if (!name) {
      p.conn?.send(JSON.stringify({ t: 'name', name: p.name } satisfies ServerMessage));
      this.notice(p, "That name isn't allowed.");
      return;
    }
    p.lastRename = now;
    const taken = this.takenNames();
    taken.delete(p.name.toLowerCase());
    const tank = p.tankId !== null ? this.world.tanks.get(p.tankId) : undefined;
    if (tank) taken.delete(tank.name.toLowerCase());
    const unique = uniqueName(name, taken);
    const old = p.name;
    p.name = unique;
    if (tank) {
      tank.name = unique;
      tank.infoDirty = true;
    }
    p.conn?.send(JSON.stringify({ t: 'name', name: unique } satisfies ServerMessage));
    if (old !== unique) this.systemChat(`${old} is now ${unique}.`);
  }

  private pushHistory(msg: ChatMessage) {
    this.chatHistory.push(msg);
    while (this.chatHistory.length > this.deps.chatHistorySize) this.chatHistory.shift();
  }

  private systemChat(text: string) {
    const msg: ChatMessage = { id: randomUUID(), from: '', color: -1, text, at: this.deps.now(), system: true };
    this.pushHistory(msg);
    this.broadcast({ t: 'chat', msg });
  }

  private sendSystem(p: Player, text: string) {
    const msg: ChatMessage = { id: randomUUID(), from: '', color: -1, text, at: this.deps.now(), system: true };
    p.conn?.send(JSON.stringify({ t: 'chat', msg } satisfies ServerMessage));
  }

  /** A private notice, at most one every 2 seconds so a flood can't echo back a flood. */
  private notice(p: Player, text: string) {
    const now = this.deps.now();
    if (now - p.lastNotice < 2000) return;
    p.lastNotice = now;
    this.sendSystem(p, text);
  }

  /** Log rate-limited chat as counts so spam can't flood the audit log. */
  flushRateLimitCounts() {
    const { rapid, repeat } = this.rateLimited;
    if (rapid + repeat === 0) return;
    this.deps.log.chat({ room: this.code, roomKind: this.kind, outcome: 'rate-limited-summary', rapid, repeat, ruleVersion: RULE_VERSION });
    this.rateLimited = { rapid: 0, repeat: 0 };
  }

  // ------------------------------------------------------------------ simulation + sync

  private markInfo(tankId: number | null) {
    if (tankId === null) return;
    const t = this.world.tanks.get(tankId);
    if (t) t.infoDirty = true;
  }

  private info(t: Tank): TankInfo {
    const owner = this.ownerOf(t.id);
    return tankInfo(t, owner ? owner.name : null, !!owner && !owner.conn);
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
      chat: this.chatHistory.slice(),
    };
  }

  welcome(session: string, r: Extract<JoinResult, { ok: true }>): ServerMessage {
    return {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      session,
      name: r.name,
      tankId: r.tankId,
      reclaimed: r.reclaimed,
      room: { code: this.code, kind: this.kind },
      config: this.world.cfg,
      snapshot: this.snapshot(),
    };
  }

  /** Advance one tick. Returns the tick duration in ms. */
  step(): number {
    const start = performance.now();
    const w = this.world;
    const events = w.step();
    if (events.length) {
      this.pending.push(...events);
      this.logGameEvents(events);
    }
    if (w.tick % w.cfg.stateEvery === 0) this.flush();
    return performance.now() - start;
  }

  private flush() {
    const w = this.world;
    if (this.removed.length) {
      this.broadcast({ t: 'removed', tanks: this.removed });
      this.removed = [];
    }
    const dirty: TankInfo[] = [];
    for (const t of w.tanks.values()) {
      if (t.infoDirty) {
        t.infoDirty = false;
        dirty.push(this.info(t));
      }
    }
    if (dirty.length) this.broadcast({ t: 'info', tanks: dirty });
    if (this.pending.length) {
      this.broadcast({ t: 'events', tick: w.tick, events: this.pending });
      this.pending = [];
    }
    this.broadcast({ t: 'state', tick: w.tick, dyn: [...w.tanks.values()].map(tankDyn), helis: heliDyns(w) });
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) p.conn?.send(data);
  }

  private log(type: string, fields: Record<string, unknown>) {
    this.deps.log.event(type, { room: this.code, roomKind: this.kind, ...fields });
  }

  private logGameEvents(events: GameEvent[]) {
    const humans = this.humansConnected();
    for (const e of events) {
      switch (e.type) {
        case 'fire':
          this.log('shot', { tank: e.tank, spread: e.spread, controller: e.controller, level: e.level, humans });
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
          this.log(type, { ...rest, runId: t?.runId, humans });
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
