import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { PIECE_COUNTS, PUZZLE_IMAGES, Rng, tableBounds, type ServerMessage, type GameId } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { JigsawGame } from '../src/games/jigsaw';
import { RoomManager } from '../src/manager';
import { PuzzleStore } from '../src/puzzleStore';
import type { Conn, RoomDeps, Room } from '../src/room';

/** Pick a game at the table and have everyone here say they're ready, so it starts. */
function play(room: Room, game: GameId) {
  const here = [...room.players.entries()].filter(([, p]) => p.conn);
  if (here.length) room.handle(here[0][0], { t: 'pick', game });
  for (const [s] of here) room.handle(s, { t: 'ready', ready: true });
}


class FakeConn implements Conn {
  sent: ServerMessage[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

type Pz = Extract<ServerMessage, { t: 'g' }>['m'];
const pz = <T extends Pz['t']>(c: FakeConn, t: T) => c.sent.flatMap((m) => (m.t === 'g' && m.m.t === t ? [m.m] : [])) as Extract<Pz, { t: T }>[];
const aliasOf = (c: FakeConn) => c.of('welcome')[0].alias;
const lastChat = (c: FakeConn) => c.of('chat').at(-1)!.msg.text;

function setup(over: Partial<RoomDeps> = {}) {
  const clock = { now: 1_000_000 };
  const rng = new Rng(11);
  const mgr = new RoomManager({
    now: () => clock.now,
    log: new MemoryLog(),
    moderator: new ChatModerator(),
    emptyRoomMs: 60_000,
    publicReclaimMs: 60_000,
    maxPublicRooms: 10,
    maxPrivateRooms: 10,
    chatHistorySize: 10,
    randomInt: (n) => rng.int(0, n - 1),
    ...over,
  });
  return { clock, mgr };
}

function joinPrivate(mgr: RoomManager, session: string, code?: string) {
  const lookup = mgr.resolve(code ? { kind: 'private', code } : { kind: 'create-private' }, session);
  if (!lookup.ok) throw new Error(lookup.code);
  const conn = new FakeConn();
  const r = lookup.room.join(conn, session, session.replace('session-', ''), 'desktop');
  if (!r.ok) throw new Error(r.code);
  lookup.room.sendWelcome(session, r);
  return { room: lookup.room, conn, session };
}

function run(mgr: RoomManager, clock: { now: number }, ms: number) {
  for (let t = 0; t < ms; t += 50) {
    clock.now += 50;
    mgr.stepAll();
  }
}

function jigsawRoom(over: Partial<RoomDeps> = {}) {
  const env = setup(over);
  const a = joinPrivate(env.mgr, 'session-aaaa');
  const b = joinPrivate(env.mgr, 'session-bbbb', a.room.code);
  play(a.room, 'jigsaw');
  const game = a.room.game as JigsawGame;
  const send = (who: 'a' | 'b', m: object) => a.room.handle(`session-${who.repeat(4)}`, { t: 'g', m } as never);
  return { ...env, a, b, game, send };
}

/** A 54-piece dog puzzle (9 x 6). */
function started(over: Partial<RoomDeps> = {}) {
  const r = jigsawRoom(over);
  r.send('a', { t: 'pz-new', image: 'dog', pieces: 50 });
  const s = r.game.state!;
  return { ...r, s, pw: s.width / s.cols, ph: s.height / s.rows };
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-puzzles-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The table's answer to "which saves are left?" comes once the disk has been read. */
const savesAnswers = (c: FakeConn, n: number) => vi.waitFor(() => expect(pz(c, 'pz-saves')).toHaveLength(n));

describe('jigsaw in a room', () => {
  it('starts on the picker, then deals a puzzle with every piece off the frame', () => {
    const { a, b, send, game } = jigsawRoom();
    expect(pz(a.conn, 'pz-state').at(-1)!.phase).toBe('setup');
    send('b', { t: 'pz-new', image: 'dog', pieces: 50 });
    const st = pz(a.conn, 'pz-state').at(-1)!;
    expect(st.phase).toBe('playing');
    const s = st.state!;
    expect(s.pieces).toHaveLength(54);
    expect(s.id).toMatch(/^[a-z0-9]{16}$/);
    const pw = s.width / s.cols;
    const ph = s.height / s.rows;
    for (const p of s.pieces) expect(p.x + pw <= 0 || p.x >= s.width || p.y + ph <= 0 || p.y >= s.height).toBe(true);
    expect(new Set(s.pieces.map((p) => p.g)).size).toBe(54);
    expect(lastChat(b.conn)).toContain('54-piece puzzle');
    // Nobody can start another one over the top of it.
    send('a', { t: 'pz-new', image: 'dog', pieces: 100 });
    expect(game.state!.id).toBe(s.id);
  });

  it('deals every picture at every size neatly: on the table, off the frame, no two in one spot', () => {
    for (const img of PUZZLE_IMAGES) {
      for (const n of [PIECE_COUNTS[0], PIECE_COUNTS.at(-1)!]) {
        const { send, game } = jigsawRoom();
        send('a', { t: 'pz-new', image: img.id, pieces: n });
        const s = game.state!;
        const pw = s.width / s.cols;
        const ph = s.height / s.rows;
        const b = tableBounds(s.width, s.height, s.cols, s.rows);
        const spots = new Set<string>();
        for (const p of s.pieces) {
          expect(p.x + pw <= 0 || p.x >= s.width || p.y + ph <= 0 || p.y >= s.height, `${img.id} ${n}`).toBe(true);
          expect(p.x >= b.minX && p.x + pw <= b.maxX && p.y >= b.minY && p.y + ph <= b.maxY, `${img.id} ${n}`).toBe(true);
          spots.add(`${Math.round(p.x / pw)},${Math.round(p.y / ph)}`);
        }
        expect(spots.size, `${img.id} ${n}`).toBe(s.pieces.length);
      }
    }
  });

  it('ignores pictures and piece counts that are not on the list', () => {
    const { send, game } = jigsawRoom();
    send('a', { t: 'pz-new', image: 'nope', pieces: 50 });
    send('a', { t: 'pz-new', image: 'dog', pieces: 77 });
    expect(game.phase).toBe('setup');
  });

  it('a piece held when its holder comes back on a new connection is let go', () => {
    // A phone hopping from Wi-Fi to mobile data: the new connection replaces one the server
    // still thinks is open, so nothing ever said "disconnected".
    const { a, b, send, mgr } = started();
    send('a', { t: 'pz-grab', piece: 5 });
    send('a', { t: 'pz-drag', x: -300, y: -200 });
    const again = joinPrivate(mgr, 'session-aaaa', a.room.code);
    expect(pz(again.conn, 'pz-state').at(-1)!.held).toEqual([]);
    expect(pz(b.conn, 'pz-held').at(-1)).toEqual({ t: 'pz-held', g: 5, by: null });
    // It rests where it was dragged to, and anyone can pick it up.
    expect(pz(b.conn, 'pz-moved').at(-1)!.pieces).toEqual([[5, -300, -200, 5]]);
    send('b', { t: 'pz-grab', piece: 5 });
    expect(pz(b.conn, 'pz-held').at(-1)).toEqual({ t: 'pz-held', g: 5, by: aliasOf(b.conn) });
  });

  it('the part of the picture already in the frame never moves, whatever joins it', () => {
    const { a, b, send, s, pw, ph } = started();
    const home = (i: number) => ({ x: (i % s.cols) * pw, y: Math.floor(i / s.cols) * ph });
    const place = (who: 'a' | 'b', i: number) => {
      send(who, { t: 'pz-grab', piece: i });
      send(who, { t: 'pz-drop', ...home(i) });
    };
    place('b', 0);
    expect(s.locked).toContain(s.pieces[0].g);
    // A carries piece 2 to a hair from its place, and drops out before letting go.
    send('a', { t: 'pz-grab', piece: 2 });
    send('a', { t: 'pz-drag', x: home(2).x + 0.2 * pw, y: home(2).y });
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    // B puts the piece between them exactly in its place: it joins both.
    place('b', 1);
    expect([s.pieces[0].g, s.pieces[1].g, s.pieces[2].g]).toEqual([s.pieces[0].g, s.pieces[0].g, s.pieces[0].g]);
    for (const i of [0, 1, 2]) expect({ x: s.pieces[i].x, y: s.pieces[i].y }).toEqual(home(i));
    void b;
  });

  it('lets one person hold a piece at a time', () => {
    const { a, b, send, s, mgr, clock } = started();
    send('a', { t: 'pz-grab', piece: 5 });
    expect(pz(b.conn, 'pz-held').at(-1)).toEqual({ t: 'pz-held', g: 5, by: aliasOf(a.conn) });
    const before = { ...s.pieces[5] };
    send('b', { t: 'pz-grab', piece: 5 });
    // B is told who has it, and B's moves do nothing.
    expect(pz(b.conn, 'pz-held').at(-1)).toEqual({ t: 'pz-held', g: 5, by: aliasOf(a.conn) });
    send('b', { t: 'pz-drag', x: 10, y: 10 });
    expect(s.pieces[5]).toEqual(before);
    // A's drags show up for B as they happen (and aren't echoed back to A).
    send('a', { t: 'pz-drag', x: -300, y: -200 });
    run(mgr, clock, 100); // drags go out together, 15 times a second
    expect(pz(b.conn, 'pz-drag').at(-1)).toMatchObject({ g: 5, piece: 5, x: -300, y: -200, by: aliasOf(a.conn) });
    expect(pz(a.conn, 'pz-drag')).toHaveLength(0);
    // Dropping lets go.
    send('a', { t: 'pz-drop', x: -300, y: -200 });
    expect(pz(b.conn, 'pz-held').at(-1)).toEqual({ t: 'pz-held', g: 5, by: null });
    send('b', { t: 'pz-grab', piece: 5 });
    expect(pz(a.conn, 'pz-held').at(-1)).toEqual({ t: 'pz-held', g: 5, by: aliasOf(b.conn) });
  });

  it('lets go of what you hold when you leave', () => {
    const { a, b, send } = started();
    send('b', { t: 'pz-grab', piece: 3 });
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    expect(pz(a.conn, 'pz-held').at(-1)).toEqual({ t: 'pz-held', g: 3, by: null });
  });

  it('snaps pieces that fit together, lined up exactly, and they move as one', () => {
    const { a, send, s, pw } = started();
    const left = { ...s.pieces[0] };
    send('a', { t: 'pz-grab', piece: 1 });
    // Dropped a little off from where it would sit next to piece 0.
    send('a', { t: 'pz-drop', x: left.x + pw + pw * 0.12, y: left.y - pw * 0.1 });
    expect(s.pieces[1].g).toBe(s.pieces[0].g);
    expect(s.pieces[1].x).toBeCloseTo(left.x + pw);
    expect(s.pieces[1].y).toBeCloseTo(left.y);
    expect(pz(a.conn, 'pz-moved').at(-1)!.snapped).toBe(true);
    // Moving either piece moves both.
    send('a', { t: 'pz-grab', piece: 0 });
    send('a', { t: 'pz-drop', x: -400, y: -300 });
    expect(s.pieces[1].x - s.pieces[0].x).toBeCloseTo(pw);
    expect(s.pieces[1].y - s.pieces[0].y).toBeCloseTo(0);
  });

  it('does not snap pieces that are not neighbours, or too far off', () => {
    const { send, s, pw } = started();
    const anchor = { ...s.pieces[0] };
    send('a', { t: 'pz-grab', piece: 2 });
    send('a', { t: 'pz-drop', x: anchor.x + pw, y: anchor.y });
    expect(s.pieces[2].g).not.toBe(s.pieces[0].g);
    send('a', { t: 'pz-grab', piece: 1 });
    send('a', { t: 'pz-drop', x: anchor.x + pw * 1.4, y: anchor.y });
    expect(s.pieces[1].g).not.toBe(s.pieces[0].g);
  });

  it('locks a group into the frame when it is dropped where it belongs, and then it stays put', () => {
    const { a, b, send, s, pw, ph } = started();
    const col = 10 % s.cols;
    const row = Math.floor(10 / s.cols);
    send('a', { t: 'pz-grab', piece: 10 });
    send('a', { t: 'pz-drop', x: col * pw + 4, y: row * ph - 3 });
    expect(s.locked).toContain(s.pieces[10].g);
    expect(s.pieces[10].x).toBeCloseTo(col * pw);
    expect(s.pieces[10].y).toBeCloseTo(row * ph);
    send('b', { t: 'pz-grab', piece: 10 });
    expect(pz(b.conn, 'pz-held').at(-1)).toEqual({ t: 'pz-held', g: s.pieces[10].g, by: '' });
    // A neighbour dropped next to it joins the frame too.
    send('a', { t: 'pz-grab', piece: 11 });
    send('a', { t: 'pz-drop', x: (col + 1) * pw - 5, y: row * ph + 2 });
    expect(s.pieces[11].g).toBe(s.pieces[10].g);
    expect(s.locked).toContain(s.pieces[11].g);
    expect(pz(a.conn, 'pz-moved').at(-1)!.locked).toEqual(s.locked);
  });

  it('keeps pieces on the table', () => {
    const { send, s } = started();
    send('a', { t: 'pz-grab', piece: 0 });
    send('a', { t: 'pz-drop', x: 1e5, y: -1e5 });
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    expect(s.pieces[0].x).toBeLessThanOrEqual(b.maxX);
    expect(s.pieces[0].x).toBeGreaterThan(b.maxX - s.width);
    expect(s.pieces[0].y).toBeCloseTo(b.minY);
  });

  it('keeps the whole of a joined strip on the table, whichever piece it’s held by', () => {
    const { send, s, pw, ph } = started();
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    // Five in a row, joined, and held by the right-hand one.
    for (let i = 0; i < 5; i++) Object.assign(s.pieces[i], { x: 100 + i * pw, y: -ph * 2, g: 0 });
    send('a', { t: 'pz-grab', piece: 4 });
    send('a', { t: 'pz-drag', x: -1e5, y: 1e5 });
    expect(s.pieces[0].x).toBeCloseTo(b.minX);
    expect(s.pieces[4].x).toBeCloseTo(b.minX + 4 * pw);
    expect(s.pieces[4].y + ph).toBeCloseTo(b.maxY);
    send('a', { t: 'pz-drop', x: 1e5, y: 1e5 });
    expect(s.pieces[4].x + pw).toBeLessThanOrEqual(b.maxX + 0.001);
  });

  it('a join at the edge leaves all of it on the table', () => {
    const { send, s, pw } = started();
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    const y = b.minY + 10;
    // A pair against the left edge, and the piece to their right a hair nearer than it should be.
    Object.assign(s.pieces[0], { x: b.minX, y, g: 0 });
    Object.assign(s.pieces[1], { x: b.minX + pw, y, g: 0 });
    Object.assign(s.pieces[2], { x: b.minX + 1.9 * pw, y });
    send('a', { t: 'pz-grab', piece: 1 });
    send('a', { t: 'pz-drop', x: b.minX + pw, y });
    expect(s.pieces[2].g).toBe(s.pieces[0].g);
    expect(s.pieces[0].x).toBeCloseTo(b.minX);
    expect(s.pieces[2].x).toBeCloseTo(b.minX + 2 * pw);
  });

  it('Continue isn’t dead at a table after a read that never came back', async () => {
    const store = new PuzzleStore(null);
    vi.spyOn(store, 'load').mockImplementation(() => new Promise(() => {}));
    const { a, send, mgr, clock } = jigsawRoom({ puzzles: store });
    send('a', { t: 'pz-resume', id: 'abcdefgh01234567' });
    run(mgr, clock, 5000);
    send('a', { t: 'pz-resume', id: 'abcdefgh01234567' });
    expect(store.load).toHaveBeenCalledTimes(1); // one read at a time
    run(mgr, clock, 6000);
    expect(lastChat(a.conn)).toContain('wouldn\'t open just now');
    send('a', { t: 'pz-resume', id: 'abcdefgh01234567' });
    expect(store.load).toHaveBeenCalledTimes(2);
  });

  it('a puzzle that couldn’t be opened doesn’t use up one of the hour’s starts', async () => {
    const { game, send, mgr, clock } = jigsawRoom();
    for (let i = 0; i < 25; i++) {
      send('a', { t: 'pz-resume', id: 'abcdefgh01234567' });
      await new Promise((r) => setTimeout(r, 0));
      run(mgr, clock, 1100);
    }
    send('a', { t: 'pz-new', image: 'dog', pieces: 50 });
    expect(game.phase).toBe('playing');
  });

  it('finishes when every piece is in one group', () => {
    const { a, b, send, s, pw, ph, game } = started();
    for (let i = 0; i < s.pieces.length; i++) {
      const who = i % 2 ? 'a' : 'b';
      send(who, { t: 'pz-grab', piece: i });
      send(who, { t: 'pz-drop', x: (i % s.cols) * pw + 2, y: Math.floor(i / s.cols) * ph + 2 });
    }
    expect(game.phase).toBe('done');
    expect(s.doneAt).not.toBeNull();
    expect(new Set(s.pieces.map((p) => p.g)).size).toBe(1);
    expect(pz(a.conn, 'pz-state').at(-1)!.phase).toBe('done');
    expect(lastChat(b.conn)).toContain('Puzzle finished');
    // Nothing more to pick up.
    const held = pz(a.conn, 'pz-held').length;
    send('a', { t: 'pz-grab', piece: 0 });
    expect(pz(a.conn, 'pz-held')).toHaveLength(held);
  });

  it('tidies loose pieces back off the frame, leaving groups alone', () => {
    const { b, send, s, pw, ph } = started();
    send('a', { t: 'pz-grab', piece: 1 });
    send('a', { t: 'pz-drop', x: s.pieces[0].x + pw, y: s.pieces[0].y });
    send('a', { t: 'pz-grab', piece: 20 });
    send('a', { t: 'pz-drop', x: s.width / 2, y: s.height / 2 });
    const pair = [{ ...s.pieces[0] }, { ...s.pieces[1] }];
    send('b', { t: 'pz-tidy' });
    const p = s.pieces[20];
    expect(p.x + pw <= 0 || p.x >= s.width || p.y + ph <= 0 || p.y >= s.height).toBe(true);
    expect([s.pieces[0], s.pieces[1]]).toEqual(pair);
    expect(lastChat(b.conn)).toContain('tidied');
  });

  it('saves to disk as you go, and anyone can bring it back later', () =>
    withDir(async (dir) => {
      const firstStore = new PuzzleStore(dir);
      const first = started({ puzzles: firstStore });
      const id = first.s.id;
      first.send('a', { t: 'pz-grab', piece: 1 });
      first.send('a', { t: 'pz-drop', x: first.s.pieces[0].x + first.pw, y: first.s.pieces[0].y });
      // Saved a few seconds after the change (not on every move).
      run(first.mgr, first.clock, 5_000);
      await firstStore.flush();
      const saved = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
      expect(saved.pieces[1].g).toBe(saved.pieces[0].g);

      // A different room, another day, picks it up again.
      const laterStore = new PuzzleStore(dir);
      const later = jigsawRoom({ puzzles: laterStore });
      later.send('b', { t: 'pz-saves', ids: [id, 'zzzzzzzzzzzzzzzz'] });
      await savesAnswers(later.b.conn, 1);
      const saves = pz(later.b.conn, 'pz-saves').at(-1)!.saves;
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({ id, image: 'dog', pieces: 54, done: false });
      expect(saves[0].progress).toBeCloseTo(2 / 54);
      later.send('b', { t: 'pz-resume', id });
      await vi.waitFor(() => expect(later.game.phase).toBe('playing'));
      expect(later.game.state!.pieces).toEqual(saved.pieces);
      expect(lastChat(later.a.conn)).toContain('brought back a puzzle');

      // Putting it away saves straight away.
      later.send('a', { t: 'pz-grab', piece: 30 });
      later.send('a', { t: 'pz-drop', x: -500, y: -400 });
      const spot = { ...later.game.state!.pieces[30] };
      later.send('a', { t: 'pz-setup' });
      expect(later.game.phase).toBe('setup');
      await laterStore.flush();
      const again = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
      expect(again.pieces[30]).toEqual(spot);
    }));

  it('starts at most 20 puzzles an hour at one table, and answers "which saves are left?" every few seconds at most', () =>
    withDir(async (dir) => {
      const store = new PuzzleStore(dir);
      const r = jigsawRoom({ puzzles: store });
      for (let i = 0; i < 20; i++) {
        r.send('a', { t: 'pz-new', image: 'dog', pieces: 50 });
        expect(r.game.phase).toBe('playing');
        r.send('a', { t: 'pz-setup' });
        r.clock.now += 10_000;
      }
      r.send('a', { t: 'pz-new', image: 'dog', pieces: 50 });
      expect(r.game.phase).toBe('setup');
      expect(lastChat(r.a.conn)).toContain('a lot of puzzles for one hour');
      // An hour after the first ones, there's room again.
      r.clock.now += 60 * 60_000;
      r.send('a', { t: 'pz-new', image: 'dog', pieces: 50 });
      expect(r.game.phase).toBe('playing');

      const asked = () => pz(r.b.conn, 'pz-saves').length;
      const ids = Array.from({ length: 40 }, () => 'zzzzzzzzzzzzzzzz');
      r.send('b', { t: 'pz-saves', ids });
      await savesAnswers(r.b.conn, 1);
      // Asked twice in the same moment (and with the same id 40 times): one answer, one look.
      expect(pz(r.b.conn, 'pz-saves')[0].gone).toEqual(['zzzzzzzzzzzzzzzz']);
      r.send('b', { t: 'pz-saves', ids });
      await new Promise((res) => setTimeout(res, 50));
      expect(asked()).toBe(1);
      r.clock.now += 3_000;
      r.send('b', { t: 'pz-saves', ids });
      await savesAnswers(r.b.conn, 2);
      await store.flush();
    }));

  it('sweeps away saves nobody has played in 30 days', () =>
    withDir(async (dir) => {
      const store = new PuzzleStore(dir);
      const { s, send, pw, mgr, clock } = started({ puzzles: store });
      send('a', { t: 'pz-grab', piece: 1 });
      send('a', { t: 'pz-drop', x: s.pieces[0].x + pw, y: s.pieces[0].y });
      run(mgr, clock, 5_000);
      await store.flush();
      const file = path.join(dir, `${s.id}.json`);
      expect(await store.sweep(Date.now())).toBe(0);
      const recent = new Date(Date.now() - 29 * 86_400_000);
      fs.utimesSync(file, recent, recent);
      expect(await store.sweep(Date.now())).toBe(0);
      const old = new Date(Date.now() - 31 * 86_400_000);
      fs.utimesSync(file, old, old);
      expect(await store.sweep(Date.now(), undefined, 'old')).toBe(1); // the 6-hourly sweep
      expect(fs.existsSync(file)).toBe(false);
    }));

  it('does not keep a puzzle with nothing placed in it', () =>
    withDir(async (dir) => {
      const store = new PuzzleStore(dir);
      const { a, s, send, mgr, clock, game } = started({ puzzles: store });
      const file = path.join(dir, `${s.id}.json`);
      // Moving pieces around isn't placing them.
      send('a', { t: 'pz-grab', piece: 4 });
      send('a', { t: 'pz-drop', x: s.width / 2, y: s.height / 2 });
      run(mgr, clock, 5_000);
      await store.flush();
      expect(fs.existsSync(file)).toBe(false);
      send('b', { t: 'pz-setup' });
      expect(game.phase).toBe('setup');
      await store.flush();
      expect(fs.existsSync(file)).toBe(false);
      expect(lastChat(a.conn)).toContain("wasn't kept");
      // Asking about it says it's gone (so the browser forgets it); so does trying to continue it.
      send('a', { t: 'pz-saves', ids: [s.id] });
      await savesAnswers(a.conn, 1);
      expect(pz(a.conn, 'pz-saves').at(-1)).toEqual({ t: 'pz-saves', saves: [], gone: [s.id] });
      send('a', { t: 'pz-resume', id: s.id });
      await savesAnswers(a.conn, 2);
      expect(game.phase).toBe('setup');
      expect(pz(a.conn, 'pz-saves').at(-1)!.gone).toEqual([s.id]);
    }));

  it('keeps a puzzle once one piece is in the frame, even with nothing joined', () =>
    withDir(async (dir) => {
      const store = new PuzzleStore(dir);
      const { a, s, send } = started({ puzzles: store });
      send('a', { t: 'pz-grab', piece: 0 });
      send('a', { t: 'pz-drop', x: 3, y: 3 });
      expect(s.locked).toHaveLength(1);
      send('a', { t: 'pz-setup' });
      await store.flush();
      expect(fs.existsSync(path.join(dir, `${s.id}.json`))).toBe(true);
      expect(lastChat(a.conn)).toContain("it's saved");
      send('a', { t: 'pz-saves', ids: [s.id] });
      await savesAnswers(a.conn, 1);
      expect(pz(a.conn, 'pz-saves').at(-1)!.saves.map((x) => x.id)).toEqual([s.id]);
    }));

  it('clears out old saves with nothing placed when the server starts', () =>
    withDir(async (dir) => {
      const keepStore = new PuzzleStore(dir);
      const keep = started({ puzzles: keepStore });
      keep.send('a', { t: 'pz-grab', piece: 1 });
      keep.send('a', { t: 'pz-drop', x: keep.s.pieces[0].x + keep.pw, y: keep.s.pieces[0].y });
      keep.send('a', { t: 'pz-setup' });
      await keepStore.flush();
      // A save from before untouched puzzles stopped being kept.
      const stale = { ...keep.s, id: 'abcdefgh01234567', pieces: keep.s.pieces.map((p, i) => ({ ...p, g: i })), locked: [] };
      fs.writeFileSync(path.join(dir, `${stale.id}.json`), JSON.stringify(stale));
      const store = new PuzzleStore(dir);
      expect(await store.sweep(Date.now())).toBe(1);
      expect(await store.load(stale.id)).toBeNull();
      expect(await store.load(keep.s.id)).not.toBeNull();
    }));

  it('will not load a save that has been tampered with', () =>
    withDir(async (dir) => {
      const store = new PuzzleStore(dir);
      fs.writeFileSync(path.join(dir, 'abcdefgh01234567.json'), JSON.stringify({ id: 'abcdefgh01234567', cols: 1000, rows: 1000 }));
      fs.writeFileSync(path.join(dir, 'abcdefgh01234568.json'), 'not json');
      expect(await store.load('abcdefgh01234567')).toBeNull();
      expect(await store.load('abcdefgh01234568')).toBeNull();
      expect(await store.load('../../etc/passwd')).toBeNull();
    }));

  it('has every picture on disk at the size the list says, with a thumbnail', async () => {
    const dir = path.join(__dirname, '../../client/public');
    for (const img of PUZZLE_IMAGES) {
      const m = await sharp(path.join(dir, img.file)).metadata();
      expect([m.width, m.height], img.id).toEqual([img.width, img.height]);
      expect(fs.existsSync(path.join(dir, img.thumb)), img.thumb).toBe(true);
    }
  });
});
