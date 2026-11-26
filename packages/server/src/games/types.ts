import type { Device, GameId, GameInput, GameServerMessage, TablePhotoInfo } from '@tank/shared';

/** A client connection. `send` takes pre-serialised JSON so broadcasts serialise once. */
export interface Conn {
  send(data: string): void;
  /** The page asked for batches (see `hello`). */
  batches?: boolean;
  /** Which network they came from, scrambled (the relay counts slots by it). */
  net?: string;
  /** An automated test, or someone on the staging site: left out of the site's counts (metrics.ts). */
  test?: boolean;
  close(code?: number, reason?: string): void;
}

/** What a game may know about someone in the room. */
export interface Member {
  readonly session: string;
  /** Pseudonymous id for logs (never the session credential). */
  readonly pid: string;
  /** Public id shown to other clients (chat sender, voice peer). */
  readonly alias: string;
  readonly name: string;
  /** Colour index (TANK_COLORS) shared by chat and every game. */
  readonly color: number;
  readonly device: Device;
  /** Null while they're disconnected (their seat is held for them). */
  readonly conn: Conn | null;
  /** When their connection dropped (null while connected; left out where nobody tracks it). */
  readonly awaySince?: number | null;
}

/**
 * How long someone's connection must be gone before a computer plays their turn. Phones drop the
 * connection when the screen locks or another app opens; that shouldn't cost them a card.
 */
export const BOT_TAKEOVER_MS = 20_000;

/**
 * Games that only watch timers (computer turns, pauses between tricks) look 10 times a second:
 * their waits are 0.7 s and up.
 */
export const TIMER_GAME_TICKS = 6;

/** Does a computer play this seat now: nobody's there, or they've been gone BOT_TAKEOVER_MS. */
export function botPlays(m: Member | undefined, now: number): boolean {
  if (!m) return true;
  if (m.conn) return false;
  return m.awaySince == null || now - m.awaySince >= BOT_TAKEOVER_MS;
}

/**
 * Dropped out so long ago that they've gone, as far as a game starting now is concerned: they
 * aren't dealt in or handed a seat that comes free. Coming back, they take a free seat.
 */
export function leftLongAgo(m: Member, now: number): boolean {
  return !m.conn && botPlays(m, now);
}

/**
 * For games with seats: anyone connected without a seat takes a seat in play that nobody holds,
 * or whose person has been gone a while (a computer is playing it). Returns the seats that
 * changed hands. Someone gone who comes back later watches, and gets the next seat that frees up.
 */
export function watchersTakeSeats(host: GameHost, seats: { session: string | null }[], inPlay: readonly number[]): number[] {
  const now = host.now();
  const seated = new Set(seats.flatMap((s) => (s.session ? [s.session] : [])));
  const watchers = host.members().filter((m) => m.conn && !seated.has(m.session));
  const moved: number[] = [];
  for (const seat of inPlay) {
    if (!watchers.length) break;
    const holder = seats[seat].session;
    const m = holder !== null ? host.member(holder) : undefined;
    if (m && !leftLongAgo(m, now)) continue;
    seats[seat].session = watchers.shift()!.session;
    moved.push(seat);
  }
  return moved;
}

/** One of several messages going out together (GameHost.broadcastTogether). */
export interface Outgoing {
  msg: GameServerMessage;
  /** Not for this session (it's their own move). */
  except?: string;
  /** Nothing new since the last one: pages that take batches can do without it. */
  repeat?: boolean;
}

/** Services the room gives the game it's running. */
export interface GameHost {
  readonly code: string;
  now(): number;
  members(): Member[];
  member(session: string): Member | undefined;
  send(to: Member, msg: GameServerMessage): void;
  broadcast(msg: GameServerMessage): void;
  /** Send these in one frame to pages that take batches, one by one to the others. */
  broadcastTogether(out: readonly Outgoing[]): void;
  /** A line in room chat (and its history). */
  systemChat(text: string): void;
  /**
   * A line in Messages about a move in the game ("Sam took Liz's 5 dots for a Pung."): everyone
   * here sees it, but it isn't kept for people who arrive later, so it never pushes the table's
   * own messages out of what they're shown.
   */
  gameNote?(text: string): void;
  log(type: string, fields: Record<string, unknown>): void;
  /** Uniform random integer in [0, n): crypto-strength on the server, seeded in tests. */
  randomInt(n: number): number;
  /** Jigsaw: may they start or bring back one more puzzle? (Counted by the table and by address.) */
  mayStartPuzzle(m: Member): boolean;
  /** Jigsaw: one did start or come back. */
  puzzleStarted(m: Member): void;
  /** Photos people at the table uploaded for a jigsaw (in memory until the table closes). */
  photos?(): TablePhotoInfo[];
  /** Whether people at this table may upload photos at all. */
  readonly photoUploads?: boolean;
}

/**
 * One game running inside a room. The room owns the people, chat and voice; the game owns
 * seats, rules and what each player sees. Members join and leave the room while a game runs,
 * and a game can start with members already disconnected (their seats are held for them).
 */
export interface ServerGame {
  readonly id: GameId;
  /** Most people the game can seat (the room may have fewer). */
  readonly capacity: number;
  /** A member joined the room, or was there when the game started (at the seat they picked,
   *  for games with seats). False if there's no seat. */
  addPlayer(m: Member, seat?: number): boolean;
  /** For games with seats: which one this member has (null if none, or watching). */
  seatOf?(session: string): number | null;
  /** A member came back on a new connection. True if they got their old seat back. */
  reconnect(m: Member): boolean;
  /** A member's connection dropped; their seat is held. Returns a note for the chat line. */
  disconnect(m: Member, reason: string): string | null;
  /**
   * A member left for good (their hold expired): free the seat. `comingBack`: it's the same
   * person, about to be added again on a new session with this seat asked for (Room.join), so
   * the seat isn't offered to anyone watching meanwhile.
   */
  removePlayer(m: Member, opts?: { comingBack?: boolean }): void;
  /**
   * Once a second: anyone watching (more people than seats) takes a seat the computer is playing,
   * one nobody holds or whose person has been gone a while (user, 2026-11-26).
   */
  seatWatchers?(): void;
  renamed(m: Member): void;
  /** Send everything this member needs to draw the game (after welcome, start, or resync). */
  sendInit(m: Member, reclaimed: boolean): void;
  handle(m: Member, input: GameInput): void;
  /** Called every `tickEvery` ticks (there are 60 a second). */
  step(): void;
  /** How often step needs calling, in ticks. Real-time games: every tick (the default). */
  readonly tickEvery?: number;
  dispose(): void;
  stats(): Record<string, unknown>;
  /** The table's photos changed (someone added one). */
  photosChanged?(): void;
  /** Whether this photo (its picture id, `photo-…`) is in use, so it isn't let go. */
  usesPhoto?(image: string): boolean;
}
