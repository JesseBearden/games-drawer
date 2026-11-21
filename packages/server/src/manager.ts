import { randomInt } from 'node:crypto';
import {
  canPlayPrivately,
  canPlayPublicly,
  GAME_NAMES,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  slotOfCode,
  type GameId,
  type RoomKind,
  type RoomRequest,
  type Slot,
} from '@tank/shared';
import { Room, type RoomDeps } from './room';

export interface ManagerOptions extends Omit<RoomDeps, 'seed'> {
  maxPublicRooms: number;
  maxPrivateRooms: number;
  /** Which deploy slot this server is; its room codes always map to it. */
  slot?: Slot;
}

export type RoomLookup = { ok: true; room: Room } | { ok: false; code: 'capacity' | 'not-found' | 'room-full'; message: string };

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  rejectedAtCapacity = 0;
  roomErrors = 0;
  /** A newer copy of the server has taken over: finish the games here, but start no new ones. */
  draining = false;

  constructor(private opts: ManagerOptions) {}

  count(kind: RoomKind) {
    let n = 0;
    for (const r of this.rooms.values()) if (r.kind === kind) n++;
    return n;
  }

  /** Find the room a hello asks for, creating one when allowed. */
  resolve(req: RoomRequest, session: string): RoomLookup {
    if (req.kind === 'private') {
      const room = this.rooms.get(normalizeRoomCode(req.code));
      if (!room || room.kind !== 'private') return { ok: false, code: 'not-found', message: 'That room has closed or the code is wrong.' };
      if (!room.hasSession(session) && room.openSlots() <= 0) return { ok: false, code: 'room-full', message: 'That room is full.' };
      return { ok: true, room };
    }
    if (req.kind === 'public') {
      const game = req.game ?? 'tanks';
      if (!canPlayPublicly(game)) return { ok: false, code: 'not-found', message: `${GAME_NAMES[game]} isn’t open to everyone yet. Start a private room to play it.` };
      const playing = (r: Room) => r.kind === 'public' && r.game?.id === game;
      // Rejoin the public game you were in, if it still has your seat.
      for (const r of this.rooms.values()) if (playing(r) && r.hasSession(session)) return { ok: true, room: r };
      if (this.draining) return { ok: false, code: 'capacity', message: 'The game was updated. Press Play to start a new one.' };
      // Otherwise the busiest one with space, so people play together.
      const open = [...this.rooms.values()].filter((r) => playing(r) && r.openSlots() > 0).sort((a, b) => b.humansConnected() - a.humansConnected());
      if (open.length) return { ok: true, room: open[0] };
      return this.create('public', game);
    }
    if (req.game && !canPlayPrivately(req.game)) return { ok: false, code: 'not-found', message: 'That game isn’t available right now.' };
    return this.create('private', req.game);
  }

  create(kind: RoomKind, game?: GameId): RoomLookup {
    if (this.draining) return { ok: false, code: 'capacity', message: 'The game was just updated. Try again.' };
    const limit = kind === 'public' ? this.opts.maxPublicRooms : this.opts.maxPrivateRooms;
    if (this.count(kind) >= limit) {
      this.rejectedAtCapacity++;
      this.opts.log.event('room_rejected_capacity', { roomKind: kind });
      return { ok: false, code: 'capacity', message: 'Try again later.' };
    }
    let code = '';
    do {
      code = '';
      // crypto.randomInt: private codes must not be predictable.
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    } while (this.rooms.has(code) || (this.opts.slot && slotOfCode(code) !== this.opts.slot));
    const room = new Room(code, kind, this.opts, game);
    this.rooms.set(code, room);
    return { ok: true, room };
  }

  /** Run per-second housekeeping: reservation expiry, and closing empty or idle rooms. */
  housekeeping() {
    for (const [code, room] of this.rooms) {
      let close: false | 'empty' | 'idle';
      try {
        close = room.housekeeping();
      } catch (err) {
        this.fail(code, room, err);
        continue;
      }
      if (close) {
        try {
          room.close(close);
        } catch (err) {
          this.opts.log.event('room_error', { room: code, roomKind: room.kind, error: String(err) });
        }
        this.rooms.delete(code);
      }
    }
  }

  /** Close every room (the server is stopping): each saves what it should and tells its people why. */
  closeAll(reason: string) {
    for (const [code, room] of this.rooms) {
      try {
        room.close(reason);
      } catch (err) {
        this.opts.log.event('room_error', { room: code, roomKind: room.kind, error: String(err) });
      }
      this.rooms.delete(code);
    }
  }

  /** Step every room. A room that throws is closed so it cannot take the others down. */
  stepAll(): { maxMs: number; totalMs: number } {
    let maxMs = 0;
    let totalMs = 0;
    for (const [code, room] of this.rooms) {
      try {
        const ms = room.step();
        totalMs += ms;
        if (ms > maxMs) maxMs = ms;
      } catch (err) {
        this.fail(code, room, err);
      }
    }
    return { maxMs, totalMs };
  }

  private fail(code: string, room: Room, err: unknown) {
    this.roomErrors++;
    this.opts.log.event('room_error', { room: code, roomKind: room.kind, error: String(err), stack: (err as Error)?.stack?.split('\n').slice(0, 6).join(' | ') });
    console.error(`Room ${code} crashed and was closed:`, err);
    try {
      room.close('error');
    } catch {
      /* already broken */
    }
    this.rooms.delete(code);
  }
}
