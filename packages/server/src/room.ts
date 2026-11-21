import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  cleanName,
  cleanText,
  DEFAULT_CONFIG,
  freshName,
  GAME_NAMES,
  canPlayPrivately,
  CHAT_FILTER_LABELS,
  type ChatFilterMode,
  INVITE_TOKEN_ALPHABET,
  INVITE_TOKEN_LENGTH,
  isSeated,
  PROTOCOL_VERSION,
  SEAT_COUNT,
  Rng,
  uniqueName,
  type ChatMessage,
  type ClientMessage,
  type Device,
  type GameConfig,
  type GameId,
  type GameServerMessage,
  type MemberInfo,
  type RoomKind,
  type ServerMessage,
  type TableInfo,
  type TableSetup,
  type VoicePeer,
  type VoiceSettings,
} from '@tank/shared';
import { MAX_CHAT_LENGTH, RateLimiter, RULE_VERSION, type ChatModerator } from './chat';
import type { LogSink } from './eventlog';
import { HeartsGame } from './games/hearts';
import { SpadesGame } from './games/spades';
import { DominoesGame } from './games/dominoes';
import { JigsawGame } from './games/jigsaw';
import { PuzzleStore } from './puzzleStore';
import { TanksGame } from './games/tanks';
import type { Conn, GameHost, Member, ServerGame } from './games/types';

export type { Conn } from './games/types';

/** A coturn-style TURN relay that accepts short-lived credentials signed with a shared secret. */
export interface TurnSettings {
  urls: string[];
  secret: string;
  /** How long issued credentials stay valid. */
  ttlSeconds: number;
}

export interface RoomDeps {
  now: () => number;
  log: LogSink;
  moderator: ChatModerator;
  /** Room closes this long after the last human leaves. */
  emptyRoomMs: number;
  /**
   * A table with people still connected closes after this long with nobody playing or talking
   * (someone who left a game open and walked away). Everyone gets IDLE_WARNING_MS of warning.
   */
  idleRoomMs?: number;
  /** Public-room reclaim window. Private rooms hold reservations for the room's lifetime. */
  publicReclaimMs: number;
  cfg?: Partial<GameConfig>;
  seed?: number;
  chatHistorySize: number;
  /** STUN/TURN servers handed to voice chat clients. */
  iceServers?: VoiceSettings['iceServers'];
  /** Our own TURN relay, if configured: each player gets their own expiring credentials. */
  turn?: TurnSettings;
  /** Random integers for card shuffles (crypto by default). */
  randomInt?: (n: number) => number;
  /** Where jigsaw puzzles are saved (in memory if not given). */
  puzzles?: PuzzleStore;
}

/** Default idle time before a table closes, and the warning before it does. */
export const IDLE_ROOM_MS = 10 * 60_000;
export const IDLE_WARNING_MS = 60_000;

/** Chat reports per player per minute. */
export const REPORTS_PER_MINUTE = 5;
/** One rename per this many ms. */
export const RENAME_COOLDOWN_MS = 10_000;
/** Join/leave/back notices for the same player at most this often. */
export const ANNOUNCE_COOLDOWN_MS = 20_000;
/**
 * Someone who drops out and is back within this long (a page reload, a phone waking up) never
 * shows as having left: "Liz left." is only posted if they're still gone after it.
 */
export const QUIET_DROP_MS = 10_000;
/** Three caught messages within a minute pause that player's chat for 30 seconds. */
export const CAUGHT_LIMIT = 3;
export const CAUGHT_WINDOW_MS = 60_000;
export const CHAT_PAUSE_MS = 30_000;
/** Invite links a room keeps (the oldest goes first). */
export const MAX_INVITES = 40;

interface Player extends Member {
  name: string;
  conn: Conn | null;
  device: Device;
  connectedAt: number;
  /** When a disconnected player's reservation ends (Infinity in private rooms). */
  reservedUntil: number;
  /** When they dropped out (null while connected). */
  awaySince: number | null;
  limiter: RateLimiter;
  lastRename: number;
  /** Last arrival / departure notice, so reconnect loops cannot spam chat. */
  lastArrive: number;
  lastLeave: number;
  /** "Liz left." waiting to be posted (see QUIET_DROP_MS), and whether it was. */
  pendingLeave: { at: number; text: string } | null;
  leaveAnnounced: boolean;
  lastNotice: number;
  inVoice: boolean;
  reportTimes: number[];
  /** The current connection has been sent its welcome (game messages wait for it). */
  welcomed: boolean;
  /** When the chat filter caught this player's recent messages (for the timeout). */
  caughtTimes: number[];
  /** Chat is paused until then after too many caught messages. */
  chatPausedUntil: number;
  /** Voice links this player has told us about ("alias:route"), so each is logged once. */
  voiceRoutes: Set<string>;
  /** Last time they played, typed, tapped or talked (for closing idle tables). */
  lastActive: number;
}

/**
 * One game, from when it starts until it ends (back to the lobby, or the room closes): how long
 * people played and how many at once. Logged as one `game_session` line for the admin page.
 */
