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
  PROTOCOL_VERSION,
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

/** Chat reports per player per minute. */
export const REPORTS_PER_MINUTE = 5;
/** One rename per this many ms. */
export const RENAME_COOLDOWN_MS = 10_000;
/** Join/leave/back notices for the same player at most this often. */
export const ANNOUNCE_COOLDOWN_MS = 20_000;
/** Starting or ending a game, at most this often per room. */
export const GAME_SWITCH_COOLDOWN_MS = 1500;
/** Three caught messages within a minute pause that player's chat for 30 seconds. */
export const CAUGHT_LIMIT = 3;
export const CAUGHT_WINDOW_MS = 60_000;
export const CHAT_PAUSE_MS = 30_000;

interface Player extends Member {
  name: string;
  conn: Conn | null;
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
  inVoice: boolean;
  reportTimes: number[];
  /** The current connection has been sent its welcome (game messages wait for it). */
  welcomed: boolean;
  /** When the chat filter caught this player's recent messages (for the timeout). */
  caughtTimes: number[];
  /** Chat is paused until then after too many caught messages. */
  chatPausedUntil: number;
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
  private lastSwitch = -Infinity;
  /** How swearing in chat is handled. Public rooms always block; private rooms start on hide. */
  chatFilter: ChatFilterMode;
  private readonly cfg: GameConfig;
  private host: GameHost;

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
    const first = firstGame ?? (kind === 'public' ? 'tanks' : null);
    if (first) {
      this.game = this.makeGame(first);
      this.beginSession(first);
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

  /** Places a newcomer could take. */
  openSlots() {
    return this.capacity() - this.players.size;
  }

  hasSession(session: string) {
    return this.players.has(session);
  }

  members(): MemberInfo[] {
    return [...this.players.values()].map((p) => ({ id: p.alias, name: p.name, color: p.color, connected: !!p.conn }));
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
      this.accrue();
      if (existing.inVoice) {
        // A new connection starts outside voice; the old peer connections are gone.
        existing.inVoice = false;
        this.broadcastVoice();
      }
      existing.conn = conn;
      existing.welcomed = false;
      existing.device = device;
      existing.connectedAt = now;
      existing.reservedUntil = Infinity;
      const seatBack = this.game ? this.game.reconnect(existing) : true;
      this.countPeople();
      this.emptySince = null;
      if (wasAway) this.announce(existing, 'arrive', `${existing.name} is back.`);
      this.broadcastMembers();
      return { ok: true, reclaimed: wasAway && seatBack, name: existing.name };
    }

    if (this.openSlots() <= 0) return { ok: false, code: 'room-full', message: 'Room is full.' };
    const wanted = this.acceptableName(requestedName);
    const name = uniqueName(wanted ?? this.randomName(), this.takenNames());
    this.accrue();
    const p: Player = {
      session,
      pid: pseudonym(session),
      name,
      conn,
      device,
      color: this.freeColor(),
      connectedAt: now,
      reservedUntil: Infinity,
      limiter: new RateLimiter(),
      lastRename: -Infinity,
      lastArrive: -Infinity,
      lastLeave: -Infinity,
      lastNotice: -Infinity,
      alias: this.newAlias(),
      inVoice: false,
      reportTimes: [],
      welcomed: false,
      caughtTimes: [],
      chatPausedUntil: 0,
    };
    this.players.set(session, p);
    if (this.game && !this.game.addPlayer(p)) {
      this.players.delete(session);
      return { ok: false, code: 'room-full', message: 'Room is full.' };
    }
    this.countPeople();
    this.emptySince = null;
    this.log('join', { pid: p.pid, device });
    this.announce(p, 'arrive', `${p.name} joined.`);
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
    this.systemChat(text);
  }

