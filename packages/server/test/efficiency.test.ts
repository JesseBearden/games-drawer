/**
 * The cheaper ways of doing the same thing: batched frames for pages that ask (and only them), a
 * still Tanks battlefield, the sleeping game clock, disk work off the game thread, solved hands.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bestMelds, parseClientMessage, Rng, STILL_STATE_TICKS, ThreeThirteenRound, type GameId, type GameServerMessage, type PuzzleState, type ServerMessage } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { startGameClock } from '../src/gameClock';
import { JigsawGame } from '../src/games/jigsaw';
import { RoomManager } from '../src/manager';
import { PuzzleStore } from '../src/puzzleStore';
import type { Conn } from '../src/room';

class FakeConn implements Conn {
  frames: ServerMessage[] = [];
  constructor(public batches: boolean) {}
  send(data: string) {
    this.frames.push(JSON.parse(data));
  }
  close() {}
  /** The game messages, whether they came batched or one by one, in order. */
  game(): GameServerMessage[] {
    return this.frames.flatMap((f) => (f.t === 'batch' ? f.msgs : [f])).flatMap((m) => (m.t === 'g' ? [m.m] : []));
  }
}

/** A table playing `game`, one person per entry of `batches` (whether their page takes batches). */
function table(game: GameId, batches: boolean[]) {
  const clock = { now: 1_000_000, tick: 0 };
  const rng = new Rng(7);
  const mgr = new RoomManager({
    now: () => clock.now,
    log: new MemoryLog(),
    moderator: new ChatModerator(),
    emptyRoomMs: 60_000,
    maxPrivateRooms: 10,
    chatHistorySize: 10,
    randomInt: (n) => rng.int(0, n - 1),
    // The battlefield too: on about a quarter of random ones nothing ever comes to rest.
    ...{ seed: 7 }, // (a room option the manager passes through, though its type leaves it out)
  });
  const people = batches.map((b, i) => ({ session: `session-${i}${i}${i}${i}`, conn: new FakeConn(b) }));
  let code = '';
  for (const [i, p] of people.entries()) {
    const found = mgr.resolve(i ? { kind: 'private', code } : { kind: 'create-private' }, p.session);
    if (!found.ok) throw new Error(found.code);
    const r = found.room.join(p.conn, p.session, `P${i}`, 'desktop');
    if (!r.ok) throw new Error(r.code);
    found.room.sendWelcome(p.session, r);
    code = found.room.code;
  }
  const room = mgr.rooms.get(code)!;
  room.handle(people[0].session, { t: 'pick', game });
  for (const p of people) room.handle(p.session, { t: 'ready', ready: true });
  const send = (i: number, m: object) => room.handle(people[i].session, { t: 'g', m } as never);
  const clear = () => people.forEach((p) => (p.conn.frames.length = 0));
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.now += 1000 / 60;
      mgr.stepAll(++clock.tick);
    }
  };
  return { room, mgr, clock, people, send, clear, ticks };
}

describe('asking for batches', () => {
  it('is an opt-in on the hello, so pages from before still work', () => {
    const hello = { t: 'hello', v: 4, session: null, name: 'Liz', room: { kind: 'create-private' }, device: 'phone' };
    expect(parseClientMessage(JSON.stringify(hello))).not.toHaveProperty('batch');
    expect(parseClientMessage(JSON.stringify({ ...hello, batch: 'yes' }))).not.toHaveProperty('batch');
    expect(parseClientMessage(JSON.stringify({ ...hello, batch: true }))).toMatchObject({ batch: true });
  });
});

