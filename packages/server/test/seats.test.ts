/** Who gets a seat when a game starts, and what a game's last tile scores. */
import { describe, expect, it } from 'vitest';
import { DOMINOES_RULES, Rng, type GameId } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { DominoesGame } from '../src/games/dominoes';
import { ThreeThirteenGame } from '../src/games/threeThirteen';
import { BOT_TAKEOVER_MS } from '../src/games/types';
import { RoomManager } from '../src/manager';
import type { Conn } from '../src/room';

const conn = (): Conn => ({ send() {}, close() {} });

function table() {
  const clock = { now: 1_000_000 };
  const rng = new Rng(3);
  const mgr = new RoomManager({
    now: () => clock.now,
    log: new MemoryLog(),
    moderator: new ChatModerator(),
    emptyRoomMs: 3_600_000,
    idleRoomMs: 3_600_000,
    maxPrivateRooms: 10,
    chatHistorySize: 10,
    randomInt: (n) => rng.int(0, n - 1),
  });
  const made = mgr.resolve({ kind: 'create-private' }, 'jesse');
  if (!made.ok) throw new Error(made.code);
  const { room } = made;
  const conns = new Map<string, Conn>();
  const join = (who: string) => {
    const c = conn();
    const r = room.join(c, who, who, 'phone');
    if (!r.ok) throw new Error(r.code);
    room.sendWelcome(who, r);
    conns.set(who, c);
  };
  const drop = (who: string) => room.disconnect(who, conns.get(who)!, 'disconnect');
  const start = (game: GameId, before = () => {}) => {
    room.handle('jesse', { t: 'pick', game });
    before();
    for (const p of [...room.players.values()]) if (p.conn) room.handle(p.session, { t: 'ready', ready: true });
  };
  return { clock, room, join, drop, start };
}

describe('Dominoes for two or three (user, 2026-11-25)', () => {
  it('two picked: two seats across from each other, 7 tiles each, 14 in the boneyard', () => {
    const t = table();
    t.join('jesse');
    t.start('dominoes', () => t.room.handle('jesse', { t: 'players', n: 2 }));
    const game = t.room.game as DominoesGame;
    expect(game.active).toEqual([0, 2]);
    expect(game.round.hands.map((h) => h.length)).toEqual([7, 0, 7, 0]);
    expect(game.round.boneyard).toHaveLength(14);
    const view = game.viewFor('jesse');
    expect(view.seats.map((s) => s.playing)).toEqual([true, false, true, false]);
    expect(view.boneyard).toBe(14);
  });

  it('three picked by three people: everyone plays, 7 left to draw; never fewer than are here', () => {
    const t = table();
    for (const who of ['jesse', 'mom', 'sam']) t.join(who);
    t.start('dominoes', () => t.room.handle('jesse', { t: 'players', n: 2 }));
    const game = t.room.game as DominoesGame;
    expect(game.active).toHaveLength(3);
    expect(game.round.boneyard).toHaveLength(7);
    expect(game.active.map((i) => game.seats[i].session).sort()).toEqual(['jesse', 'mom', 'sam']);
  });

  it('four is all 28 dealt, as before', () => {
    const t = table();
    t.join('jesse');
    t.start('dominoes');
    const game = t.room.game as DominoesGame;
    expect(game.active).toEqual([0, 1, 2, 3]);
    expect(game.round.boneyard).toHaveLength(0);
  });
});