interface GameSession {
  game: GameId;
  startedAt: number;
  /** Last time the counts below were brought up to date. */
  lastAt: number;
  /** Time with at least one person connected, and with two or more. */
  activeMs: number;
  groupMs: number;
  /** People × time: two people for an hour is two person-hours. */
  personMs: number;
  peak: number;
  /** Everyone who played some of it (pseudonyms). */
  pids: Set<string>;
  chats: number;
}

export type JoinResult = { ok: true; reclaimed: boolean; name: string } | { ok: false; code: 'room-full'; message: string };

/** A device number as it goes in the logs: scrambled, so the logs never hold the number itself. */
export function devicePseudonym(deviceId: string) {
  return createHash('sha256').update('gd-device:' + deviceId).digest('hex').slice(0, 16);
}

export function pseudonym(session: string) {
  return createHash('sha256').update('tank-pid:' + session).digest('hex').slice(0, 16);
}

/**
 * A room is a group of people (the "party") with chat and voice, playing one game at a time.
 * Public rooms always play tanks. Private rooms open on a lobby where anyone picks the game,
 * and chat and voice carry on across games.
 */
export class Room {
  readonly players = new Map<string, Player>();
  readonly chatHistory: ChatMessage[] = [];
  readonly createdAt: number;
  game: ServerGame | null = null;
  private session: GameSession | null = null;
  emptySince: number | null;
  closed = false;
  private rng: Rng;
  /** How swearing in chat is handled. Public rooms always block; private rooms start on hide. */
  chatFilter: ChatFilterMode;
  private readonly cfg: GameConfig;
  private host: GameHost;
  /** Invite links made here: token -> who made it (session) and the name it's for. */
  private readonly invites = new Map<string, { session: string; for: string | null }>();
  /** Whoever started the table (the first to join): named on the join page for a bare code. */
  private starter: string | null = null;
  private readonly inviteTimes = new Map<string, number[]>();
  /**
   * Between games (private tables): the game picked to play next, who picked which seat
   * (sessions; seated games only) and who is ready. It starts once everyone here is ready.
   */
  private setup: { pick: GameId | null; seats: (string | null)[]; ready: Set<string> } = { pick: null, seats: [], ready: new Set() };

  constructor(
    readonly code: string,
    readonly kind: RoomKind,
    private deps: RoomDeps,
    /** The game it opens on. Public rooms always have one (tanks if not given); private rooms
     *  open on the lobby unless created from a game's page. */
    firstGame?: GameId,
  ) {
    this.rng = new Rng((deps.seed ?? randomInt(2 ** 31)) ^ 0x2c1b3c6d);
    this.chatFilter = kind === 'public' ? 'block' : 'hide';
    this.cfg = { ...DEFAULT_CONFIG, ...deps.cfg };
    this.createdAt = deps.now();
    // A brand-new room is "empty" until its creator's connection lands.
    this.emptySince = this.createdAt;
    this.host = this.makeHost();
    this.log('room_created', {});
    if (kind === 'public') {
      // Public tables go straight into their game (Tanks unless another was asked for).
      const first = firstGame ?? 'tanks';
      this.game = this.makeGame(first);
      this.beginSession(first);
    } else if (firstGame) {
      // Private tables open at the table, with this game picked: people gather, take seats and
      // start it together once everyone is ready.
      this.setPick(firstGame);
    }
  }

  // ------------------------------------------------------------------ play time, for the admin page

  private beginSession(game: GameId) {
    const now = this.deps.now();
    this.session = { game, startedAt: now, lastAt: now, activeMs: 0, groupMs: 0, personMs: 0, peak: 0, pids: new Set(), chats: 0 };
    this.countPeople();
  }

  /** Add up the time since the last change, at the old head count. Call before anyone comes or goes. */
  private accrue() {
    const s = this.session;
    if (!s) return;
    const now = this.deps.now();
    const dt = Math.max(0, now - s.lastAt);
    const n = this.humansConnected();
    s.personMs += n * dt;
    if (n >= 1) s.activeMs += dt;
    if (n >= 2) s.groupMs += dt;
    s.lastAt = now;
  }

  /** Note who's here now. Call after anyone comes or goes. */
  private countPeople() {
    const s = this.session;
    if (!s) return;
    s.peak = Math.max(s.peak, this.humansConnected());
    for (const p of this.players.values()) if (p.conn && s.pids.size < 50) s.pids.add(p.pid);
  }

  private endSession(endedBy: 'lobby' | 'room_closed') {
    const s = this.session;
    if (!s) return;
    this.accrue();
    this.session = null;
    this.log('game_session', {
      game: s.game,
      endedBy,
      ms: this.deps.now() - s.startedAt,
      activeMs: s.activeMs,
      groupMs: s.groupMs,
      personMs: s.personMs,
      peak: s.peak,
      players: s.pids.size,
      pids: [...s.pids],
      chats: s.chats,
    });
  }

  private makeGame(id: GameId): ServerGame {
    if (id === 'hearts') return new HeartsGame(this.host);
    if (id === 'spades') return new SpadesGame(this.host);
    if (id === 'dominoes') return new DominoesGame(this.host);
    if (id === 'jigsaw') return new JigsawGame(this.host, (this.deps.puzzles ??= new PuzzleStore(null)));
    return new TanksGame(this.host, { cfg: this.deps.cfg, seed: this.deps.seed });
  }

