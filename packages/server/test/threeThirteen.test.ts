import { describe, expect, it } from 'vitest';
import { CARD_BACK_COUNT, Rng, ttBotDiscard, ttBotTakesDiscard, TT_ROUNDS, type ServerMessage, type ThreeThirteenView } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { RoomManager } from '../src/manager';
import type { Conn } from '../src/room';
import { ThreeThirteenGame } from '../src/games/threeThirteen';

class FakeConn implements Conn {
  sent: ServerMessage[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  views(): ThreeThirteenView[] {
    return this.sent.flatMap((m) => (m.t === 'g' && m.m.t === 'threethirteen' ? [m.m.view] : []));
  }
}

function setup() {
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

/** Two people at a table who pick Three Thirteen and both say they're ready. */
function table() {
  const env = setup();
  const a = joinPrivate(env.mgr, 'session-aaaa');
  const b = joinPrivate(env.mgr, 'session-bbbb', a.room.code);
  a.room.handle('session-aaaa', { t: 'pick', game: 'threethirteen' });
  a.room.handle('session-aaaa', { t: 'ready', ready: true });
  b.room.handle('session-bbbb', { t: 'ready', ready: true });
  return { ...env, a, b, game: a.room.game as ThreeThirteenGame };
}

const send = (room: ReturnType<typeof table>['a']['room'], session: string, m: object) => room.handle(session, { t: 'g', m } as never);

describe('Three Thirteen in a room', () => {
  it('deals 3 cards each in round 1, 3s wild, and nobody sees anyone else’s cards', () => {
    const { a, b, game } = table();
    expect(game.id).toBe('threethirteen');
    const v = a.conn.views().at(-1)!;
    expect(v.round).toBe(1);
    expect(v.wild).toBe(3);
    expect(v.cards).toHaveLength(3);
    expect(v.seats.map((s) => s.cards)).toEqual([3, 3, 3, 3]);
    expect(v.seats.filter((s) => s.bot)).toHaveLength(2);
    expect(v.plan!.melds.flat().length + v.plan!.loose.length).toBe(3);
    // One card back for the whole table, from the user's set.
    expect(v.back).toBeGreaterThanOrEqual(1);
    expect(v.back).toBeLessThanOrEqual(CARD_BACK_COUNT);
    expect(b.conn.views().at(-1)!.back).toBe(v.back);
    const raw = JSON.stringify(a.conn.sent);
    const mine = game.seatOf('session-aaaa')!;
    const hidden = [...game.round.hands.filter((_, i) => i !== mine).flat(), ...game.round.stock];
    for (const c of hidden) expect(raw.includes(`"${c}"`)).toBe(false);
  });

  it('a person draws, then throws away; out of turn does nothing', () => {
    const { a, b, game } = table();
    const r = game.round;
    const turn = r.turn;
    const [who, other] = game.seatOf('session-aaaa') === turn ? ['session-aaaa', 'session-bbbb'] : ['session-bbbb', 'session-aaaa'];
    if (game.seatOf(who) !== turn) return; // a computer starts; covered by the whole-game test
    send(a.room, other, { t: 'tt-draw', from: 'stock' });
    expect(r.step).toBe('draw');
    send(a.room, who, { t: 'tt-draw', from: 'discard' });
    expect(r.step).toBe('discard');
    const took = r.tookFromDiscard!;
    send(a.room, who, { t: 'tt-discard', card: took });
    expect(r.step).toBe('discard'); // can't throw back the card just taken
    const other2 = r.hands[turn].find((c) => c !== took)!;
    send(a.room, who, { t: 'tt-discard', card: other2 });
    expect(r.discardTop).toBe(other2);
    expect(r.turn).not.toBe(turn);
    expect(b.conn.views().length).toBeGreaterThan(0);
  });

  it('arranging a hand only changes that player’s own view', () => {
    const { a, b, game } = table();
    const mine = game.seatOf('session-aaaa')!;
    const order = [...game.round.hands[mine]].reverse();
    const before = b.conn.sent.length;
    send(a.room, 'session-aaaa', { t: 'tt-arrange', cards: order });
    expect(game.round.hands[mine]).toEqual(order);
    expect(a.conn.views().at(-1)!.cards).toEqual(order);
    expect(b.conn.sent.length).toBe(before);
    send(a.room, 'session-aaaa', { t: 'tt-arrange', cards: order.slice(1) });
    expect(game.round.hands[mine]).toEqual(order);
  });

  it('plays all 11 rounds with computers covering a disconnected player; lowest total wins', () => {
    const { a, b, game, mgr, clock } = table();
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    const sa = game.seatOf('session-aaaa')!;
    let guard = 0;
    while (game.phase !== 'gameOver' && guard++ < 200_000) {
      const r = game.round;
      if (game.phase === 'roundEnd') send(a.room, 'session-aaaa', { t: 'ready' });
      else if (game.phase === 'playing' && r.phase === 'playing' && r.turn === sa) {
        // Play our own turns the way a computer would.
        if (r.step === 'draw') send(a.room, 'session-aaaa', { t: 'tt-draw', from: ttBotTakesDiscard(r, sa) ? 'discard' : 'stock' });
        else send(a.room, 'session-aaaa', { t: 'tt-discard', card: ttBotDiscard(r, sa) });
      }
      clock.now += 100;
      mgr.stepAll();
    }
    expect(game.phase).toBe('gameOver');
    expect(game.history).toHaveLength(TT_ROUNDS);
    const low = Math.min(...game.seats.map((s) => s.score));
    expect(game.winners.every((i) => game.seats[i].score === low)).toBe(true);
    expect(a.room.chatHistory.some((m) => m.text.endsWith('won Three Thirteen!'))).toBe(true);
    expect(a.room.chatHistory.some((m) => m.text.endsWith('went out!'))).toBe(true);
    const last = a.conn.views().at(-1)!;
    expect(last.phase).toBe('gameOver');
    expect(last.result).not.toBeNull();
    send(a.room, 'session-aaaa', { t: 'again' });
    expect(game.phase).toBe('playing');
    expect(game.roundNumber).toBe(1);
    expect(game.seats.every((s) => s.score === 0)).toBe(true);
  });

  it('between rounds, waits until every person at the table is ready', () => {
    const { a, b, game, mgr, clock } = table();
    let guard = 0;
    const seats = ['session-aaaa', 'session-bbbb'];
    while (game.phase === 'playing' && guard++ < 100_000) {
      const r = game.round;
      for (const s of seats) {
        const seat = game.seatOf(s)!;
        if (r.phase !== 'playing' || r.turn !== seat) continue;
        if (r.step === 'draw') send(a.room, s, { t: 'tt-draw', from: 'stock' });
        else send(a.room, s, { t: 'tt-discard', card: ttBotDiscard(r, seat) });
      }
      clock.now += 100;
      mgr.stepAll();
    }
    expect(game.phase).toBe('roundEnd');
    run(mgr, clock, 60_000);
    expect(game.phase).toBe('roundEnd');
    send(a.room, 'session-aaaa', { t: 'ready' });
    expect(game.phase).toBe('roundEnd');
    send(b.room, 'session-bbbb', { t: 'ready' });
    expect(game.phase).toBe('playing');
    expect(game.roundNumber).toBe(2);
    expect(game.round.hands.every((h) => h.length === 4)).toBe(true);
  });
});

describe('Three Thirteen with fewer players', () => {
  /** People at a table who pick Three Thirteen, choose how many play, and say they're ready. */
  function tableOf(people: string[], players: number) {
    const env = setup();
    const first = joinPrivate(env.mgr, people[0]);
    for (const s of people.slice(1)) joinPrivate(env.mgr, s, first.room.code);
    const room = first.room;
    room.handle(people[0], { t: 'pick', game: 'threethirteen' });
    room.handle(people[0], { t: 'players', n: players });
    expect(room.tableSetup().players).toBe(players);
    for (const s of people) room.handle(s, { t: 'ready', ready: true });
    return { ...env, room, conn: first.conn, game: room.game as ThreeThirteenGame };
  }

  it('two people choosing 2 players: no computers dealt in', () => {
    const { conn, game } = tableOf(['session-aaaa', 'session-bbbb'], 2);
    expect(game.active).toHaveLength(2);
    expect(game.active.map((i) => game.seats[i].session).sort()).toEqual(['session-aaaa', 'session-bbbb']);
    const v = conn.views().at(-1)!;
    expect(v.seats.filter((s) => s.playing)).toHaveLength(2);
    expect(v.seats.filter((s) => s.playing && s.bot)).toHaveLength(0);
    expect(game.round.hands.filter((h) => h.length)).toHaveLength(2);
  });

  it('one person choosing 2 players: one computer', () => {
    const { game } = tableOf(['session-aaaa'], 2);
    expect(game.active).toHaveLength(2);
    expect(game.active.filter((i) => game.seats[i].session === null)).toHaveLength(1);
  });

  it('never fewer players than the people at the table', () => {
    const { game } = tableOf(['session-aaaa', 'session-bbbb', 'session-cccc'], 2);
    expect(game.active).toHaveLength(3);
  });

  it('two people play all 11 rounds on their own; only they can win', () => {
    const { room, game, mgr, clock } = tableOf(['session-aaaa', 'session-bbbb'], 2);
    let guard = 0;
    while (game.phase !== 'gameOver' && guard++ < 200_000) {
      const r = game.round;
      for (const s of ['session-aaaa', 'session-bbbb']) {
        const seat = game.seatOf(s)!;
        if (game.phase === 'roundEnd') room.handle(s, { t: 'g', m: { t: 'ready' } });
        else if (r.phase === 'playing' && r.turn === seat) {
          if (r.step === 'draw') room.handle(s, { t: 'g', m: { t: 'tt-draw', from: ttBotTakesDiscard(r, seat) ? 'discard' : 'stock' } });
          else room.handle(s, { t: 'g', m: { t: 'tt-discard', card: ttBotDiscard(r, seat) } });
        }
      }
      clock.now += 100;
      mgr.stepAll();
    }
    expect(game.phase).toBe('gameOver');
    expect(game.winners.every((i) => game.active.includes(i))).toBe(true);
  });
});

function run(mgr: RoomManager, clock: { now: number }, ms: number) {
  for (let t = 0; t < ms; t += 50) {
    clock.now += 50;
    mgr.stepAll();
  }
}
