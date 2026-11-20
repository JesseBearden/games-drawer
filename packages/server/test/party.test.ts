import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { botPass, botPlay, DOMINOES_RULES, dominoesBotMove, gameInfo, Rng, spadesBotBid, spadesBotPlay, type DominoesView, type HeartsView, type RoomRequest, type ServerMessage, type SpadesView } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { HAND_END_MS, HeartsGame, TRICK_PAUSE_MS } from '../src/games/hearts';
import { SpadesGame } from '../src/games/spades';
import { DominoesGame } from '../src/games/dominoes';
import { RoomManager } from '../src/manager';
import { GAME_SWITCH_COOLDOWN_MS, IDLE_ROOM_MS, IDLE_WARNING_MS, turnCredentials, type Conn, type RoomDeps } from '../src/room';

class FakeConn implements Conn {
  sent: ServerMessage[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  views(): HeartsView[] {
    return this.sent.flatMap((m) => (m.t === 'g' && m.m.t === 'hearts' ? [m.m.view] : []));
  }
  lastView() {
    return this.views().at(-1)!;
  }
}

function setup(over: Partial<RoomDeps> = {}) {
  const clock = { now: 1_000_000 };
  const log = new MemoryLog();
  const rng = new Rng(7);
  const mgr = new RoomManager({
    now: () => clock.now,
    log,
    moderator: new ChatModerator(),
    emptyRoomMs: 60_000,
    publicReclaimMs: 60_000,
    maxPublicRooms: 10,
    maxPrivateRooms: 10,
    chatHistorySize: 10,
    randomInt: (n) => rng.int(0, n - 1),
    ...over,
  });
  return { clock, log, mgr };
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

/** Advance the clock and run the room until `until` holds (or a time limit). */
function run(mgr: RoomManager, clock: { now: number }, ms: number, until?: () => boolean) {
  for (let t = 0; t < ms; t += 50) {
    clock.now += 50;
    for (let i = 0; i < 3; i++) mgr.stepAll();
    if (until?.()) return;
  }
}

describe('private rooms are parties', () => {
  it('open on the lobby with no game running', () => {
    const { mgr } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    const welcome = a.conn.of('welcome')[0];
    expect(welcome.game).toBeNull();
    expect(welcome.members.map((m) => m.name)).toEqual(['aaaa']);
    expect(a.room.game).toBeNull();
    mgr.stepAll();
    expect(a.conn.sent.some((m) => m.t === 'g')).toBe(false);
  });

  it('tell everyone who is in the room as people come and go', () => {
    const { mgr } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    const b = joinPrivate(mgr, 'session-bbbb', a.room.code);
    expect(a.conn.of('members').at(-1)!.members.map((m) => m.name)).toEqual(['aaaa', 'bbbb']);
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    const after = a.conn.of('members').at(-1)!.members;
    expect(after.find((m) => m.name === 'bbbb')!.connected).toBe(false);
    // Each person gets a different colour.
    expect(new Set(after.map((m) => m.color)).size).toBe(2);
  });

  it('anyone can start a game, and anyone can take the room back to the lobby', () => {
    const { mgr, clock } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    const b = joinPrivate(mgr, 'session-bbbb', a.room.code);
    b.room.handle('session-bbbb', { t: 'pick', game: 'tanks' });
    expect(a.room.game?.id).toBe('tanks');
    expect(a.conn.of('game').at(-1)!.game).toBe('tanks');
    // Both get the tank game's start-up message after the switch.
    for (const c of [a.conn, b.conn]) expect(c.sent.some((m) => m.t === 'g' && m.m.t === 'init')).toBe(true);
    expect(a.room.tanks!.world.tanks.size).toBe(4);
    // A second pick while playing doesn't switch.
    clock.now += GAME_SWITCH_COOLDOWN_MS;
    a.room.handle('session-aaaa', { t: 'pick', game: 'hearts' });
    expect(a.room.game?.id).toBe('tanks');
    a.room.handle('session-aaaa', { t: 'lobby' });
    expect(a.room.game).toBeNull();
    expect(b.conn.of('game').at(-1)!.game).toBeNull();
    clock.now += GAME_SWITCH_COOLDOWN_MS;
    a.room.handle('session-aaaa', { t: 'pick', game: 'hearts' });
    expect(a.room.game?.id).toBe('hearts');
    const chat = a.room.chatHistory.map((m) => m.text);
    expect(chat).toContain('bbbb started Tanks.');
    expect(chat).toContain('aaaa ended Tanks. Back to the lobby.');
    expect(chat).toContain('aaaa started Hearts.');
  });

  it('throttles game switching', () => {
    const { mgr } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'pick', game: 'tanks' });
    a.room.handle('session-aaaa', { t: 'lobby' });
    expect(a.room.game?.id).toBe('tanks');
  });

  it('a pick made right after Switch game waits out the cooldown instead of being lost', () => {
    const { mgr, clock } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'pick', game: 'tanks' });
    clock.now += GAME_SWITCH_COOLDOWN_MS;
    a.room.handle('session-aaaa', { t: 'lobby' });
    expect(a.room.game).toBeNull();
    // Picked straight away: held for now…
    a.room.handle('session-aaaa', { t: 'pick', game: 'hearts' });
    expect(a.room.game).toBeNull();
    a.room.step();
    expect(a.room.game).toBeNull();
    // …and started once the cooldown is over.
    clock.now += GAME_SWITCH_COOLDOWN_MS;
    a.room.step();
    expect(a.room.game?.id).toBe('hearts');
  });

  it('public rooms always play tanks', () => {
    const { mgr } = setup();
    const lookup = mgr.resolve({ kind: 'public' }, 'session-aaaa');
    if (!lookup.ok) throw new Error();
    const conn = new FakeConn();
    const r = lookup.room.join(conn, 'session-aaaa', 'a', 'desktop');
    if (!r.ok) throw new Error();
    lookup.room.sendWelcome('session-aaaa', r);
    lookup.room.handle('session-aaaa', { t: 'lobby' });
    lookup.room.handle('session-aaaa', { t: 'pick', game: 'hearts' });
    expect(lookup.room.game?.id).toBe('tanks');
  });

  it('public players are matched by game, and a newcomer takes a bot’s seat at once', () => {
    const { mgr } = setup();
    const join = (session: string, room: RoomRequest) => {
      const lookup = mgr.resolve(room, session);
      if (!lookup.ok) throw new Error(lookup.code);
      const r = lookup.room.join(new FakeConn(), session, session, 'desktop');
      if (!r.ok) throw new Error(r.code);
      lookup.room.sendWelcome(session, r);
      return lookup.room;
    };
    // Hearts is private-only while it's finished; open it up here to test public card tables.
    const info = gameInfo('hearts');
    const was = info.availability;
    info.availability = 'public';
    try {
      const h1 = join('session-h1', { kind: 'public', game: 'hearts' });
      const t1 = join('session-t1', { kind: 'public', game: 'tanks' });
      const h2 = join('session-h2', { kind: 'public', game: 'hearts' });
      const t2 = join('session-t2', { kind: 'public' });
      const j1 = join('session-j1', { kind: 'public', game: 'jigsaw' });
      const j2 = join('session-j2', { kind: 'public', game: 'jigsaw' });
      expect(h1.game?.id).toBe('hearts');
      expect(h2).toBe(h1);
      expect(t1.game?.id).toBe('tanks');
      expect(t2).toBe(t1);
      expect(j1.game?.id).toBe('jigsaw');
      expect(j2).toBe(j1);
      expect(j1.kind).toBe('public');
      const hearts = h1.game as HeartsGame;
      expect(hearts.seatOf('session-h1')).not.toBeNull();
      expect(hearts.seatOf('session-h2')).not.toBeNull();
    } finally {
      info.availability = was;
    }
  });

  it('only Tanks and Jigsaw are open to everyone; the card and tile games are private rooms only', () => {
    const { mgr } = setup();
    for (const game of ['tanks', 'jigsaw'] as const) expect(mgr.resolve({ kind: 'public', game }, `session-${game}`).ok).toBe(true);
    for (const game of ['hearts', 'spades', 'dominoes'] as const) {
      expect(mgr.resolve({ kind: 'public', game }, `session-${game}`).ok).toBe(false);
      expect(gameInfo(game).underConstruction).toBe(true);
      expect(mgr.resolve({ kind: 'create-private', game }, `session-p-${game}`).ok).toBe(true);
    }
  });

  it('a private room made from a game’s page opens straight into that game', () => {
    const { mgr } = setup();
    const lookup = mgr.resolve({ kind: 'create-private', game: 'hearts' }, 'session-aaaa');
    if (!lookup.ok) throw new Error();
    expect(lookup.room.kind).toBe('private');
    expect(lookup.room.game?.id).toBe('hearts');
    // Without a game it opens on the lobby, as before.
    const plain = mgr.resolve({ kind: 'create-private' }, 'session-bbbb');
    expect(plain.ok && plain.room.game).toBeNull();
  });

  it('respects each game’s rollout: private-only games can’t be played publicly, off games not at all', () => {
    const { mgr } = setup();
    const info = gameInfo('hearts');
    const was = info.availability;
    try {
      info.availability = 'private';
      const pub = mgr.resolve({ kind: 'public', game: 'hearts' }, 'session-aaaa');
      expect(pub.ok).toBe(false);
      const priv = joinPrivate(mgr, 'session-bbbb');
      priv.room.handle('session-bbbb', { t: 'pick', game: 'hearts' });
      expect(priv.room.game?.id).toBe('hearts');

      info.availability = 'off';
      const other = joinPrivate(mgr, 'session-cccc');
      other.room.handle('session-cccc', { t: 'pick', game: 'hearts' });
      expect(other.room.game).toBeNull();
      expect(mgr.resolve({ kind: 'create-private', game: 'hearts' }, 'session-dddd').ok).toBe(false);
    } finally {
      info.availability = was;
    }
  });

  it('logs one summary per game played: how long, how many at once, and how much chat', () => {
    const { mgr, clock, log } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    const b = joinPrivate(mgr, 'session-bbbb', a.room.code);
    a.room.handle('session-aaaa', { t: 'pick', game: 'dominoes' });
    clock.now += 60_000; // both play for a minute
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    clock.now += 30_000; // then one alone for half a minute
    a.room.handle('session-aaaa', { t: 'chat', text: 'good game' });
    a.room.handle('session-aaaa', { t: 'lobby' });
    const s = log.events.filter((e) => e.type === 'game_session');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      game: 'dominoes',
      endedBy: 'lobby',
      ms: 90_000,
      activeMs: 90_000,
      groupMs: 60_000,
      personMs: 150_000,
      peak: 2,
      players: 2,
      chats: 1,
    });

    // A game still going when the room closes is logged too.
    clock.now += GAME_SWITCH_COOLDOWN_MS;
    a.room.handle('session-aaaa', { t: 'pick', game: 'jigsaw' });
    clock.now += 10_000;
    a.room.close('empty');
    const last = log.events.filter((e) => e.type === 'game_session').at(-1)!;
    expect(last).toMatchObject({ game: 'jigsaw', endedBy: 'room_closed', activeMs: 10_000, groupMs: 0, peak: 1, players: 1 });
  });

  it('voice carries on across game switches', () => {
    const { mgr, clock } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    const b = joinPrivate(mgr, 'session-bbbb', a.room.code);
    a.room.handle('session-aaaa', { t: 'voice', join: true });
    b.room.handle('session-bbbb', { t: 'voice', join: true });
    const before = a.room.voicePeers();
    a.room.handle('session-aaaa', { t: 'pick', game: 'hearts' });
    clock.now += GAME_SWITCH_COOLDOWN_MS;
    a.room.handle('session-aaaa', { t: 'lobby' });
    clock.now += GAME_SWITCH_COOLDOWN_MS;
    a.room.handle('session-aaaa', { t: 'pick', game: 'tanks' });
    expect(a.room.voicePeers()).toEqual(before);
    // Nobody was told voice changed.
    expect(a.conn.of('voice').at(-1)!.peers).toHaveLength(2);
  });

  it('a person who joins mid-game takes a seat', () => {
    const { mgr } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'pick', game: 'hearts' });
    const b = joinPrivate(mgr, 'session-bbbb', a.room.code);
    expect(b.conn.of('welcome')[0].game).toBe('hearts');
    const view = b.conn.lastView();
    expect(view.seat).not.toBeNull();
    expect(view.seats[view.seat!].name).toBe('bbbb');
    expect(view.cards.length).toBeGreaterThan(0);
    // The newcomer's first game message comes after its welcome.
    const firstG = b.conn.sent.findIndex((m) => m.t === 'g');
    expect(firstG).toBeGreaterThan(b.conn.sent.findIndex((m) => m.t === 'welcome'));
  });
});