  private makeHost(): GameHost {
    const room = this;
    return {
      code: this.code,
      kind: this.kind,
      now: () => this.deps.now(),
      members: () => [...this.players.values()],
      member: (session) => this.players.get(session),
      send: (to, msg) => {
        const p = this.players.get(to.session);
        if (p?.conn && p.welcomed) p.conn.send(JSON.stringify({ t: 'g', m: msg } satisfies ServerMessage));
      },
      broadcast: (msg: GameServerMessage) => this.broadcast({ t: 'g', m: msg }),
      systemChat: (text) => this.systemChat(text),
      log: (type, fields) => room.log(type, { game: room.game?.id, ...fields }),
      randomInt: (n) => (this.deps.randomInt ?? randomInt)(n),
    };
  }

  /** The tank game, when that's what the room is playing. */
  get tanks(): TanksGame | null {
    return this.game instanceof TanksGame ? this.game : null;
  }

  // ------------------------------------------------------------------ queries

  humansConnected() {
    let n = 0;
    for (const p of this.players.values()) if (p.conn) n++;
    return n;
  }

  /** People the room holds: the tank cap in public rooms (bots make way), and for parties. */
  capacity() {
    return this.cfg.maxTanksPerRoom;
  }

  /** Places a newcomer could take: the free ones, and any that people gone a while give up. */
  openSlots() {
    return this.capacity() - this.players.size + this.makingWay().length;
  }

  /**
   * At a private table, someone who dropped out and is still gone after QUIET_DROP_MS (the table
   * has said "Liz left.") keeps their place only until someone new needs it: longest gone first.
   * Otherwise a few dropped phones (each coming back in a new tab, as a new person) fill the table.
   */
  private makingWay(now = this.deps.now()) {
    if (this.kind !== 'private') return [];
    return [...this.players.values()]
      .filter((p) => !p.conn && p.awaySince !== null && now - p.awaySince >= QUIET_DROP_MS)
      .sort((a, b) => a.awaySince! - b.awaySince!);
  }

  /** Take someone off the table for good: their place, seat and readiness go to others. */
  private removeForGood(p: Player, logAs?: string) {
    this.players.delete(p.session);
    // So a leave-and-rejoin loop still only gets a notice now and then (ANNOUNCE_COOLDOWN_MS).
    this.goneNotices.set(p.session, { arrive: p.lastArrive, leave: p.lastLeave });
    if (this.goneNotices.size > 64) this.goneNotices.delete(this.goneNotices.keys().next().value!);
    if (this.forgetAtTable(p.session)) this.broadcastTable();
    this.game?.removePlayer(p);
    if (logAs) this.log(logAs, { pid: p.pid });
  }

  /** When people who've gone for good last had a join or leave notice (session -> times). */
  private readonly goneNotices = new Map<string, { arrive: number; leave: number }>();

  hasSession(session: string) {
    return this.players.has(session);
  }

  members(): MemberInfo[] {
    return [...this.players.values()].map((p) => ({ id: p.alias, name: p.name, color: p.color, connected: !!p.conn }));
  }

  // ------------------------------------------------------------------ joining and leaving

  join(conn: Conn, session: string, requestedName: string, device: Device, deviceId?: string): JoinResult {
    const now = this.deps.now();
    const existing = this.players.get(session);
    if (existing) {
      if (existing.conn && existing.conn !== conn) {
        existing.conn.send(JSON.stringify({ t: 'error', code: 'replaced', message: 'Opened in another tab.' } satisfies ServerMessage));
        existing.conn.close(4000, 'replaced');
      }
      const wasAway = !existing.conn;
      this.accrue();
      if (existing.inVoice) {
        // A new connection starts outside voice; the old peer connections are gone.
        existing.inVoice = false;
        this.broadcastVoice();
      }
      existing.conn = conn;
      existing.welcomed = false;
      existing.lastActive = now;
      existing.device = device;
      existing.connectedAt = now;
      existing.reservedUntil = Infinity;
      existing.awaySince = null;
      const seatBack = this.game ? this.game.reconnect(existing) : true;
      this.countPeople();
      this.emptySince = null;
      // Back quickly: nothing was said, so nothing to say. Back after "Liz left.": say so.
      existing.pendingLeave = null;
      if (wasAway && existing.leaveAnnounced) this.announce(existing, 'arrive', `${existing.name} is back.`);
      existing.leaveAnnounced = false;
      this.broadcastMembers();
      return { ok: true, reclaimed: wasAway && seatBack, name: existing.name };
    }

    if (this.players.size >= this.capacity()) {
      const gone = this.makingWay(now)[0];
      if (!gone) return { ok: false, code: 'room-full', message: 'Room is full.' };
      // Their "left" notice first, if housekeeping hasn't got to it yet.
      this.postPendingLeaves(now);
      this.removeForGood(gone, 'made_way');
    }
    const wanted = this.acceptableName(requestedName);
    const name = uniqueName(wanted ?? this.randomName(), this.takenNames());
    this.accrue();
    const notices = this.goneNotices.get(session);
    this.goneNotices.delete(session);
    const p: Player = {
      session,
      pid: pseudonym(session),
      name,
      conn,
      device,
      color: this.freeColor(),
      connectedAt: now,
      reservedUntil: Infinity,
      awaySince: null,
      limiter: new RateLimiter(),
      lastRename: -Infinity,
      lastArrive: notices?.arrive ?? -Infinity,
      lastLeave: notices?.leave ?? -Infinity,
      pendingLeave: null,
      leaveAnnounced: false,
      lastNotice: -Infinity,
      alias: this.newAlias(),
      inVoice: false,
      reportTimes: [],
      welcomed: false,
      caughtTimes: [],
      chatPausedUntil: 0,
      voiceRoutes: new Set(),
      lastActive: now,
    };
    this.players.set(session, p);
    if (this.game && !this.game.addPlayer(p)) {
      this.players.delete(session);
      return { ok: false, code: 'room-full', message: 'Room is full.' };
    }
    this.starter ??= session;
    this.countPeople();
    this.emptySince = null;
    // did: the browser's device number, scrambled, so the admin page counts devices, not tabs.
    this.log('join', { pid: p.pid, device, ...(deviceId && { did: devicePseudonym(deviceId) }) });
    this.announce(p, 'arrive', `${p.name} is here.`);
    this.broadcastMembers();
    return { ok: true, reclaimed: false, name: p.name };
  }