describe('someone who left long ago', () => {
  it('isn’t dealt in: 2 players at Three Thirteen is the two people here', () => {
    const t = table();
    for (const who of ['jesse', 'mom', 'sam']) t.join(who);
    t.drop('sam');
    t.clock.now += 5 * 60_000;
    t.start('threethirteen', () => t.room.handle('jesse', { t: 'players', n: 2 }));
    const game = t.room.game as ThreeThirteenGame;
    expect(game.active).toHaveLength(2);
    expect(game.seatOf('sam')).toBeNull();
    expect(game.active.map((i) => game.seats[i].session).sort()).toEqual(['jesse', 'mom']);
  });

  it('someone who only just dropped still is', () => {
    const t = table();
    for (const who of ['jesse', 'mom', 'sam']) t.join(who);
    t.clock.now += 5000;
    t.drop('sam');
    t.clock.now += BOT_TAKEOVER_MS - 1000;
    t.start('threethirteen', () => t.room.handle('jesse', { t: 'players', n: 2 }));
    expect((t.room.game as ThreeThirteenGame).seatOf('sam')).not.toBeNull();
  });

  it('keeps a seat they picked, and takes a free one on coming back if they didn’t', () => {
    for (const game of ['hearts', 'spades', 'dominoes', 'threethirteen', 'tanks'] as const) {
      const t = table();
      for (const who of ['jesse', 'mom', 'sam']) t.join(who);
      t.start(game, () => {
        t.room.handle('mom', { t: 'sit', seat: 2 });
        t.drop('mom');
        t.drop('sam');
        t.clock.now += 5 * 60_000;
      });
      const g = t.room.game!;
      const seat = (who: string) => (game === 'tanks' ? t.room.tanks!.tankIdOf(who) : g.seatOf!(who));
      if (game !== 'tanks') expect(seat('mom'), game).toBe(2);
      expect(seat('sam'), game).toBeNull();
      t.join('sam');
      expect(seat('sam'), game).not.toBeNull();
    }
  });
});

describe('the tile that wins Dominoes', () => {
  function won(result: { winner: number | null; blocked: boolean; points: number }) {
    const t = table();
    t.join('jesse');
    t.start('dominoes');
    const game = t.room.game as DominoesGame;
    game.seats[0].score = DOMINOES_RULES.target - 5;
    game.round.play = () => {
      Object.assign(game.round, { phase: 'done', result: { ...result, pips: [0, 4, 5, 6] } });
      return 10;
    };
    (game as unknown as { playMove(seat: number, tile: string, arm: string): boolean }).playMove(0, '5-5', 'e');
    return game;
  }

  it('going out with it adds the going-out points the sheet shows', () => {
    const game = won({ winner: 0, blocked: false, points: 15 });
    expect(game.phase).toBe('gameOver');
    expect(game.seats[0].score).toBe(DOMINOES_RULES.target + 5 + 15);
    expect(game.history.at(-1)![0]).toBe(game.seats[0].score);
  });

  it('blocking with it doesn’t claim points for someone who didn’t get them', () => {
    const game = won({ winner: 2, blocked: true, points: 15 });
    expect(game.winners).toEqual([0]);
    expect(game.seats[2].score).toBe(0);
    expect(game.round.result).toBeNull();
  });
});

describe('coming back in a new tab while someone watches (review 2026-11-25)', () => {
  for (const game of ['dominoes', 'threethirteen'] as const) {
    it(`${game}: the seat, and its hand, stay yours; the watcher keeps watching`, () => {
      const t = table();
      const device = 'd'.repeat(32);
      const joinOn = (session: string, name: string, deviceId?: string) => {
        const r = t.room.join(conn(), session, name, 'phone', deviceId);
        if (!r.ok) throw new Error(r.code);
        t.room.sendWelcome(session, r);
      };
      joinOn('jesse', 'Jesse');
      joinOn('mom', 'Mom', device);
      t.start(game, () => t.room.handle('jesse', { t: 'players', n: 2 }));
      const g = t.room.game as DominoesGame | ThreeThirteenGame;
      const seat = g.seatOf('mom')!;
      expect(seat).not.toBeNull();
      const hand = JSON.stringify(g.round.hands[seat]);
      t.clock.now += 5_000;
      joinOn('sam', 'Sam');
      expect(g.seatOf('sam')).toBeNull();
      // Mom's phone drops the page and she opens the link again: a new tab, the same device.
      t.room.disconnect('mom', null, 'closed');
      t.clock.now += 3_000;
      joinOn('mom-2', 'Mom', device);
      expect(g.seatOf('mom-2')).toBe(seat);
      expect(JSON.stringify(g.round.hands[seat])).toBe(hand);
      expect(g.seatOf('sam')).toBeNull();
    });
  }
});