describe('hearts in a room', () => {
  function heartsRoom() {
    const env = setup();
    const a = joinPrivate(env.mgr, 'session-aaaa');
    const b = joinPrivate(env.mgr, 'session-bbbb', a.room.code);
    a.room.handle('session-aaaa', { t: 'pick', game: 'hearts' });
    const game = a.room.game as HeartsGame;
    return { ...env, a, b, game };
  }

  it('bots wait for every person to pass, so a friend who joins mid-pass still chooses', () => {
    const env = setup();
    const host = joinPrivate(env.mgr, 'session-host');
    host.room.handle('session-host', { t: 'pick', game: 'hearts' });
    const game = host.room.game as HeartsGame;
    expect(game.phase).toBe('passing');

    // Long after a bot would normally pass, no bot has: the host hasn't passed yet.
    run(env.mgr, env.clock, 10_000);
    expect(game.round.passes.every((p) => p === null)).toBe(true);

    // The host passes; a friend arrives before the bots' delay is up and takes a bot's seat.
    host.room.handle('session-host', { t: 'g', m: { t: 'pass', cards: game.round.hands[game.seatOf('session-host')!].slice(0, 3) } });
    joinPrivate(env.mgr, 'session-friend', host.room.code);
    const friendSeat = game.seatOf('session-friend')!;
    expect(friendSeat).not.toBeNull();
    expect(game.round.passes[friendSeat]).toBeNull();

    // The bots keep waiting for the friend...
    run(env.mgr, env.clock, 10_000);
    expect(game.phase).toBe('passing');
    expect(game.round.passes.filter(Boolean)).toHaveLength(1);

    // ...and pass a moment after the friend does.
    host.room.handle('session-friend', { t: 'g', m: { t: 'pass', cards: game.round.hands[friendSeat].slice(0, 3) } });
    run(env.mgr, env.clock, 5_000, () => game.phase === 'playing');
    expect(game.phase).toBe('playing');
  });

  it('each player only ever sees their own cards', () => {
    const { a, b, game } = heartsRoom();
    const sa = game.seatOf('session-aaaa')!;
    const sb = game.seatOf('session-bbbb')!;
    expect(a.conn.lastView().cards).toEqual(game.round.hands[sa]);
    for (const v of a.conn.views()) {
      // Nothing in any view sent to A contains B's hand.
      for (const c of game.round.hands[sb]) expect(v.cards).not.toContain(c);
    }
    const raw = JSON.stringify(a.conn.sent);
    const others = game.round.hands.filter((_, i) => i !== sa).flat();
    // Cards only appear in A's messages if they're A's (or played on the table, none yet).
    for (const c of others) expect(raw.includes(`"${c}"`)).toBe(false);
    expect(b.conn.lastView().seats.map((s) => s.cards)).toEqual([13, 13, 13, 13]);
  });

  it('rejects out-of-turn, illegal and invented plays', () => {
    const { a, b, game, mgr, clock } = heartsRoom();
    // B steps away; a bot covers their seat.
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    const sa = game.seatOf('session-aaaa')!;
    const hand = [...game.round.hands[sa]];
    // Passing cards you don't hold, or the same card three times.
    const notMine = ['2C', '3C', '4C', '5C', 'AS', 'KS', 'QS'].filter((c) => !hand.includes(c)).slice(0, 3);
    if (notMine.length === 3) a.room.handle('session-aaaa', { t: 'g', m: { t: 'pass', cards: notMine } });
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'pass', cards: [hand[0], hand[0], hand[0]] } });
    expect(game.round.passes[sa]).toBeNull();
    // Playing during the pass.
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'play', card: hand[0] } });
    expect(game.round.hands[sa]).toHaveLength(13);
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'pass', cards: botPass(hand) } });
    expect(game.round.passes[sa]).not.toBeNull();
    run(mgr, clock, 10_000, () => game.phase === 'playing');
    expect(game.phase).toBe('playing');
    // Wait until it's someone else's turn, then try to play anyway.
    run(mgr, clock, 10_000, () => game.round.turn >= 0 && game.round.turn !== sa);
    const before = game.round.hands[sa].length;
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'play', card: game.round.hands[sa][0] } });
    expect(game.round.hands[sa]).toHaveLength(before);
  });

  it('plays a whole game to 100 with bots covering a disconnected player', () => {
    const { a, b, game, mgr, clock } = heartsRoom();
    // B drops out: a bot plays their seat. A plays like a person would.
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    const sa = game.seatOf('session-aaaa')!;
    let guard = 0;
    while (game.phase !== 'gameOver' && guard++ < 20_000) {
      const v = a.conn.lastView();
      if (v.phase === 'passing' && !v.passing && v.seat !== null && !v.seats[v.seat].passed) {
        a.room.handle('session-aaaa', { t: 'g', m: { t: 'pass', cards: botPass(v.cards) } });
      } else if (v.phase === 'playing' && v.turn === sa && v.legal.length && v.trickWinner === null) {
        a.room.handle('session-aaaa', { t: 'g', m: { t: 'play', card: botPlay(game.round, sa) } });
      }
      clock.now += 100;
      mgr.stepAll();
    }
    expect(game.phase).toBe('gameOver');
    expect(Math.max(...game.seats.map((s) => s.score))).toBeGreaterThanOrEqual(100);
    expect(game.history.length).toBe(game.handNumber);
    const v = a.conn.lastView();
    expect(v.winners.length).toBeGreaterThan(0);
    expect(a.room.chatHistory.some((m) => m.text.endsWith('won Hearts!'))).toBe(true);
    // Anyone seated can deal again.
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'again' } });
    expect(game.phase === 'passing' || game.phase === 'playing').toBe(true);
    expect(game.seats.every((s) => s.score === 0)).toBe(true);
  });

  it('pauses on a finished trick and between hands', () => {
    const { game, mgr, clock, a, b } = heartsRoom();
    // Both people step away; bots cover every seat.
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    run(mgr, clock, 30_000, () => game.round.trickComplete);
    expect(game.round.trickComplete).toBe(true);
    const at = clock.now;
    run(mgr, clock, 5000, () => !game.round.trickComplete);
    expect(clock.now - at).toBeGreaterThanOrEqual(TRICK_PAUSE_MS - 50);
    run(mgr, clock, 600_000, () => game.phase === 'handEnd');
    expect(game.phase).toBe('handEnd');
    const end = clock.now;
    run(mgr, clock, 20_000, () => game.phase !== 'handEnd');
    expect(clock.now - end).toBeGreaterThanOrEqual(HAND_END_MS - 50);
  });

  it('reconnecting gives your seat back with your cards', () => {
    const { a, game, mgr } = heartsRoom();
    const sa = game.seatOf('session-aaaa')!;
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    const conn = new FakeConn();
    const r = a.room.join(conn, 'session-aaaa', 'aaaa', 'desktop');
    if (!r.ok) throw new Error();
    a.room.sendWelcome('session-aaaa', r);
    mgr.stepAll();
    expect(conn.of('welcome')[0].reclaimed).toBe(true);
    expect(conn.lastView().seat).toBe(sa);
    expect(conn.lastView().cards).toEqual(game.round.hands[sa]);
  });
});

