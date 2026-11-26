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