describe('two players sit across, whichever seat was picked (review 2026-11-25)', () => {
  for (const [picked, across] of [
    [1, [1, 3]],
    [3, [1, 3]],
    [2, [0, 2]],
  ] as const) {
    it(`picking seat ${picked} puts the other player across: seats ${across.join(' and ')}`, () => {
      const t = table();
      t.join('jesse');
      t.start('dominoes', () => {
        t.room.handle('jesse', { t: 'players', n: 2 });
        t.room.handle('jesse', { t: 'sit', seat: picked });
      });
      expect((t.room.game as DominoesGame).active).toEqual(across);
    });
  }
});

describe('Tanks with more people than tanks (user, 2026-11-26: they watch)', () => {
  it('people without a tank watch the battlefield, and get the next tank that frees up', () => {
    const t = table();
    const sent = new Map<string, { t: string; m?: { t: string; tankId?: number } }[]>();
    const joinAs = (who: string) => {
      const box: { t: string; m?: { t: string; tankId?: number } }[] = [];
      sent.set(who, box);
      const c: Conn = { send: (d) => void box.push(JSON.parse(d)), close() {} };
      const r = t.room.join(c, who, who, 'phone');
      if (!r.ok) throw new Error(r.code);
      t.room.sendWelcome(who, r);
      return c;
    };
    const lastInit = (who: string) => sent.get(who)!.filter((m) => m.t === 'g' && m.m?.t === 'init').at(-1)?.m?.tankId;
    const people = ['jesse', 'amy', 'bob', 'cat', 'dan', 'eve'];
    const conns = new Map(people.map((p) => [p, joinAs(p)]));
    t.clock.now += 1000;
    t.room.disconnect('amy', conns.get('amy')!, 'disconnect');
    t.room.disconnect('bob', conns.get('bob')!, 'disconnect');
    t.clock.now += 3000;
    t.room.handle('jesse', { t: 'pick', game: 'tanks' });
    for (const p of ['jesse', 'cat', 'dan', 'eve']) t.room.handle(p, { t: 'ready', ready: true });
    const tanks = t.room.tanks!;
    expect(t.room.game?.id).toBe('tanks');
    for (const p of ['jesse', 'cat', 'dan', 'eve']) expect(tanks.tankIdOf(p)).not.toBeNull();
    // Amy comes back to four full tanks: she watches (not a blank screen).
    conns.set('amy', joinAs('amy'));
    expect(tanks.tankIdOf('amy')).toBeNull();
    expect(lastInit('amy')).toBe(-1);
    // Eve leaves: Amy gets that tank at the next look round.
    t.room.handle('eve', { t: 'leave' });
    t.clock.now += 1000;
    t.room.housekeeping();
    expect(tanks.tankIdOf('amy')).not.toBeNull();
    expect(lastInit('amy')).toBe(tanks.tankIdOf('amy'));
    // Bob comes back and watches; Dan's phone is gone a while, so Bob gets his tank.
    conns.set('bob', joinAs('bob'));
    expect(lastInit('bob')).toBe(-1);
    t.room.disconnect('dan', conns.get('dan')!, 'disconnect');
    t.clock.now += 10_000;
    t.room.housekeeping();
    expect(tanks.tankIdOf('bob')).toBeNull();
    t.clock.now += BOT_TAKEOVER_MS;
    t.room.housekeeping();
    expect(tanks.tankIdOf('bob')).not.toBeNull();
    expect(tanks.tankIdOf('dan')).toBeNull();
  });
});

describe('a watcher takes a seat the computer is playing (user, 2026-11-26)', () => {
  it('two-player Dominoes: someone watching gets the seat of a player gone a while', () => {
    const t = table();
    t.join('jesse');
    t.join('mom');
    t.start('dominoes', () => t.room.handle('jesse', { t: 'players', n: 2 }));
    const g = t.room.game as DominoesGame;
    const momSeat = g.seatOf('mom')!;
    t.clock.now += 5000;
    t.join('sam');
    expect(g.seatOf('sam')).toBeNull();
    t.drop('mom');
    t.clock.now += 10_000;
    t.room.housekeeping();
    expect(g.seatOf('sam')).toBeNull();
    t.clock.now += BOT_TAKEOVER_MS;
    t.room.housekeeping();
    expect(g.seatOf('sam')).toBe(momSeat);
    expect(g.seatOf('mom')).toBeNull();
  });
});
