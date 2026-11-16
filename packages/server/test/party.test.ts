import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { botPass, botPlay, Rng, type HeartsView, type ServerMessage } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { HAND_END_MS, HeartsGame, TRICK_PAUSE_MS } from '../src/games/hearts';
import { RoomManager } from '../src/manager';
import { GAME_SWITCH_COOLDOWN_MS, turnCredentials, type Conn, type RoomDeps } from '../src/room';

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
});