  /** A cleaned name that passes the filter, or null. */
  private acceptableName(raw: string): string | null {
    const name = cleanName(raw);
    if (!name) return null;
    try {
      // Names follow people into public games, so they're held to the strictest setting.
      return this.deps.moderator.screen(name, 'block').ok ? name : null;
    } catch {
      return null;
    }
  }

  private announce(p: Player, kind: 'arrive' | 'leave', text: string) {
    const now = this.deps.now();
    const key = kind === 'arrive' ? 'lastArrive' : 'lastLeave';
    if (now - p[key] < ANNOUNCE_COOLDOWN_MS) return;
    p[key] = now;
    this.systemChat(text, { kind, alias: p.alias });
  }

  disconnect(session: string, conn: Conn | null, reason: string) {
    const p = this.players.get(session);
    if (!p || (conn && p.conn !== conn)) return;
    const now = this.deps.now();
    this.accrue();
    p.conn = null;
    p.welcomed = false;
    p.awaySince = now;
    if (p.inVoice) {
      p.inVoice = false;
      this.broadcastVoice();
    }
    this.log('disconnect', { pid: p.pid, reason, sessionMs: now - p.connectedAt, device: p.device });
    if (reason === 'left') {
      // Leaving on purpose (Leave table) is said straight away, and gives up your place, your
      // seat and your readiness for good: coming back is joining again.
      this.announce(p, 'leave', `${p.name} left.`);
      this.removeForGood(p);
    } else {
      p.reservedUntil = this.kind === 'public' ? now + this.deps.publicReclaimMs : Infinity;
      const note = this.game?.disconnect(p, reason) ?? null;
      // Posted by housekeeping once they've been gone QUIET_DROP_MS (a quick reload says nothing).
      p.pendingLeave = { at: now, text: note ? `${p.name} left. ${note}` : `${p.name} left.` };
      p.leaveAnnounced = false;
    }
    if (this.humansConnected() === 0) this.emptySince = now;
    this.broadcastMembers();
    // At the table, someone gone doesn't hold up the start.
    if (!this.game) this.startIfReady();
  }

  /** "Liz left." for anyone still gone QUIET_DROP_MS after dropping out. */
  postPendingLeaves(now = this.deps.now()) {
    for (const p of this.players.values()) {
      if (!p.pendingLeave || p.conn || now - p.pendingLeave.at < QUIET_DROP_MS) continue;
      const { text } = p.pendingLeave;
      p.pendingLeave = null;
      // A reconnect loop still only says so now and then (ANNOUNCE_COOLDOWN_MS).
      const before = p.lastLeave;
      this.announce(p, 'leave', text);
      p.leaveAnnounced = p.lastLeave !== before;
    }
  }

  private idleWarned = false;

  private markActive(p: Player) {
    p.lastActive = this.deps.now();
    if (this.idleWarned) {
      this.idleWarned = false;
      this.broadcast({ t: 'idle', closesInMs: null });
    }
  }

  /** Expire public reservations; returns why the room should close (empty, or idle), or false. */
  housekeeping(): false | 'empty' | 'idle' {
    const now = this.deps.now();
    this.flushRateLimitCounts();
    this.postPendingLeaves(now);
    let changed = false;
    for (const p of [...this.players.values()]) {
      if (!p.conn && now >= p.reservedUntil) {
        this.removeForGood(p, 'reservation_expired');
        changed = true;
      }
    }
    if (changed) this.broadcastMembers();
    if (this.emptySince !== null) return now - this.emptySince >= this.deps.emptyRoomMs ? 'empty' : false;
    // People are connected: close it if none of them has played or talked for a long while,
    // after a minute's warning (anything anyone does in that minute keeps it open).
    const idleMs = this.deps.idleRoomMs ?? IDLE_ROOM_MS;
    let last = -Infinity;
    for (const p of this.players.values()) if (p.conn) last = Math.max(last, p.lastActive);
    const quiet = now - last;
    if (quiet >= idleMs) return 'idle';
    if (quiet >= idleMs - IDLE_WARNING_MS && !this.idleWarned) {
      this.idleWarned = true;
      this.broadcast({ t: 'idle', closesInMs: idleMs - quiet });
      this.log('idle_warning', {});
    }
    return false;
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.endSession('room_closed');
    this.game?.dispose();
    // The table's messages go with it.
    this.chatHistory.length = 0;
    this.recentMessages.clear();
    const minutes = Math.round((this.deps.idleRoomMs ?? IDLE_ROOM_MS) / 60_000);
    const message = reason === 'idle' ? `This table closed after ${minutes} minute${minutes === 1 ? '' : 's'} with nobody playing or talking.` : 'This room has closed.';
    for (const p of this.players.values()) {
      if (p.conn) {
        p.conn.send(JSON.stringify({ t: 'error', code: 'room-closed', message } satisfies ServerMessage));
        p.conn.close(4001, 'room closed');
      }
    }
    this.log('room_closed', { reason, lifetimeMs: this.deps.now() - this.createdAt });
  }