describe('Jigsaw pointers and drags', () => {
  function puzzle(batches: boolean[]) {
    const t = table('jigsaw', batches);
    t.send(0, { t: 'pz-new', image: 'dog', pieces: 50 });
    t.ticks(8);
    t.clear();
    return t;
  }

  it('go out together, each person’s newest only, never back to whoever moved', () => {
    const { people, send, ticks } = puzzle([true, true, true, true]);
    for (let i = 0; i < 4; i++) for (const x of [10, 20, 30]) send(i, { t: 'pz-cursor', x: x + i, y: 5.04 });
    expect(people[0].conn.frames).toHaveLength(0);
    ticks(8);
    for (const [i, p] of people.entries()) {
      expect(p.conn.frames).toHaveLength(1);
      const seen = p.conn.game().map((m) => (m.t === 'pz-cursor' ? [m.x, m.y] : null));
      expect(seen).toEqual([0, 1, 2, 3].filter((j) => j !== i).map((j) => [30 + j, 5]));
    }
  });

  it('a page from before gets the same messages one by one', () => {
    const { people, send, ticks } = puzzle([false, true, true]);
    send(1, { t: 'pz-cursor', x: 1, y: 1 });
    send(2, { t: 'pz-cursor', x: 2, y: 2 });
    ticks(8);
    expect(people[0].conn.frames.map((f) => f.t)).toEqual(['g', 'g']);
  });

  it('a drop replaces a drag still waiting to go, so a piece never jumps back', () => {
    const { people, send, ticks } = puzzle([true, true]);
    send(0, { t: 'pz-grab', piece: 4 });
    send(0, { t: 'pz-drag', x: -100, y: -100 });
    send(0, { t: 'pz-drop', x: -300, y: -300 });
    ticks(8);
    expect(people[1].conn.game().map((m) => m.t)).toEqual(['pz-held', 'pz-moved', 'pz-held']);
    // The drop and the letting go came as one frame.
    expect(people[1].conn.frames.map((f) => f.t)).toEqual(['g', 'batch']);
  });

  it('someone dropping out mid-drag: the others get where it was before hearing it was let go', () => {
    const { room, people, send } = puzzle([true, true]);
    send(0, { t: 'pz-grab', piece: 4 });
    send(0, { t: 'pz-drag', x: -250, y: -120 });
    room.disconnect(people[0].session, people[0].conn, 'disconnect');
    const got = people[1].conn.game();
    // It rests there as a dropped piece does: one "moved" saying where, then the letting go.
    expect(got.map((m) => m.t)).toEqual(['pz-held', 'pz-moved', 'pz-held']);
    const piece = (room.game as JigsawGame).state!.pieces[4];
    expect(got[1]).toMatchObject({ pieces: [[4, piece.x, piece.y, piece.g]] });
    expect(piece.x).toBe(-250);
  });
});

describe('a still Tanks battlefield', () => {
  it('pages that take batches get a state twice a second; the others still get every one', () => {
    const { room, people, send, ticks, clear } = table('tanks', [true, false, true, true]);
    for (let i = 0; i < 4; i++) send(i, { t: 'drop' });
    for (let i = 0; i < 60 && (room.tanks!.world.helis.length || [...room.tanks!.world.tanks.values()].some((t) => t.phase !== 'ground')); i++) ticks(30);
    ticks(120);
    expect(room.tanks!.world.helis).toHaveLength(0);
    clear();
    ticks(300); // five seconds
    const states = (i: number) => people[i].conn.game().filter((m) => m.t === 'state').length;
    expect(states(1)).toBe(100);
    expect(states(0)).toBe(300 / STILL_STATE_TICKS);

    // Someone moves: they all hear at once, every state, for as long as it lasts.
    clear();
    send(2, { t: 'aim', angle: 33, power: 70 });
    ticks(3);
    expect(states(0)).toBe(1);
  });
});

describe('game pace', () => {
  it('card and puzzle tables are looked at a few times a second, Tanks every tick', () => {
    expect(table('tanks', [true]).room.tickEvery).toBe(1);
    expect(table('jigsaw', [true]).room.tickEvery).toBe(4);
    for (const g of ['hearts', 'spades', 'dominoes', 'threethirteen'] as const) expect(table(g, [true]).room.tickEvery).toBe(6);
  });
});

