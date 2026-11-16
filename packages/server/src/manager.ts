import { randomInt } from 'node:crypto';
import { normalizeRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, type RoomKind, type RoomRequest } from '@tank/shared';
import { Room, type RoomDeps } from './room';

export interface ManagerOptions extends Omit<RoomDeps, 'seed'> {
  maxPublicRooms: number;
  maxPrivateRooms: number;
}

export type RoomLookup = { ok: true; room: Room } | { ok: false; code: 'capacity' | 'not-found' | 'room-full'; message: string };

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  rejectedAtCapacity = 0;
  roomErrors = 0;

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
      // Rejoin the public room you were in, if it still has your tank.
      for (const r of this.rooms.values()) if (r.kind === 'public' && r.hasSession(session)) return { ok: true, room: r };
      // Otherwise the busiest public room with space, so people play together.
      const open = [...this.rooms.values()]
        .filter((r) => r.kind === 'public' && r.openSlots() > 0)
        .sort((a, b) => b.humansConnected() - a.humansConnected());
      if (open.length) return { ok: true, room: open[0] };
      return this.create('public');
    }
    return this.create('private');
  }

  create(kind: RoomKind): RoomLookup {
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
    } while (this.rooms.has(code));
    const room = new Room(code, kind, this.opts);
    this.rooms.set(code, room);
    return { ok: true, room };
  }

  /** Run per-second housekeeping: reservation expiry and empty-room closure. */
  housekeeping() {
    for (const [code, room] of this.rooms) {
      let close: boolean;
      try {
        close = room.housekeeping();
      } catch (err) {
        this.fail(code, room, err);
        continue;
      }
      if (close) {
        room.close('empty');
        this.rooms.delete(code);
      }
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