describe('spades in a room', () => {
  const spadesViews = (c: FakeConn): SpadesView[] => c.sent.flatMap((m) => (m.t === 'g' && m.m.t === 'spades' ? [m.m.view] : []));

  function spadesRoom() {
    const env = setup();
    const a = joinPrivate(env.mgr, 'session-aaaa');
    const b = joinPrivate(env.mgr, 'session-bbbb', a.room.code);
    a.room.handle('session-aaaa', { t: 'pick', game: 'spades' });
    return { ...env, a, b, game: a.room.game as SpadesGame };
  }

  it('the first two people are opponents; bids go in turn and bots wait theirs', () => {
    const { a, game, mgr, clock } = spadesRoom();
    expect(game.seatOf('session-aaaa')).toBe(0);
    expect(game.seatOf('session-bbbb')).toBe(1);
    expect(game.phase).toBe('bidding');
    // Seat 0 bids first: nothing happens until they do.
    run(mgr, clock, 5000);
    expect(game.round.bids).toEqual([null, null, null, null]);
    // Out of turn and out of range bids are ignored.
    a.room.handle('session-bbbb', { t: 'g', m: { t: 'bid', bid: 3 } });
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'bid', bid: 14 } });
    expect(game.round.bids).toEqual([null, null, null, null]);
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'bid', bid: 3 } });
    expect(game.round.bids[0]).toBe(3);
    // Seat 1 is a person: the bot partner (seat 2) waits for them.
    run(mgr, clock, 5000);
    expect(game.round.bids[2]).toBeNull();
    a.room.handle('session-bbbb', { t: 'g', m: { t: 'bid', bid: 0 } });
    run(mgr, clock, 10_000, () => game.phase === 'playing');
    expect(game.phase).toBe('playing');
    expect(spadesViews(a.conn).at(-1)!.seats[1].bid).toBe(0);
  });

  it('each player only ever sees their own cards', () => {
    const { a, game } = spadesRoom();
    const raw = JSON.stringify(a.conn.sent);
    for (const c of game.round.hands.filter((_, i) => i !== 0).flat()) expect(raw.includes(`"${c}"`)).toBe(false);
    expect(spadesViews(a.conn).at(-1)!.cards).toEqual(game.round.hands[0]);
  });

  it('plays a whole game to 500 (or -200) with bots covering a disconnected player', () => {
    const { a, b, game, mgr, clock } = spadesRoom();
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    let guard = 0;
    while (game.phase !== 'gameOver' && guard++ < 60_000) {
      const v = spadesViews(a.conn).at(-1)!;
      if (v.phase === 'bidding' && v.turn === 0) a.room.handle('session-aaaa', { t: 'g', m: { t: 'bid', bid: spadesBotBid(game.round.hands[0], game.round.bids[2]) } });
      else if (v.phase === 'playing' && v.turn === 0 && v.legal.length && v.trickWinner === null) a.room.handle('session-aaaa', { t: 'g', m: { t: 'play', card: spadesBotPlay(game.round, 0) } });
      clock.now += 100;
      mgr.stepAll();
    }
    expect(game.phase).toBe('gameOver');
    expect(game.winners.length).toBeGreaterThan(0);
    expect(game.history.length).toBe(game.handNumber);
    expect(Math.max(...game.scores) >= 500 || Math.min(...game.scores) <= -200).toBe(true);
    expect(a.room.chatHistory.some((m) => m.text.endsWith('won Spades!'))).toBe(true);
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'again' } });
    expect(game.phase).toBe('bidding');
    expect(game.scores).toEqual([0, 0]);
  });
});

