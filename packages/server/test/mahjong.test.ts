import { describe, expect, it } from 'vitest';
import { mjBotClaim, mjBotTurn, Rng, type MahjongView, type ServerMessage } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { RoomManager } from '../src/manager';
import type { Conn } from '../src/room';
import { MahjongGame, MJ_CLAIM_ALONE_MS, MJ_CLAIM_MAX_MS, MJ_CLAIM_MIN_MS, MJ_CLAIM_SPREAD_MS } from '../src/games/mahjong';

class FakeConn implements Conn {
  sent: ServerMessage[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  views(): MahjongView[] {
    return this.sent.flatMap((m) => (m.t === 'g' && m.m.t === 'mahjong' ? [m.m.view] : []));
  }
}

function setup() {
  const clock = { now: 1_000_000 };
  const rng = new Rng(7);
  const mgr = new RoomManager({
    now: () => clock.now,
    log: new MemoryLog(),
    moderator: new ChatModerator(),
    emptyRoomMs: 60_000,
    maxPrivateRooms: 10,
    chatHistorySize: 50,
    randomInt: (n) => rng.int(0, n - 1),
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
  return { room: lookup.room, conn };
}

/** Two people at a table who pick Mahjong (with the given choices) and both say they're ready. */
function table(rules?: { points: boolean; full: boolean; learning?: boolean }) {
  const env = setup();
  const a = joinPrivate(env.mgr, 'session-aaaa');
  const b = joinPrivate(env.mgr, 'session-bbbb', a.room.code);
  a.room.handle('session-aaaa', { t: 'pick', game: 'mahjong' });
  if (rules) a.room.handle('session-aaaa', { t: 'mj-rules', ...rules });
  a.room.handle('session-aaaa', { t: 'sit', seat: 0 });
  a.room.handle('session-aaaa', { t: 'ready', ready: true });
  b.room.handle('session-bbbb', { t: 'ready', ready: true });
  return { ...env, a, b, game: a.room.game as MahjongGame };
}

const send = (room: ReturnType<typeof table>['a']['room'], session: string, m: object) => room.handle(session, { t: 'g', m } as never);

function run(env: ReturnType<typeof table>, ms: number) {
  for (let t = 0; t < ms; t += 100) {
    env.clock.now += 100;
    env.mgr.stepAll();
  }
}

/** Play both people's turns the way a computer would until `until` says stop. */
function playPeople(env: ReturnType<typeof table>, until: () => boolean, ready = true) {
  const { a, game } = env;
  const people = ['session-aaaa', 'session-bbbb'];
  let guard = 0;
  while (!until() && guard++ < 200_000) {
    const h = game.hand;
    for (const s of people) {
      const seat = game.seatOf(s)!;
      if (game.phase === 'handEnd' && ready) send(a.room, s, { t: 'ready' });
      if (game.opening === 'dice' && game.dealer === seat) send(a.room, s, { t: 'mj-roll' });
      if (game.phase !== 'playing' || !h) continue;
      if (game.claim?.waiting.has(seat)) {
        const c = mjBotClaim(h, seat);
        send(a.room, s, { t: 'mj-claim', claim: c.t, ...(c.chow && { chow: c.chow }) });
      } else if (!game.claim && h.step === 'discard' && h.turn === seat) {
        const act = mjBotTurn(h, seat);
        send(a.room, s, act.t === 'win' ? { t: 'mj-win' } : act.t === 'kong' ? { t: 'mj-kong', tile: act.tile } : { t: 'mj-discard', tile: act.tile });
      }
    }
    env.clock.now += 100;
    env.mgr.stepAll();
  }
}

describe('Mahjong at a table', () => {
  it('opens with the shuffle, waits for the dealer’s dice, then deals', () => {
    const env = table();
    const { a, game } = env;
    expect(game.id).toBe('mahjong');
    expect(game.seatOf('session-aaaa')).toBe(0);
    expect(game.phase).toBe('opening');
    expect(game.opening).toBe('shuffle');
    run(env, 3000);
    // Seat 0 deals first, and it's a person: the dice wait for them.
    expect(game.opening).toBe('dice');
    run(env, 2000);
    expect(game.opening).toBe('dice');
    send(a.room, 'session-bbbb', { t: 'mj-roll' });
    expect(game.opening).toBe('dice');
    send(a.room, 'session-aaaa', { t: 'mj-roll' });
    expect(game.opening).toBe('deal');
    expect(game.dice).toHaveLength(3);
    run(env, 4500);
    expect(game.phase).toBe('playing');
    const v = a.conn.views().at(-1)!;
    expect(v.tiles).toHaveLength(14);
    expect(v.seats.map((s) => s.wind)).toEqual([0, 1, 2, 3]);
    expect(v.seats.filter((s) => s.bot)).toHaveLength(2);
    expect(v.self).not.toBeNull();
  });

  it('the dice roll by themselves if the dealer doesn’t', () => {
    const env = table();
    run(env, 3000 + 6500);
    expect(env.game.opening).not.toBe('dice');
    expect(env.game.dice).not.toBeNull();
  });

  it('nobody ever sees anyone else’s tiles or the wall', () => {
    const env = table();
    playPeople(env, () => env.game.phase === 'playing' && (env.game.hand?.discardsMade ?? 0) >= 12);
    const { a, b, game } = env;
    const h = game.hand!;
    // Every view either person was sent, through the deal, turns and tiles on offer.
    for (const [who, seat] of [[a, 0], [b, 1]] as const) {
      const views = who.conn.views();
      expect(views.some((v) => v.offer)).toBe(true);
      for (const v of views) {
        // Everyone else's tiles, and the wall, are only ever counted.
        for (const s of v.seats) expect(typeof s.tiles).toBe('number');
        for (const x of Object.values(v.wall)) expect(typeof x).toBe('number');
        // (Before b has a seat, b watches: and sees no tiles at all.)
        if (v.seat === null) {
          expect([v.tiles, v.drawn, v.options, v.self]).toEqual([[], null, null, null]);
          continue;
        }
        expect(v.seat).toBe(seat);
        expect(v.tiles).toHaveLength(v.seats[seat].tiles);
        // No hand is shown before it's over; the tile just drawn only to whoever drew it.
        if (v.phase === 'playing') expect(v.result).toBeNull();
        if (v.drawn) expect(v.turn).toBe(seat);
        if (v.self) expect(v.turn).toBe(seat);
        // The buttons (and the time to use them) only go to someone who can take the tile.
        if (v.options) expect(v.options.win || v.options.kong || v.options.pung || v.options.chows.length > 0).toBe(true);
        if (v.claimMs !== null) expect(v.options).not.toBeNull();
      }
      // And the tiles listed are exactly the ones held.
      expect([...views.at(-1)!.tiles].sort()).toEqual([...h.hands[seat]].sort());
    }
    expect(a.conn.views().at(-1)!.seats.map((s) => s.tiles)).toEqual(h.hands.map((x) => x.length));
  });

  it('after a discard, waits 1.5-2 s even when nobody can take it', () => {
    const env = table();
    playPeople(env, () => env.game.phase === 'playing' && env.game.hand!.turn === 0 && env.game.hand!.step === 'discard' && !env.game.claim);
    const { a, game } = env;
    const h = game.hand!;
    // Throw away a tile; then count how long until play moves on.
    send(a.room, 'session-aaaa', { t: 'mj-discard', tile: mjBotTurn(h, 0).t === 'discard' ? (mjBotTurn(h, 0) as { tile: string }).tile : h.hands[0][0] });
    expect(game.claim).not.toBeNull();
    const c = game.claim!;
    expect(c.minAt - env.clock.now).toBeGreaterThanOrEqual(MJ_CLAIM_MIN_MS);
    expect(c.minAt - env.clock.now).toBeLessThanOrEqual(MJ_CLAIM_MIN_MS + MJ_CLAIM_SPREAD_MS);
    expect(c.maxAt - env.clock.now).toBeLessThanOrEqual(MJ_CLAIM_MAX_MS);
    // Session b answers straight away if it can; the window still isn't over before the pause.
    if (c.waiting.has(1)) send(a.room, 'session-bbbb', { t: 'mj-claim', claim: 'pass' });
    env.clock.now += MJ_CLAIM_MIN_MS - 200;
    env.mgr.stepAll();
    expect(game.claim).toBe(c);
  });

  it('a person who can take a discard gets the buttons and up to 15 s', () => {
    const env = table();
    let seen: MahjongView | undefined;
    playPeople(env, () => {
      seen = env.b.conn.views().at(-1);
      return !!seen?.options;
    });
    expect(seen!.options).not.toBeNull();
    expect(seen!.claimMs).toBeGreaterThan(MJ_CLAIM_MIN_MS);
    expect(seen!.claimMs).toBeLessThanOrEqual(MJ_CLAIM_MAX_MS);
    // Saying nothing is a pass once the time is up.
    const c = env.game.claim!;
    expect(c.waiting.has(1)).toBe(true);
    run(env, MJ_CLAIM_MAX_MS - 600);
    expect(env.game.claim).toBe(c);
    run(env, 800);
    expect(env.game.claim).not.toBe(c);
  });

  it('one person alone with the computers gets a whole minute to decide', () => {
    const env = setup();
    const a = joinPrivate(env.mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'pick', game: 'mahjong' });
    a.room.handle('session-aaaa', { t: 'sit', seat: 0 });
    a.room.handle('session-aaaa', { t: 'ready', ready: true });
    const alone = { ...env, a, b: a, game: a.room.game as MahjongGame };
    playPeople(alone, () => !!alone.game.claim?.waiting.has(0));
    const c = alone.game.claim!;
    expect(c.maxAt - env.clock.now).toBe(MJ_CLAIM_ALONE_MS);
    expect(a.conn.views().at(-1)!.claimMs).toBe(MJ_CLAIM_ALONE_MS);
  });

  it('without points: hands go on with the deal passing, and wins are counted', () => {
    const env = table();
    playPeople(env, () => env.game.handNumber > 4);
    const { game, a } = env;
    expect(game.history).toHaveLength(4);
    expect(game.dealer).toBe(0);
    expect(game.phase).not.toBe('gameOver');
    const wins = game.seats.reduce((n, s) => n + s.wins, 0);
    expect(game.history.at(-1)!.reduce((x, y) => x + y, 0)).toBe(wins);
    expect(a.room.chatHistory.some((m) => /went Mahjong|nobody won/.test(m.text))).toBe(true);
  });

  it('with points, one round: plays until the deal has gone round, points add up to zero', () => {
    const env = table({ points: true, full: false });
    expect(env.a.conn.sent.some((m) => m.t === 'table' && m.table.mahjong.points)).toBe(true);
    playPeople(env, () => env.game.phase === 'gameOver');
    const { game, a } = env;
    expect(game.phase).toBe('gameOver');
    expect(game.dealerPasses).toBe(4);
    expect(game.seats.reduce((n, s) => n + s.points, 0)).toBe(0);
    const top = Math.max(...game.seats.map((s) => s.points));
    expect(game.winners.every((i) => game.seats[i].points === top)).toBe(true);
    expect(a.room.chatHistory.some((m) => m.text.endsWith('won Mahjong!'))).toBe(true);
    send(a.room, 'session-aaaa', { t: 'again' });
    expect(game.phase).toBe('opening');
    expect(game.seats.every((s) => s.points === 0)).toBe(true);
  });

  it('between hands, waits for every person to be ready', () => {
    const env = table();
    playPeople(env, () => env.game.phase === 'handEnd', false);
    const { a, b, game } = env;
    const v = a.conn.views().at(-1)!;
    expect(v.result).not.toBeNull();
    expect(v.result!.hands).toHaveLength(4);
    run(env, 30_000);
    expect(game.phase).toBe('handEnd');
    send(a.room, 'session-aaaa', { t: 'ready' });
    expect(game.phase).toBe('handEnd');
    send(b.room, 'session-bbbb', { t: 'ready' });
    expect(game.phase).toBe('opening');
  });

  it('every Pung, Chow and Kong shows in Messages, but isn’t kept for people who arrive later', () => {
    const env = table();
    const notes = () => env.a.conn.sent.flatMap((m) => (m.t === 'chat' && m.msg.system && /for a (Pung|Chow|Kong)|a Kong/.test(m.msg.text) ? [m.msg.text] : []));
    playPeople(env, () => notes().length > 0 || env.game.handNumber > 6);
    expect(notes().length).toBeGreaterThan(0);
    expect(notes()[0]).toMatch(/^.+ (took .+’s .+ for a (Pung|Chow|Kong)|added the fourth .+|made a Kong of .+)/);
    expect(env.a.room.chatHistory.some((m) => notes().includes(m.text))).toBe(false);
  });

  it('the table’s Mahjong choices only change while Mahjong is picked', () => {
    const env = setup();
    const a = joinPrivate(env.mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'mj-rules', points: true, full: true });
    expect(a.room.tableSetup().mahjong).toEqual({ points: false, full: false, learning: false });
    a.room.handle('session-aaaa', { t: 'pick', game: 'mahjong' });
    a.room.handle('session-aaaa', { t: 'mj-rules', points: true, full: true });
    expect(a.room.tableSetup().mahjong).toEqual({ points: true, full: true, learning: false });
    // A full game only means anything with points.
    a.room.handle('session-aaaa', { t: 'mj-rules', points: false, full: true });
    expect(a.room.tableSetup().mahjong).toEqual({ points: false, full: false, learning: false });
    // Learning Mode always plays without points.
    a.room.handle('session-aaaa', { t: 'mj-rules', points: true, full: true, learning: true });
    expect(a.room.tableSetup().mahjong).toEqual({ points: false, full: false, learning: true });
  });

  it('Learning Mode: every discard asks each person, whether or not they can take it, with no time limit', () => {
    const env = setup();
    const a = joinPrivate(env.mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'pick', game: 'mahjong' });
    a.room.handle('session-aaaa', { t: 'mj-rules', points: false, full: false, learning: true });
    a.room.handle('session-aaaa', { t: 'sit', seat: 0 });
    a.room.handle('session-aaaa', { t: 'ready', ready: true });
    const alone = { ...env, a, b: a, game: a.room.game as MahjongGame };
    let asked = 0;
    let nothingToTake = 0;
    playPeople(alone, () => {
      const c = alone.game.claim;
      const h = alone.game.hand;
      if (!c || !h || h.step !== 'claim' || h.lastDiscard?.seat === 0 || !c.waiting.has(0)) return false;
      // Asked: the choices (even with nothing to take), and no timer.
      const v = a.conn.views().at(-1)!;
      expect(v.options).not.toBeNull();
      expect(v.claimMs).toBeNull();
      expect(c.maxAt).toBe(Infinity);
      asked++;
      if (!h.claimants().includes(0)) nothingToTake++;
      // The game waits, however long it takes.
      run(alone, 120_000);
      expect(alone.game.claim).toBe(c);
      send(a.room, 'session-aaaa', { t: 'mj-claim', claim: 'pass' });
      run(alone, MJ_CLAIM_MIN_MS + MJ_CLAIM_SPREAD_MS + 100);
      expect(alone.game.claim).not.toBe(c);
      return asked >= 3 && nothingToTake > 0;
    });
    expect(asked).toBeGreaterThanOrEqual(3);
    expect(nothingToTake).toBeGreaterThan(0);
  });

  it('Learning Mode: your own discards don’t ask you', () => {
    const env = setup();
    const a = joinPrivate(env.mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'pick', game: 'mahjong' });
    a.room.handle('session-aaaa', { t: 'mj-rules', points: false, full: false, learning: true });
    a.room.handle('session-aaaa', { t: 'sit', seat: 0 });
    a.room.handle('session-aaaa', { t: 'ready', ready: true });
    const alone = { ...env, a, b: a, game: a.room.game as MahjongGame };
    playPeople(alone, () => !!alone.game.claim && alone.game.hand?.lastDiscard?.seat === 0 && alone.game.hand.step === 'claim');
    expect(alone.game.claim!.waiting.has(0)).toBe(false);
    expect(a.conn.views().at(-1)!.options).toBeNull();
  });
});