  disconnect(session: string, conn: Conn | null, reason: string) {
    const p = this.players.get(session);
    if (!p || (conn && p.conn !== conn)) return;
    const now = this.deps.now();
    this.accrue();
    p.conn = null;
    p.welcomed = false;
    if (p.inVoice) {
      p.inVoice = false;
      this.broadcastVoice();
    }
    p.reservedUntil = this.kind === 'public' ? now + this.deps.publicReclaimMs : Infinity;
    const note = this.game?.disconnect(p, reason) ?? null;
    this.log('disconnect', { pid: p.pid, reason, sessionMs: now - p.connectedAt, device: p.device });
    if (this.humansConnected() === 0) this.emptySince = now;
    this.announce(p, 'leave', note ? `${p.name} left. ${note}` : `${p.name} left.`);
    this.broadcastMembers();
  }

  /** Expire public reservations; returns true if the room should close. */
  housekeeping(): boolean {
    const now = this.deps.now();
    this.flushRateLimitCounts();
    let changed = false;
    for (const p of [...this.players.values()]) {
      if (!p.conn && now >= p.reservedUntil) {
        this.players.delete(p.session);
        this.log('reservation_expired', { pid: p.pid });
        this.game?.removePlayer(p);
        changed = true;
      }
    }
    if (changed) this.broadcastMembers();
    return this.emptySince !== null && now - this.emptySince >= this.deps.emptyRoomMs;
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.endSession('room_closed');
    this.game?.dispose();
    for (const p of this.players.values()) {
      if (p.conn) {
        p.conn.send(JSON.stringify({ t: 'error', code: 'room-closed', message: 'This room has closed.' } satisfies ServerMessage));
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

  private startGame(p: Player, id: GameId) {
    if (this.kind !== 'private') return;
    if (!canPlayPrivately(id)) {
      this.notice(p, 'That game isn’t available right now.');
      return;
    }
    if (this.game) {
      this.notice(p, 'Go back to the lobby to pick another game.');
      return;
    }
    const now = this.deps.now();
    if (now - this.lastSwitch < GAME_SWITCH_COOLDOWN_MS) return;
    this.lastSwitch = now;
    this.game = this.makeGame(id);
    this.beginSession(id);
    this.broadcast({ t: 'game', game: id });
    for (const m of this.players.values()) this.game.addPlayer(m);
    for (const m of this.players.values()) if (m.conn && m.welcomed) this.game.sendInit(m, false);
    this.systemChat(`${p.name} started ${GAME_NAMES[id]}.`);
    this.log('game_start', { game: id, by: p.pid, humans: this.humansConnected() });
  }

  private endGame(p: Player) {
    if (this.kind !== 'private' || !this.game) return;
    const now = this.deps.now();
    if (now - this.lastSwitch < GAME_SWITCH_COOLDOWN_MS) return;
    this.lastSwitch = now;
    const id = this.game.id;
    this.endSession('lobby');
    this.game.dispose();
    this.game = null;
    this.broadcast({ t: 'game', game: null });
    this.systemChat(`${p.name} ended ${GAME_NAMES[id]}. Back to the lobby.`);
    this.log('game_end', { game: id, by: p.pid });
  }

  // ------------------------------------------------------------------ messages

  handle(session: string, msg: ClientMessage) {
    const p = this.players.get(session);
    if (!p || !p.conn) return;
    switch (msg.t) {
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
        this.startGame(p, msg.game);
        return;
      case 'lobby':
        this.endGame(p);
        return;
      case 'filter':
        this.setChatFilter(p, msg.mode);
        return;
      case 'hello':
        return;
    }
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

  /** Recent delivered messages, so a report can be tied to its sender for review. */
  private recentMessages = new Map<string, { pid: string; at: number }>();

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
    // The chat audit log already holds the message text under this msgId.
    this.deps.log.chat({ room: this.code, roomKind: this.kind, outcome: 'reported', msgId, reporter: p.pid, reported: target.pid, ruleVersion: RULE_VERSION });
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
    this.recentMessages.set(msgId, { pid: p.pid, at: now });
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