describe('dominoes in a room', () => {
  const domViews = (c: FakeConn): DominoesView[] => c.sent.flatMap((m) => (m.t === 'g' && m.m.t === 'dominoes' ? [m.m.view] : []));

  function dominoesRoom() {
    const env = setup();
    const a = joinPrivate(env.mgr, 'session-aaaa');
    const b = joinPrivate(env.mgr, 'session-bbbb', a.room.code);
    a.room.handle('session-aaaa', { t: 'pick', game: 'dominoes' });
    return { ...env, a, b, game: a.room.game as DominoesGame };
  }

  it('deals seven each (no boneyard), and nobody sees anyone else’s tiles', () => {
    const { a, game } = dominoesRoom();
    const v = domViews(a.conn).at(-1)!;
    expect(v.tiles).toHaveLength(7);
    expect(v.boneyard).toBe(0);
    expect(v.seats.map((s) => s.tiles)).toEqual([7, 7, 7, 7]);
    const raw = JSON.stringify(a.conn.sent);
    const hidden = [...game.round.hands.filter((_, i) => i !== game.seatOf('session-aaaa')).flat(), ...game.round.boneyard];
    for (const t of hidden) expect(raw.includes(`"${t}"`)).toBe(false);
  });

  it('bots wait while it’s a person’s turn, and people can only draw when nothing fits', () => {
    const { a, b, game, mgr, clock } = dominoesRoom();
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    const sa = game.seatOf('session-aaaa')!;
    run(mgr, clock, 30_000, () => game.round.turn === sa || game.phase !== 'playing');
    if (game.phase !== 'playing') return; // the bots finished the hand first; nothing to check
    const before = JSON.stringify(game.round.layout);
    run(mgr, clock, 10_000);
    expect(JSON.stringify(game.round.layout)).toBe(before);
    expect(game.round.turn).toBe(sa);
    const tiles = game.round.hands[sa].length;
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'draw' } });
    expect(game.round.hands[sa].length).toBe(game.round.moves(sa).length || !game.round.boneyard.length ? tiles : tiles + 1);
  });

  it('plays a whole game to the target with bots covering a disconnected player', () => {
    const { a, b, game, mgr, clock } = dominoesRoom();
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    const sa = game.seatOf('session-aaaa')!;
    let guard = 0;
    while (game.phase !== 'gameOver' && guard++ < 80_000) {
      const r = game.round;
      if (game.phase === 'handEnd') a.room.handle('session-aaaa', { t: 'g', m: { t: 'ready' } });
      else if (game.phase === 'playing' && r.turn === sa) {
        const m = dominoesBotMove(r, sa);
        if (m) a.room.handle('session-aaaa', { t: 'g', m: { t: 'place', tile: m.tile, arm: m.arm } });
        else if (r.mustDraw(sa)) a.room.handle('session-aaaa', { t: 'g', m: { t: 'draw' } });
      }
      clock.now += 100;
      mgr.stepAll();
    }
    expect(game.phase).toBe('gameOver');
    expect(Math.max(...game.seats.map((s) => s.score))).toBeGreaterThanOrEqual(DOMINOES_RULES.target);
    expect(game.winners.length).toBeGreaterThan(0);
    expect(a.room.chatHistory.some((m) => m.text.endsWith('won Dominoes!'))).toBe(true);
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'again' } });
    expect(game.phase).toBe('playing');
    expect(game.seats.every((s) => s.score === 0)).toBe(true);
  });

  /** Play out the current hand, making the people's moves for them the way a bot would. */
  function playOutHand(env: ReturnType<typeof dominoesRoom>) {
    const { a, game, mgr, clock } = env;
    let guard = 0;
    while (game.phase === 'playing' && guard++ < 20_000) {
      const r = game.round;
      for (const session of ['session-aaaa', 'session-bbbb']) {
        const seat = game.seatOf(session);
        if (seat === null || r.turn !== seat || r.phase !== 'playing' || !a.room.players.get(session)?.conn) continue;
        const m = dominoesBotMove(r, seat);
        if (m) a.room.handle(session, { t: 'g', m: { t: 'place', tile: m.tile, arm: m.arm } });
        else if (r.mustDraw(seat)) a.room.handle(session, { t: 'g', m: { t: 'draw' } });
      }
      clock.now += 100;
      mgr.stepAll();
    }
  }

  it('after a hand, waits for every player to say they’re ready', () => {
    const env = dominoesRoom();
    const { a, b, game, mgr, clock } = env;
    const sa = game.seatOf('session-aaaa')!;
    // Saying you're ready in the middle of a hand does nothing.
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'ready' } });
    expect(game.ready.size).toBe(0);
    playOutHand(env);
    expect(game.phase).toBe('handEnd');
    // Nobody is rushed: the board and scores stay up as long as it takes.
    run(mgr, clock, 120_000);
    expect(game.phase).toBe('handEnd');
    expect(game.handNumber).toBe(1);
    // One of the two being ready isn't enough, and everyone sees who is.
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'ready' } });
    run(mgr, clock, 5000);
    expect(game.phase).toBe('handEnd');
    expect(domViews(b.conn).at(-1)!.ready).toEqual([sa]);
    a.room.handle('session-bbbb', { t: 'g', m: { t: 'ready' } });
    expect(game.phase).toBe('playing');
    expect(game.handNumber).toBe(2);
    expect(domViews(a.conn).at(-1)!.ready).toEqual([]);
    expect(domViews(a.conn).at(-1)!.tiles).toHaveLength(7);
    // Ready doesn't carry over into the next break.
    expect([...game.ready]).toEqual([]);
  });

  it('doesn’t wait for someone who dropped out, and a table of bots moves on by itself', () => {
    const env = dominoesRoom();
    const { a, b, game, mgr, clock } = env;
    playOutHand(env);
    expect(game.phase).toBe('handEnd');
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'ready' } });
    run(mgr, clock, 5000);
    expect(game.phase).toBe('handEnd');
    // The one we're waiting on loses their connection: a bot plays for them, so go on.
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    mgr.stepAll();
    expect(game.phase).toBe('playing');
    expect(game.handNumber).toBe(2);

    // Now nobody's here at all: the next break is a short pause, as before.
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    run(mgr, clock, 600_000, () => game.phase !== 'playing');
    expect(game.phase).toBe('handEnd');
    const end = clock.now;
    run(mgr, clock, 20_000, () => game.phase !== 'handEnd');
    expect(game.phase).toBe('playing');
    expect(clock.now - end).toBeGreaterThanOrEqual(HAND_END_MS - 50);
  });
});

