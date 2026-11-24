/** Limits on what one person, or one address, can take from everyone else. */
import { describe, expect, it } from 'vitest';
import type { GameId, RoomRequest } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import type { JigsawGame } from '../src/games/jigsaw';
import { RoomManager, TABLES_PER_ADDRESS_WHEN_BUSY } from '../src/manager';
import { PUZZLE_STARTS, type Conn } from '../src/room';

function setup(maxPrivateRooms = 50) {
  const clock = { now: 1_000_000 };
  const mgr = new RoomManager({
    now: () => clock.now,
    log: new MemoryLog(),
    moderator: new ChatModerator(),
    emptyRoomMs: 2 * 3_600_000,
    idleRoomMs: 2 * 3_600_000,
    maxPrivateRooms,
    chatHistorySize: 10,
  });
  const open = (from: string, req: RoomRequest = { kind: 'create-private' }) => mgr.resolve(req, 'session', from);
  return { clock, mgr, open };
}

describe('names at a table', () => {
  it('a look-alike gets a number, and a blank or the site’s own name gets a made-up one', () => {
    const { open } = setup();
    const made = open('home');
    if (!made.ok) throw new Error(made.code);
    const join = (session: string, name: string) => {
      const r = made.room.join({ send() {}, close() {} }, session, name, 'phone');
      return r.ok ? r.name : null;
    };
    expect(join('a', '\u041Cila')).toBe('\u041Cila');
    expect(join('b', 'Mila')).toBe('Mila 2');
    expect(join('c', '\u3164')).toMatch(/^\w.* \w/);
    expect(join('d', 'Admin')).not.toMatch(/admin/i);
  });
});

describe('private tables per address', () => {
  it('two addresses can’t hold them all', () => {
    const { open, mgr } = setup();
    for (const from of ['one', 'two']) for (let i = 0; i < 60; i++) open(from);
    expect(mgr.rooms.size).toBe(25 + TABLES_PER_ADDRESS_WHEN_BUSY);
    expect(open('family').ok).toBe(true);
    expect(open('one')).toMatchObject({ ok: false, code: 'rate-limited' });
  });

  it('leaves a quiet server alone: a deploy’s smoke tests open about 16 from one address', () => {
    const { open } = setup();
    for (let i = 0; i < 20; i++) expect(open('tests').ok).toBe(true);
  });

  it('a table that closes frees its place', () => {
    const { open, mgr } = setup(8);
    for (let i = 0; i < 4; i++) expect(open('one').ok).toBe(true);
    expect(open('one').ok).toBe(false);
    mgr.rooms.delete([...mgr.rooms.keys()][0]);
    expect(open('one').ok).toBe(true);
  });
});

describe('puzzles an hour', () => {
  function table(env: ReturnType<typeof setup>, net: string) {
    const made = env.open(net);
    if (!made.ok) throw new Error(made.code);
    const { room } = made;
    const conn: Conn = { net, send() {}, close() {} };
    const r = room.join(conn, 's', 'Liz', 'phone');
    if (!r.ok) throw new Error(r.code);
    room.sendWelcome('s', r);
    const play = (game: GameId) => {
      room.handle('s', { t: 'pick', game });
      room.handle('s', { t: 'ready', ready: true });
    };
    const g = (m: object) => room.handle('s', { t: 'g', m } as never);
    /** Start one, whether or not it's allowed; put it away if it started. */
    const puzzle = () => {
      env.clock.now += 11_000; // (inside the cap on changes at the table)
      g({ t: 'pz-new', image: 'dog', pieces: 6 });
      const started = (room.game as JigsawGame).phase === 'playing';
      if (started) g({ t: 'pz-setup' });
      return started;
    };
    play('jigsaw');
    return { room, play, puzzle };
  }

  it('going back to the table doesn’t start the count again', () => {
    const t = table(setup(), 'one');
    for (let i = 0; i < PUZZLE_STARTS.perTable; i++) expect(t.puzzle()).toBe(true);
    t.room.handle('s', { t: 'lobby' });
    t.play('jigsaw');
    expect(t.puzzle()).toBe(false);
  });

  it('one address can’t get round it with more tables', () => {
    const env = setup();
    let started = 0;
    for (let i = 0; i < 4; i++) {
      const t = table(env, 'one');
      for (let k = 0; k < PUZZLE_STARTS.perTable; k++) if (t.puzzle()) started++;
    }
    expect(started).toBe(PUZZLE_STARTS.perAddress);
    expect(table(env, 'another').puzzle()).toBe(true);
  });
});
