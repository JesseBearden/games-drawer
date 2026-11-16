import type { Device, GameId, GameInput, GameServerMessage, RoomKind } from '@tank/shared';

/** A client connection. `send` takes pre-serialised JSON so broadcasts serialise once. */
export interface Conn {
  send(data: string): void;
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
}

/** Services the room gives the game it's running. */
export interface GameHost {
  readonly code: string;
  readonly kind: RoomKind;
  now(): number;
  members(): Member[];
  member(session: string): Member | undefined;
  send(to: Member, msg: GameServerMessage): void;
  broadcast(msg: GameServerMessage): void;
  /** A line in room chat (and its history). */
  systemChat(text: string): void;
  log(type: string, fields: Record<string, unknown>): void;
  /** Uniform random integer in [0, n): crypto-strength on the server, seeded in tests. */
  randomInt(n: number): number;
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
  /** A member joined the room, or was there when the game started. False if there's no seat. */
  addPlayer(m: Member): boolean;
  /** A member came back on a new connection. True if they got their old seat back. */
  reconnect(m: Member): boolean;
  /** A member's connection dropped; their seat is held. Returns a note for the chat line. */
  disconnect(m: Member, reason: string): string | null;
  /** A member left for good (their hold expired): free the seat. */
  removePlayer(m: Member): void;
  renamed(m: Member): void;
  /** Send everything this member needs to draw the game (after welcome, start, or resync). */
  sendInit(m: Member, reclaimed: boolean): void;
  handle(m: Member, input: GameInput): void;
  /** Advance one tick (60 per second). */
  step(): void;
  dispose(): void;
  stats(): Record<string, unknown>;
}