describe('chat filter', () => {
  const chats = (c: FakeConn) => c.of('chat').map((m) => m.msg);
  const rot13 = (x: string) => x.replace(/[a-z]/g, (ch) => String.fromCharCode(((ch.charCodeAt(0) - 97 + 13) % 26) + 97));

  function twoInARoom() {
    const env = setup();
    const a = joinPrivate(env.mgr, 'session-aaaa');
    const b = joinPrivate(env.mgr, 'session-bbbb', a.room.code);
    return { ...env, a, b, room: a.room };
  }

  it('private rooms start on Hide: swear words reach everyone as stars', () => {
    const { a, b, room } = twoInARoom();
    expect(room.chatFilter).toBe('hide');
    expect(a.conn.of('welcome')[0].chatFilter).toBe('hide');
    room.handle('session-aaaa', { t: 'chat', text: 'oh shit, nice shot' });
    const got = chats(b.conn).at(-1)!;
    expect(got.text).toBe('oh ****, nice shot');
    expect(got.hidden).toBeUndefined();
  });

  it('anyone can change the setting, and everyone is told', () => {
    const { a, b, room, clock } = twoInARoom();
    room.handle('session-bbbb', { t: 'filter', mode: 'none' });
    expect(room.chatFilter).toBe('none');
    expect(a.conn.of('filter').at(-1)!.mode).toBe('none');
    expect(room.chatHistory.at(-1)!.text).toMatch(/set the chat filter to None/);
    clock.now += 3000;
    room.handle('session-aaaa', { t: 'chat', text: 'oh shit' });
    expect(chats(b.conn).at(-1)!.text).toBe('oh shit');
  });

  it('Block keeps the message to the sender (marked, with a reminder) and nobody else', () => {
    const { a, b, room } = twoInARoom();
    room.handle('session-aaaa', { t: 'filter', mode: 'block' });
    const before = chats(b.conn).length;
    room.handle('session-aaaa', { t: 'chat', text: 'oh shit' });
    expect(chats(a.conn).filter((m) => m.hidden).at(-1)!.text).toBe('oh shit');
    expect(chats(a.conn).at(-1)!.text).toMatch(/family friendly/);
    expect(chats(b.conn).slice(before).some((m) => m.text.includes('shit'))).toBe(false);
    expect(room.chatHistory.some((m) => m.text.includes('shit'))).toBe(false);
  });

  it('slurs are blocked in every room, even with the filter off', () => {
    const { b, room } = twoInARoom();
    room.handle('session-aaaa', { t: 'filter', mode: 'none' });
    const slur = rot13('avttre');
    room.handle('session-aaaa', { t: 'chat', text: `you ${slur}` });
    expect(chats(b.conn).some((m) => m.text.includes(slur))).toBe(false);
  });

  it('public rooms always block, and the setting cannot be changed there', () => {
    const { mgr } = setup();
    const lookup = mgr.resolve({ kind: 'public' }, 'session-aaaa');
    if (!lookup.ok) throw new Error();
    const r = lookup.room.join(new FakeConn(), 'session-aaaa', 'a', 'desktop');
    if (!r.ok) throw new Error();
    expect(lookup.room.chatFilter).toBe('block');
    lookup.room.handle('session-aaaa', { t: 'filter', mode: 'none' });
    expect(lookup.room.chatFilter).toBe('block');
  });

  it('three caught messages in a minute pause chat for 30 seconds', () => {
    const { a, b, room, clock } = twoInARoom();
    room.handle('session-aaaa', { t: 'filter', mode: 'block' });
    for (const w of ['shit one', 'shit two', 'shit three']) {
      clock.now += 3000;
      room.handle('session-aaaa', { t: 'chat', text: w });
    }
    expect(a.conn.of('chatPaused').at(-1)!.ms).toBe(30_000);
    // Even a clean message waits out the pause...
    clock.now += 3000;
    const before = chats(b.conn).length;
    room.handle('session-aaaa', { t: 'chat', text: 'sorry' });
    expect(chats(b.conn).length).toBe(before);
    // ...then chat works again.
    clock.now += 30_000;
    room.handle('session-aaaa', { t: 'chat', text: 'sorry everyone' });
    expect(chats(b.conn).at(-1)!.text).toBe('sorry everyone');
  });

  it('caught messages spread over more than a minute do not pause anyone', () => {
    const { a, room, clock } = twoInARoom();
    room.handle('session-aaaa', { t: 'filter', mode: 'block' });
    for (const w of ['shit one', 'shit two', 'shit three']) {
      clock.now += 40_000;
      room.handle('session-aaaa', { t: 'chat', text: w });
    }
    expect(a.conn.of('chatPaused')).toHaveLength(0);
  });

  it('names are held to the strictest setting, even with the filter off', () => {
    const { room, clock } = twoInARoom();
    room.handle('session-aaaa', { t: 'filter', mode: 'none' });
    clock.now += 20_000;
    room.handle('session-aaaa', { t: 'name', name: 'Shithead' });
    expect(room.members().some((m) => m.name === 'Shithead')).toBe(false);
  });
});

