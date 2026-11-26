import { randomInt } from 'node:crypto';
import {
  isOffered,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  slotOfCode,
  type GameId,
  type RoomRequest,
  type Slot,
} from '@tank/shared';
import { WindowCounter } from './guard';
import type { CensusEntry } from './metrics';
import { Room, type RoomDeps } from './room';

/**
 * Once half the tables are open, one address may start another only while it has fewer
 * than this many: however many it holds open, the rest are left for everyone else. (Not before
 * then: each deploy's smoke tests open about 16 from one address, and families share one.)
 */
export const TABLES_PER_ADDRESS_WHEN_BUSY = 4;

export interface ManagerOptions extends Omit<RoomDeps, 'seed'> {
  maxPrivateRooms: number;
  /** Which deploy slot this server is; its room codes always map to it. */
  slot?: Slot;
}

export type RoomLookup = { ok: true; room: Room } | { ok: false; code: 'capacity' | 'not-found' | 'room-full' | 'rate-limited'; message: string };

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  rejectedAtCapacity = 0;
  roomErrors = 0;
  /** A newer copy of the server has taken over: finish the games here, but start no new ones. */
  draining = false;

  /** Puzzles started from each (scrambled) address, over the last hour, at every table. */
  private puzzleStarts = new WindowCounter(3_600_000);

  constructor(private opts: ManagerOptions) {
    opts.puzzleStartsFrom = this.puzzleStarts;
  }

  /** Find the room a hello asks for, creating one when allowed. `from` is their scrambled address. */
  resolve(req: RoomRequest, session: string, from?: string): RoomLookup {
    if (req.kind === 'private') {
      const room = this.rooms.get(normalizeRoomCode(req.code));
      if (!room) return { ok: false, code: 'not-found', message: 'That room has closed or the code is wrong.' };
      if (!room.hasSession(session) && room.openSlots() <= 0) return { ok: false, code: 'room-full', message: 'That room is full.' };
      return { ok: true, room };
    }
    if (req.game && !isOffered(req.game)) return { ok: false, code: 'not-found', message: 'That game isn’t available right now.' };
    return this.create(req.game, from);
  }

  create(game?: GameId, from?: string): RoomLookup {
    if (this.draining) return { ok: false, code: 'capacity', message: 'The game was just updated. Try again.' };
    const limit = this.opts.maxPrivateRooms;
    if (this.rooms.size >= limit) {
      this.rejectedAtCapacity++;
      this.opts.log.event('room_rejected_capacity', {});
      return { ok: false, code: 'capacity', message: 'Try again later.' };
    }
    if (from && this.rooms.size >= limit / 2 && this.startedFrom(from) >= TABLES_PER_ADDRESS_WHEN_BUSY) {
      this.opts.log.event('room_rejected_address', {});
      return { ok: false, code: 'rate-limited', message: 'There are several tables open from your internet connection. Use one of those, or try again in a minute.' };
    }
    let code = '';
    do {
      code = '';
      // crypto.randomInt: private codes must not be predictable.
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    } while (this.rooms.has(code) || (this.opts.slot && slotOfCode(code) !== this.opts.slot));
    const room = new Room(code, this.opts, game);
    room.startedFrom = from ?? null;
    this.rooms.set(code, room);
    return { ok: true, room };
  }

  private startedFrom(from: string) {
    let n = 0;
    for (const r of this.rooms.values()) if (r.startedFrom === from) n++;
    return n;
  }

  /** Everyone connected at every table here, for the minute counts (metrics.ts). */
  census(): CensusEntry[] {
    const out: CensusEntry[] = [];
    for (const room of this.rooms.values()) if (!room.closed) out.push(...room.census());
    return out;
  }

  /** Run per-second housekeeping: reservation expiry, and closing empty or idle rooms. */
  housekeeping() {
    // (On a timer: nobody's address is held much past the hour, as the privacy page says.)
    this.puzzleStarts.sweep(this.opts.now());
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
          this.opts.log.event('room_error', { room: code, error: String(err) });
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
        this.opts.log.event('room_error', { room: code, error: String(err) });
      }
      this.rooms.delete(code);
    }
  }

  /** The first tick after `tick` that a running game needs, or null if none is running. */
  nextTick(tick: number): number | null {
    let next: number | null = null;
    for (const room of this.rooms.values()) {
      const every = room.tickEvery;
      if (every === null) continue;
      const due = tick - (tick % every) + every;
      if (next === null || due < next) next = due;
      if (next === tick + 1) break;
    }
    return next;
  }

  /**
   * Step the rooms: those whose game is due on this `tick`, or (no tick given) every one. A room
   * that throws is closed so it cannot take the others down.
   */
  stepAll(tick?: number): { maxMs: number; totalMs: number } {
    let maxMs = 0;
    let totalMs = 0;
    for (const [code, room] of this.rooms) {
      try {
        if (tick !== undefined) {
          const every = room.tickEvery;
          if (every === null || tick % every !== 0) continue;
        }
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
    this.opts.log.event('room_error', { room: code, error: String(err), stack: (err as Error)?.stack?.split('\n').slice(0, 6).join(' | ') });
    console.error(`Room ${code} crashed and was closed:`, err);
    try {
      room.close('error');
    } catch {
      /* already broken */
    }
    this.rooms.delete(code);
  }
}