  private randomName() {
    const taken = this.takenNames();
    return freshName(taken, this.rng);
  }

  private takenNames() {
    const s = new Set<string>();
    for (const p of this.players.values()) s.add(p.name.toLowerCase());
    return s;
  }

  private freeColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    for (let i = 0; i < 10; i++) if (!used.has(i)) return i;
    return 0;
  }

  // ------------------------------------------------------------------ games

/** Anyone at the table picks the game to play next. Seats and readiness start over. */
  private pickGame(p: Player, id: GameId) {
    if (this.kind !== 'private') return;
    if (!canPlayPrivately(id)) {
      this.notice(p, 'That game isn’t available right now.');
      return;
    }
    if (this.game) {
      this.notice(p, 'Go back to the table to pick another game.');
      return;
    }
    if (this.setup.pick === id) return;
    this.setPick(id);
    this.systemChat(`${p.name} picked ${GAME_NAMES[id]}.`);
    this.broadcastTable();
  }

  private setPick(id: GameId | null) {
    this.setup = { pick: id, seats: isSeated(id) ? Array<string | null>(SEAT_COUNT).fill(null) : [], ready: new Set() };
  }

  /** Sit at a seat for the picked game (Hearts, Spades, Dominoes); moving leaves your old one. */
  private sit(p: Player, seat: number) {
    if (this.game || !isSeated(this.setup.pick) || seat < 0 || seat >= SEAT_COUNT) return;
    const holder = this.setup.seats[seat];
    if (holder === p.session) return;
    const other = holder ? this.players.get(holder) : undefined;
    if (other) {
      this.notice(p, `${other.name} is sitting there.`);
      return;
    }
    this.setup.seats = this.setup.seats.map((s) => (s === p.session ? null : s));
    this.setup.seats[seat] = p.session;
    this.broadcastTable();
  }

  private setReady(p: Player, ready: boolean) {
    if (this.game || !this.setup.pick) return;
    if (ready) this.setup.ready.add(p.session);
    else this.setup.ready.delete(p.session);
    this.broadcastTable();
    this.startIfReady();
  }

  /**
   * Everyone at the table right now has said they're ready: start the picked game. (Someone who
   * dropped out doesn't hold it up; their seat is played for them until they're back.)
   */
  private startIfReady() {
    const pick = this.setup.pick;
    if (this.game || !pick || this.kind !== 'private') return;
    const here = [...this.players.values()].filter((m) => m.conn);
    if (!here.length || !here.every((m) => this.setup.ready.has(m.session))) return;
    this.startGame(pick);
  }

  private startGame(id: GameId) {
    const seats = this.setup.seats;
    this.setPick(null);
    this.game = this.makeGame(id);
    this.beginSession(id);
    this.broadcastTable();
    this.broadcast({ t: 'game', game: id });
    // People who picked a seat sit there; everyone else takes a free one; the computer plays the rest.
    const members = [...this.players.values()];
    const chosen = (m: Player) => {
      const i = seats.indexOf(m.session);
      return i >= 0 ? i : undefined;
    };
    for (const m of members) if (chosen(m) !== undefined) this.game.addPlayer(m, chosen(m));
    for (const m of members) if (chosen(m) === undefined) this.game.addPlayer(m);
    for (const m of members) if (m.conn && m.welcomed) this.game.sendInit(m, false);
    this.systemChat(`Everyone’s ready: ${GAME_NAMES[id]} is starting.`);
    this.log('game_start', { game: id, humans: this.humansConnected() });
  }

  tableSetup(): TableSetup {
    const alias = (s: string | null) => (s ? (this.players.get(s)?.alias ?? null) : null);
    return {
      pick: this.setup.pick,
      seats: this.setup.seats.map(alias),
      ready: [...this.setup.ready].map((s) => this.players.get(s)?.alias).filter((a): a is string => !!a),
    };
  }

  private broadcastTable() {
    this.broadcast({ t: 'table', table: this.tableSetup() });
  }

  /** Someone left for good: free their seat and readiness at the table. */
  private forgetAtTable(session: string) {
    const had = this.setup.ready.delete(session) || this.setup.seats.includes(session);
    this.setup.seats = this.setup.seats.map((s) => (s === session ? null : s));
    return had;
  }

  private endGame(p: Player) {
    // (No cooldown: a game only starts again once everyone at the table is ready.)
    if (this.kind !== 'private' || !this.game) return;
    const id = this.game.id;
    this.endSession('lobby');
    this.game.dispose();
    this.game = null;
    this.setPick(null);
    this.broadcastTable();
    this.broadcast({ t: 'game', game: null });
    this.systemChat(`${p.name} ended ${GAME_NAMES[id]}. Pick a game to play next.`);
    this.log('game_end', { game: id, by: p.pid });
  }

  // ------------------------------------------------------------------ messages

  handle(session: string, msg: ClientMessage) {
    const p = this.players.get(session);
    if (!p || !p.conn) return;
    // Anything a person does keeps the table open (not the background heartbeat or voice set-up).
    if (msg.t !== 'ping' && msg.t !== 'rtc' && msg.t !== 'voice-route') this.markActive(p);
    switch (msg.t) {
      case 'active':
        return;
      case 'g':
        this.game?.handle(p, msg.m);
        return;
      case 'chat':
        this.chat(p, msg.text);
        return;
      case 'name':
        this.rename(p, msg.name);
        return;
      case 'ping':
        p.conn.send(JSON.stringify({ t: 'pong', at: msg.at } satisfies ServerMessage));
        return;
      case 'leave': {
        const conn = p.conn;
        this.disconnect(session, conn, 'left');
        conn.close(1000, 'left');
        return;
      }
      case 'report':
        this.report(p, msg.msgId);
        return;
      case 'voice':
        this.setVoice(p, msg.join);
        return;
      case 'rtc': {
        // Relay WebRTC set-up only between voice members of this room.
        if (!p.inVoice) return;
        const to = [...this.players.values()].find((o) => o.alias === msg.to);
        if (!to || to === p || !to.inVoice || !to.conn) return;
        to.conn.send(JSON.stringify({ t: 'rtc', from: p.alias, data: msg.data } satisfies ServerMessage));
        return;
      }
      case 'pick':
        this.pickGame(p, msg.game);
        return;
      case 'sit':
        this.sit(p, msg.seat);
        return;
      case 'ready':
        this.setReady(p, msg.ready);
        return;
      case 'lobby':
        this.endGame(p);
        return;
      case 'filter':
        this.setChatFilter(p, msg.mode);
        return;
      case 'invite':
        this.makeInvite(p, msg.for);
        return;
      case 'voice-route': {
        // How a voice link connected, for the admin page: logged once per link and outcome.
        if (!p.inVoice) return;
        const to = [...this.players.values()].find((o) => o.alias === msg.to);
        const key = `${msg.to}:${msg.route}`;
        if (!to || to === p || p.voiceRoutes.has(key) || p.voiceRoutes.size >= 30) return;
        p.voiceRoutes.add(key);
        this.log('voice_link', { pid: p.pid, route: msg.route });
        return;
      }
      case 'hello':
        return;
    }
  }

  // ------------------------------------------------------------------ invites and the join page

  /**
   * An invite link from `p`, optionally for one named person. The link carries only a random
   * token; who sent it and who it's for stay here, so the join page shows names the server
   * vouches for. Tokens last as long as the room.
   */
  private makeInvite(p: Player, forName: string | null) {
    if (this.kind !== 'private') return;
    // At most 10 new links a minute each, so nobody can push everyone else's links out.
    const now = this.deps.now();
    const times = (this.inviteTimes.get(p.session) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= 10) return;
    times.push(now);
    this.inviteTimes.set(p.session, times);
    const wanted = forName === null ? null : this.acceptableName(forName);
    // One token per sender and name: inviting Liz twice gives the same link.
    let token = [...this.invites].find(([, v]) => v.session === p.session && v.for === wanted)?.[0];
    if (!token) {
      if (this.invites.size >= MAX_INVITES) this.invites.delete(this.invites.keys().next().value!);
      do {
        token = '';
        for (let i = 0; i < INVITE_TOKEN_LENGTH; i++) token += INVITE_TOKEN_ALPHABET[randomInt(INVITE_TOKEN_ALPHABET.length)];
      } while (this.invites.has(token));
      this.invites.set(token, { session: p.session, for: wanted });
    }
    p.conn?.send(JSON.stringify({ t: 'invite', token, for: wanted } satisfies ServerMessage));
  }

  /** What the join page shows for this table (and an invite token, if the link had one). */
  tableInfo(token: string | null): TableInfo {
    const invite = token ? this.invites.get(token) : undefined;
    // The sender's current name (they may have changed it); if they've gone, whoever started the table.
    const sender = invite ? this.players.get(invite.session) : undefined;
    const starter = this.starter ? this.players.get(this.starter) : undefined;
    const from = sender?.name ?? starter?.name ?? null;
    return {
      ok: true,
      from,
      for: invite?.for ?? null,
      game: this.game?.id ?? this.setup.pick,
      people: [...this.players.values()].filter((p) => p.conn).map((p) => p.name),
      away: [...this.players.values()].filter((p) => !p.conn).map((p) => p.name),
      full: this.openSlots() <= 0,
    };
  }

  // ------------------------------------------------------------------ voice + reports

  private newAlias(): string {
    let a = '';
    do a = randomBytes(4).toString('hex');
    while ([...this.players.values()].some((p) => p.alias === a));
    return a;
  }

  voicePeers(): VoicePeer[] {
    return [...this.players.values()].filter((p) => p.inVoice && p.conn).map((p) => ({ id: p.alias, name: p.name }));
  }

  private broadcastVoice() {
    this.broadcast({ t: 'voice', peers: this.voicePeers() });
  }

  private setVoice(p: Player, join: boolean) {
    if (this.kind !== 'private') {
      this.notice(p, 'Voice chat is available in private rooms.');
      return;
    }
    if (p.inVoice === join) return;
    p.inVoice = join;
    this.log(join ? 'voice_join' : 'voice_leave', { pid: p.pid, inVoice: this.voicePeers().length });
    this.broadcastVoice();
  }

  /**
   * Voice settings for one player. With our own TURN relay configured, each player gets
   * credentials that expire (coturn's shared-secret scheme), so a credential copied out of
   * the page can't be used to relay traffic for long.
   */
  voiceSettings(p: Member): VoiceSettings {
    const iceServers = [...(this.deps.iceServers ?? [])];
    const turn = this.deps.turn;
    if (turn && turn.urls.length) iceServers.push(turnCredentials(turn, p.alias, this.deps.now()));
    return { enabled: this.kind === 'private', iceServers };
  }

  /**
   * Recent delivered messages, so a report can save the message and its sender for review.
   * Like the chat history, they live only in memory and go when the table closes.
   */
  private recentMessages = new Map<string, { pid: string; name: string; text: string; at: number }>();

  private report(p: Player, msgId: string) {
    const now = this.deps.now();
    p.reportTimes = p.reportTimes.filter((t) => now - t < 60_000);
    if (p.reportTimes.length >= REPORTS_PER_MINUTE) {
      this.notice(p, "You've sent a lot of reports. Try again in a minute.");
      return;
    }
    const target = this.recentMessages.get(msgId);
    if (!target) return;
    p.reportTimes.push(now);
    // A reported message is the only chat text written to the log, so it can be reviewed after
    // the table closes. Everything else said at the table is gone when the table is.
    this.deps.log.chat({
      room: this.code,
      roomKind: this.kind,
      outcome: 'reported',
      msgId,
      reporter: p.pid,
      reported: target.pid,
      reportedName: target.name,
      text: target.text,
      ruleVersion: RULE_VERSION,
    });
    this.deps.log.event('chat_report', { room: this.code, roomKind: this.kind });
    this.notice(p, 'Thanks. That message was reported for review.');
  }

  /** Rate-limited chat attempts since the last housekeeping, logged as counts (not text). */
  private rateLimited = { rapid: 0, repeat: 0 };

  /** Private rooms: anyone can change how swearing is handled; everyone is told. */
  private setChatFilter(p: Player, mode: ChatFilterMode) {
    if (this.kind !== 'private' || mode === this.chatFilter) return;
    this.chatFilter = mode;
    const label = CHAT_FILTER_LABELS[mode];
    this.broadcast({ t: 'filter', mode });
    this.systemChat(`${p.name} set the chat filter to ${label.name}: ${label.detail}.`);
    this.log('chat_filter', { mode, by: p.pid });
  }

  private chat(p: Player, raw: string) {
    const now = this.deps.now();
    if (now < p.chatPausedUntil) {
      this.notice(p, `You can chat again in ${Math.ceil((p.chatPausedUntil - now) / 1000)} seconds.`);
      return;
    }
    const text = cleanText(raw.slice(0, MAX_CHAT_LENGTH * 2), MAX_CHAT_LENGTH + 1);
    const rate = p.limiter.check(now, text);
    if (rate !== 'ok') {
      this.rateLimited[rate]++;
      this.notice(p, rate === 'repeat' ? 'You just sent that.' : 'Slow down a little.');
      return;
    }
    const msgId = randomUUID();
    // The log counts messages (for the admin page) but never keeps what was said or who said it.
    const base = { room: this.code, roomKind: this.kind, ruleVersion: RULE_VERSION };
    let result;
    try {
      result = this.deps.moderator.screen(text, this.chatFilter);
    } catch (err) {
      this.deps.log.chat({ ...base, outcome: 'error', reason: String(err) });
      this.deps.log.event('moderation_failure', { room: this.code });
      this.notice(p, "Couldn't send that. Please try again.");
      return;
    }
    const msg: ChatMessage = { id: msgId, from: p.name, speaker: p.alias, color: p.color, text: result.ok ? result.text : text.trim(), at: now };
    if (!result.ok) {
      this.deps.log.chat({ ...base, outcome: 'blocked', reason: result.reason });
      if (result.reason === 'too-long') this.notice(p, `Messages are limited to ${MAX_CHAT_LENGTH} characters.`);
      else if (result.reason !== 'empty') this.caught(p, msg, now);
      return;
    }
    this.deps.log.chat({ ...base, outcome: 'delivered' });
    if (this.session) this.session.chats++;
    this.recentMessages.set(msgId, { pid: p.pid, name: p.name, text: msg.text, at: now });
    if (this.recentMessages.size > 200) this.recentMessages.delete(this.recentMessages.keys().next().value!);
    this.pushHistory(msg);
    this.broadcast({ t: 'chat', msg });
  }

  /**
   * The filter caught a message (the browser normally stops these before they're sent). The
   * sender sees it dimmed as "only you", with a reminder; three in a minute pause their chat.
   */
  private caught(p: Player, msg: ChatMessage, now: number) {
    p.conn?.send(JSON.stringify({ t: 'chat', msg: { ...msg, hidden: true } } satisfies ServerMessage));
    p.caughtTimes = p.caughtTimes.filter((t) => now - t < CAUGHT_WINDOW_MS);
    p.caughtTimes.push(now);
    if (p.caughtTimes.length >= CAUGHT_LIMIT) {
      p.caughtTimes = [];
      p.chatPausedUntil = now + CHAT_PAUSE_MS;
      p.conn?.send(JSON.stringify({ t: 'chatPaused', ms: CHAT_PAUSE_MS } satisfies ServerMessage));
      this.sendSystem(p, `Chat paused for ${CHAT_PAUSE_MS / 1000} seconds. Keep Games Drawer chat family friendly.`);
      this.log('chat_paused', { pid: p.pid });
    } else {
      this.sendSystem(p, 'Keep Games Drawer chat family friendly. Only you can see that message.');
    }
  }

  private rename(p: Player, raw: string) {
    const now = this.deps.now();
    if (now - p.lastRename < RENAME_COOLDOWN_MS) {
      p.conn?.send(JSON.stringify({ t: 'name', name: p.name } satisfies ServerMessage));
      this.notice(p, 'Wait a few seconds before renaming again.');
      return;
    }
    const name = this.acceptableName(raw);
    if (!name) {
      p.conn?.send(JSON.stringify({ t: 'name', name: p.name } satisfies ServerMessage));
      this.notice(p, "That name isn't allowed.");
      return;
    }
    p.lastRename = now;
    const taken = this.takenNames();
    taken.delete(p.name.toLowerCase());
    const unique = uniqueName(name, taken);
    const old = p.name;
    p.name = unique;
    this.game?.renamed(p);
    p.conn?.send(JSON.stringify({ t: 'name', name: unique } satisfies ServerMessage));
    if (old !== unique) {
      this.systemChat(`${old} is now ${unique}.`);
      this.broadcastMembers();
      if (p.inVoice) this.broadcastVoice();
    }
  }

  private pushHistory(msg: ChatMessage) {
    this.chatHistory.push(msg);
    while (this.chatHistory.length > this.deps.chatHistorySize) this.chatHistory.shift();
  }

  private systemChat(text: string, notice?: ChatMessage['notice']) {
    const msg: ChatMessage = { id: randomUUID(), from: '', color: -1, text, at: this.deps.now(), system: true, ...(notice && { notice }) };
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

  // ------------------------------------------------------------------ sync

  welcome(session: string, r: Extract<JoinResult, { ok: true }>): ServerMessage {
    const p = this.players.get(session)!;
    return {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      session,
      name: r.name,
      reclaimed: r.reclaimed,
      alias: p.alias,
      voice: this.voiceSettings(p),
      room: { code: this.code, kind: this.kind },
      game: this.game?.id ?? null,
      members: this.members(),
      chat: this.chatHistory.slice(),
      chatFilter: this.chatFilter,
      table: this.tableSetup(),
    };
  }

  /** Send the welcome, then who's in voice, then the game's own start-up message. */
  sendWelcome(session: string, r: Extract<JoinResult, { ok: true }>) {
    const p = this.players.get(session);
    if (!p?.conn) return;
    p.conn.send(JSON.stringify(this.welcome(session, r)));
    p.welcomed = true;
    if (this.kind === 'private') p.conn.send(JSON.stringify({ t: 'voice', peers: this.voicePeers() } satisfies ServerMessage));
    this.game?.sendInit(p, r.reclaimed);
  }

  private broadcastMembers() {
    this.broadcast({ t: 'members', members: this.members() });
  }

  /** Advance one tick. Returns the tick duration in ms. */
  step(): number {
    const start = performance.now();
    this.game?.step();
    return performance.now() - start;
  }

  stats() {
    return {
      kind: this.kind,
      game: this.game?.id ?? null,
      humans: this.humansConnected(),
      ...this.game?.stats(),
      emptyForS: this.emptySince ? Math.round((this.deps.now() - this.emptySince) / 1000) : null,
    };
  }

  /**
   * Everyone connected who has had their welcome. A connection that hasn't been welcomed yet
   * gets the same information inside its welcome (members, chat history, game, voice).
   */
  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) if (p.conn && p.welcomed) p.conn.send(data);
  }

  private log(type: string, fields: Record<string, unknown>) {
    this.deps.log.event(type, { room: this.code, roomKind: this.kind, ...fields });
  }
}

/** coturn "use-auth-secret": username "<expiry>:<id>", password base64(HMAC-SHA1(secret, username)). */
export function turnCredentials(turn: TurnSettings, id: string, nowMs: number) {
  const username = `${Math.floor(nowMs / 1000) + turn.ttlSeconds}:${id}`;
  const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
  return { urls: turn.urls, username, credential };
}