describe('voice relay credentials', () => {
  it('are coturn shared-secret credentials that expire', () => {
    const turn = { urls: ['turn:turn.example.com:3478?transport=udp'], secret: 'shh', ttlSeconds: 3600 };
    const c = turnCredentials(turn, 'abcd1234', 1_700_000_000_000);
    expect(c.username).toBe(`${1_700_000_000 + 3600}:abcd1234`);
    expect(c.credential).toBe(createHmac('sha1', 'shh').update(c.username).digest('base64'));
    expect(c.urls).toEqual(turn.urls);
  });

  it('each player gets their own, alongside the STUN servers', () => {
    const { mgr } = setup({
      iceServers: [{ urls: 'stun:stun.example.com:3478' }],
      turn: { urls: ['turn:turn.example.com:3478'], secret: 'shh', ttlSeconds: 600 },
    });
    const a = joinPrivate(mgr, 'session-aaaa');
    const b = joinPrivate(mgr, 'session-bbbb', a.room.code);
    const va = a.conn.of('welcome')[0].voice.iceServers;
    const vb = b.conn.of('welcome')[0].voice.iceServers;
    expect(va[0]).toEqual({ urls: 'stun:stun.example.com:3478' });
    expect(va[1].username).toMatch(/^\d+:[0-9a-f]{8}$/);
    expect(va[1].username).not.toBe(vb[1].username);
    // The secret itself never goes to a client.
    expect(JSON.stringify(a.conn.sent)).not.toContain('shh');
  });
});