describe('the game clock', () => {
  afterEach(() => vi.useRealTimers());

  function clock(every: () => number | null) {
    vi.useFakeTimers();
    let wakes = 0;
    const seen: number[] = [];
    const houses: number[] = [];
    const start = Date.now();
    const c = startGameClock(
      60,
      {
        step: (t) => seen.push(t),
        nextTick: (t) => {
          wakes++;
          const e = every();
          return e === null ? null : t - (t % e) + e;
        },
        housekeeping: () => houses.push(Date.now() - start),
        late: () => {},
        error: (err) => {
          if (String(err) !== 'Error: boom') throw err;
        },
      },
      () => Date.now(),
    );
    return { c, seen, houses, wakes: () => wakes };
  }

  it('sleeps with no game running, still doing its housekeeping', () => {
    const { c, houses, wakes } = clock(() => null);
    vi.advanceTimersByTime(10_000);
    expect(houses.length).toBeGreaterThanOrEqual(9);
    // (Windows wakes a little early for its coarse timers, so allow a few.)
    expect(wakes()).toBeLessThan(40);
    c.stop();
  });

  it('runs every tick for Tanks, in order, at 60 a second', () => {
    const { c, seen } = clock(() => 1);
    vi.advanceTimersByTime(10_000);
    expect(seen.length).toBeGreaterThan(595);
    expect(seen.length).toBeLessThanOrEqual(600);
    expect(seen.every((t, i) => t === i + 1)).toBe(true);
    c.stop();
  });

  it('a game starting while it sleeps runs at once, and hasn’t "missed" any ticks', () => {
    let every: number | null = null;
    const { c, seen } = clock(() => every);
    vi.advanceTimersByTime(5500);
    seen.length = 0;
    every = 1;
    c.wake();
    vi.advanceTimersByTime(40);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThanOrEqual(3);
    c.stop();
  });

  it('keeps going after an error', () => {
    let calls = 0;
    vi.useFakeTimers();
    const c = startGameClock(
      60,
      {
        step: () => {
          if (++calls === 1) throw new Error('boom');
        },
        nextTick: (t) => t + 1,
        housekeeping: () => {},
        late: () => {},
        error: () => {},
      },
      () => Date.now(),
    );
    vi.advanceTimersByTime(1000);
    expect(calls).toBeGreaterThan(50);
    c.stop();
  });
});

describe('puzzle saves on a slow disk', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never hold up the game, can be read back at once, and the newest wins', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-slow-'));
    try {
      const real = fs.promises.writeFile;
      let release!: () => void;
      const stuck = new Promise<void>((r) => (release = r));
      const write = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
        await stuck;
        return real(...args);
      });
      const store = new PuzzleStore(dir);
      const state = (x: number): PuzzleState => ({
        id: 'abcdefghijklmnop', image: 'dog', imageFile: '/puzzles/dog.jpg', title: 'Dog', width: 600, height: 400, cols: 3, rows: 2, seed: 1,
        pieces: Array.from({ length: 6 }, (_, i) => ({ x, y: 0, g: i < 2 ? 0 : i })), locked: [], createdAt: 1, updatedAt: x, doneAt: null,
      });
      for (const x of [1, 2, 3, 4, 5]) store.save(state(x)); // returns although the disk is stuck
      expect((await store.load('abcdefghijklmnop'))!.updatedAt).toBe(5);
      expect((await store.summary('abcdefghijklmnop'))!.updatedAt).toBe(5);
      release();
      await store.flush();
      expect(write).toHaveBeenCalledTimes(2); // the one under way, then only the newest
      expect(fs.readdirSync(dir)).toEqual(['abcdefghijklmnop.json']);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'abcdefghijklmnop.json'), 'utf8')).updatedAt).toBe(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('solved Three Thirteen hands', () => {
  it('are the solver’s own answers, whatever order the cards are in', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 100; i++) {
      const round = new ThreeThirteenRound((i % 11) + 1, 0, (n) => rng.int(0, n - 1));
      for (const hand of round.hands) {
        const fresh = bestMelds(hand, round.round);
        expect(round.plan(hand)).toEqual(fresh);
        expect(round.plan([...hand].reverse())).toEqual(bestMelds([...hand].reverse(), round.round));
      }
    }
  });
});