describe('tank resync', () => {
  it('sends a fresh snapshot on request, at most every couple of seconds', () => {
    const { mgr, clock } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'pick', game: 'tanks' });
    const inits = () => a.conn.sent.filter((m) => m.t === 'g' && m.m.t === 'init').length;
    const start = inits();
    for (let i = 0; i < 20; i++) a.room.handle('session-aaaa', { t: 'g', m: { t: 'resync' } });
    expect(inits()).toBe(start + 1);
    clock.now += 2500;
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'resync' } });
    expect(inits()).toBe(start + 2);
  });
it('says how each voice link connected, once per link, for the admin page', () => {
    const { mgr, log } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    const b = joinPrivate(mgr, 'session-bbbb', a.room.code);
    a.room.handle('session-aaaa', { t: 'voice', join: true });
    b.room.handle('session-bbbb', { t: 'voice', join: true });
    const to = a.room.voicePeers().find((p) => p.name === 'bbbb')!.id;
    const links = () => log.events.filter((e) => e.type === 'voice_link');
    a.room.handle('session-aaaa', { t: 'voice-route', to, route: 'relayed' });
    a.room.handle('session-aaaa', { t: 'voice-route', to, route: 'relayed' });
    // Someone who isn't there, or yourself: ignored.
    a.room.handle('session-aaaa', { t: 'voice-route', to: 'nobody', route: 'direct' });
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({ route: 'relayed' });
  });

  it('a table where nobody plays or talks closes after 10 minutes, with a warning first', () => {
    const { mgr, clock } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    const b = joinPrivate(mgr, 'session-bbbb', a.room.code);
    const code = a.room.code;
    // Just before the warning: nothing yet.
    clock.now += IDLE_ROOM_MS - IDLE_WARNING_MS - 1000;
    mgr.housekeeping();
    expect(a.conn.of('idle')).toHaveLength(0);
    // A minute to go: everyone is warned.
    clock.now += 2000;
    mgr.housekeeping();
    expect(a.conn.of('idle').at(-1)!.closesInMs).toBeGreaterThan(IDLE_WARNING_MS - 2000);
    expect(b.conn.of('idle')).toHaveLength(1);
    // Someone taps (or talks): the warning goes away and the clock starts again.
    b.room.handle('session-bbbb', { t: 'active' });
    expect(a.conn.of('idle').at(-1)!.closesInMs).toBeNull();
    clock.now += IDLE_ROOM_MS - IDLE_WARNING_MS - 1000;
    mgr.housekeeping();
    expect(mgr.rooms.has(code)).toBe(true);
    // Playing counts too; the heartbeat doesn't.
    a.room.handle('session-aaaa', { t: 'ping', at: 1 });
    clock.now += IDLE_WARNING_MS + 2000;
    mgr.housekeeping();
    expect(mgr.rooms.has(code)).toBe(false);
    const closed = a.conn.of('error').at(-1)!;
    expect(closed.code).toBe('room-closed');
    expect(closed.message).toBe('This table closed after 10 minutes with nobody playing or talking.');
    expect(a.conn.closed && b.conn.closed).toBe(true);
  });
});

