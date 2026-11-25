import { describe, expect, it } from 'vitest';
import {
  MahjongHand,
  mjBotClaim,
  mjBotDiscard,
  mjBotTurn,
  mjIsComplete,
  mjScore,
  mjShanten,
  mjTileSet,
  MJ_KINDS,
  MJ_LIMIT,
  parseClientMessage,
  parseGameInput,
  Rng,
  type MjMeld,
  type MjRules,
  type MjScore,
  type MjTile,
  type MjWin,
} from '../src';

const rnd = (seed: number) => {
  const r = new Rng(seed);
  return (n: number) => Math.floor(r.next() * n);
};

const NO_POINTS: MjRules = { points: false, full: false };
const POINTS: MjRules = { points: true, full: false };

/** "d1 d2 d3" → tiles. */
const T = (s: string): MjTile[] => s.split(/\s+/).filter(Boolean);

/** A hand with every seat's tiles set by hand, seat `turn` about to throw one away. */
function setHand(hands: string[], opts: { rules?: MjRules; wall?: string; turn?: number; dealer?: number } = {}) {
  const h = new MahjongHand(opts.dealer ?? 0, 0, opts.rules ?? NO_POINTS, rnd(1));
  h.hands = hands.map(T);
  h.flowers = [[], [], [], []];
  h.wall = T(opts.wall ?? 'd1 d2 d3 d4 d5 d6 d7 d8 d9 b1 b2 b3');
  h.turn = opts.turn ?? 0;
  h.step = 'discard';
  h.justDrew = false;
  h.claimed = true;
  h.discardsMade = 5;
  return h;
}

/** What the rows of a score add up to. */
const rows = (s: MjScore) => s.items.reduce((n, i) => n + i.faan, 0);

const win = (w: Partial<MjWin> & { concealed: MjTile[] }): MjWin => ({
  melds: [],
  flowers: ['f3'],
  winTile: w.concealed[w.concealed.length - 1],
  selfDrawn: false,
  seatWind: 1,
  prevailing: 0,
  lastTile: false,
  kongReplacement: false,
  robbedKong: false,
  heavenly: false,
  earthly: false,
  ...w,
});

describe('the tiles', () => {
  it('144 tiles: four of each of the 34 kinds, and one of each flower and season', () => {
    const set = mjTileSet();
    expect(set).toHaveLength(144);
    expect(MJ_KINDS).toHaveLength(42);
    for (const k of MJ_KINDS) expect(set.filter((t) => t === k)).toHaveLength(k[0] === 'f' ? 1 : 4);
  });

  it('a deal gives the dealer 14 and the rest 13, flowers set aside and replaced', () => {
    for (let seed = 1; seed < 30; seed++) {
      const h = new MahjongHand(2, 0, NO_POINTS, rnd(seed));
      expect(h.hands.map((x) => x.length)).toEqual([13, 13, 14, 13]);
      for (const hand of h.hands) expect(hand.some((t) => t[0] === 'f')).toBe(false);
      const all = [...h.wall, ...h.hands.flat(), ...h.flowers.flat()];
      expect(all.sort()).toEqual(mjTileSet().sort());
      expect(h.front + h.back + h.wall.length).toBe(144);
      expect(h.turn).toBe(2);
    }
  });
});

describe('complete hands', () => {
  it('four sets and a pair', () => {
    expect(mjIsComplete(T('d1 d2 d3 d4 d5 d6 b7 b7 b7 c9 c9 c9 we we'), [])).toBe(true);
    expect(mjIsComplete(T('d1 d2 d3 d4 d5 d6 b7 b7 b7 c9 c9 c9 we ws'), [])).toBe(false);
  });

  it('counts the sets already laid down', () => {
    const melds: MjMeld[] = [{ kind: 'pung', tiles: T('dr dr dr'), from: 1, concealed: false }];
    expect(mjIsComplete(T('d1 d2 d3 d4 d5 d6 b7 b7 b7 we we'), melds)).toBe(true);
  });

  it('a run never wraps past 9 or crosses suits', () => {
    expect(mjIsComplete(T('d8 d9 b1 d4 d5 d6 b7 b7 b7 c9 c9 c9 we we'), [])).toBe(false);
  });

  it('thirteen orphans only counts when special hands are on', () => {
    const orphans = T('d1 d9 b1 b9 c1 c9 we ws ww wn dr dg dw dw');
    expect(mjIsComplete(orphans, [])).toBe(false);
    expect(mjIsComplete(orphans, [], true)).toBe(true);
  });
});

describe('points (faan)', () => {
  it('a plain hand off a discard: concealed, no special sets', () => {
    const s = mjScore(win({ concealed: T('d1 d2 d3 d4 d5 d6 b7 b8 b9 c2 c3 c4 c5 c5') }))!;
    expect(s.items.map((i) => i.name)).toEqual(['Concealed hand', 'All Chows']);
    expect(s.faan).toBe(2);
  });

  it('mixed and pure one suit', () => {
    const mixed = mjScore(win({ concealed: T('d1 d2 d3 d4 d5 d6 d7 d8 d9 dr dr dr we we') }))!;
    expect(mixed.items.map((i) => i.name)).toContain('Mixed one suit');
    const pure = mjScore(win({ concealed: T('d1 d2 d3 d4 d5 d6 d7 d8 d9 d2 d2 d2 d5 d5') }))!;
    expect(pure.items.map((i) => i.name)).toContain('Pure one suit');
    expect(pure.faan).toBeGreaterThanOrEqual(8);
  });

  it('dragons and winds: seat and table winds each count', () => {
    // Seat South (1), table East (0).
    const s = mjScore(win({ concealed: T('ws ws ws we we we dr dr dr b1 b2 b3 c5 c5'), selfDrawn: true, winTile: 'c5' }))!;
    const names = s.items.map((i) => i.name);
    expect(names).toContain('Your seat’s wind');
    expect(names).toContain('The table’s wind');
    expect(names).toContain('Dragon Pung');
    expect(names).toContain('Self-drawn');
  });

  it('reads the hand the way that scores most', () => {
    // Three of each of 1-2-3: three Chows or three Pungs; the Pungs score more.
    const melds: MjMeld[] = [{ kind: 'pung', tiles: T('c7 c7 c7'), from: 2, concealed: false }];
    const s = mjScore(win({ concealed: T('c1 c1 c1 c2 c2 c2 c3 c3 c3 c9 c9'), melds, selfDrawn: true, winTile: 'c9' }))!;
    expect(s.items.map((i) => i.name)).toContain('All Pungs');
  });

  it('limit hands are worth the limit', () => {
    const s = mjScore(win({ concealed: T('d1 d9 b1 b9 c1 c9 we ws ww wn dr dg dw dw') }))!;
    expect(s).toMatchObject({ limit: true, faan: MJ_LIMIT });
    expect(s.items[0].name).toBe('Thirteen orphans');
    const honours = mjScore(win({ concealed: T('we we we ws ws ws dr dr dr dg dg dg wn wn') }))!;
    expect(honours.limit).toBe(true);
  });

  it('flowers: your own flower and season score, none at all scores too', () => {
    const base = T('d1 d2 d3 d4 d5 d6 b7 b8 b9 c2 c3 c4 c5 c5');
    expect(mjScore(win({ concealed: base, flowers: [] }))!.items.map((i) => i.name)).toContain('No flowers');
    expect(mjScore(win({ concealed: base, flowers: ['f2', 'f6'] }))!.items.map((i) => i.name)).toEqual(expect.arrayContaining(['Your own flower', 'Your own season']));
  });

  it('every item explains itself', () => {
    const s = mjScore(win({ concealed: T('ws ws ws we we we dr dr dr b1 b2 b3 c5 c5'), selfDrawn: true, winTile: 'c5' }))!;
    for (const i of s.items) expect(i.why.length).toBeGreaterThan(5);
  });

  it('Small four winds is a limit hand: one row, the limit', () => {
    const s = mjScore(win({ concealed: T('we we we ws ws ws ww ww ww wn wn d1 d2 d3') }))!;
    expect(s).toMatchObject({ limit: true, faan: MJ_LIMIT });
    expect(s.items.map((i) => [i.name, i.faan])).toEqual([['Small four winds', MJ_LIMIT]]);
    expect(rows(s)).toBe(s.faan);
  });

  it('several limits at once still show as one row worth the limit', () => {
    const kong = (t: MjTile): MjMeld => ({ kind: 'kong', tiles: [t, t, t, t], from: null, concealed: true });
    const s = mjScore(win({ concealed: T('c9 c9'), melds: [kong('d1'), kong('d2'), kong('b5'), kong('dr')], selfDrawn: true, winTile: 'c9' }))!;
    expect(s.limit).toBe(true);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ name: 'All Kongs and Four concealed Pungs', faan: MJ_LIMIT });
    expect(s.items[0].why).toContain('Four Kongs');
    expect(s.items[0].why).toContain('none taken from a discard');
    const orphans = mjScore(win({ concealed: T('d1 d9 b1 b9 c1 c9 we ws ww wn dr dg dw dw'), selfDrawn: true, heavenly: true }))!;
    expect(orphans.items.map((i) => [i.name, i.faan])).toEqual([['Heavenly hand and Thirteen orphans', MJ_LIMIT]]);
  });

  it('an ordinary hand over the limit says so in a row, so the rows still add up', () => {
    // Self-drawn 1, No flowers 1, All Pungs 3, Pure one suit 7: 12, worth the limit of 10.
    const melds: MjMeld[] = [{ kind: 'pung', tiles: T('d7 d7 d7'), from: 2, concealed: false }];
    const s = mjScore(win({ concealed: T('d1 d1 d1 d3 d3 d3 d5 d5 d5 d9 d9'), melds, selfDrawn: true, winTile: 'd9', flowers: [] }))!;
    expect(s).toMatchObject({ faan: MJ_LIMIT, limit: false });
    expect(s.items.at(-1)).toMatchObject({ name: 'Over the limit', faan: -2 });
    expect(rows(s)).toBe(MJ_LIMIT);
  });

  it('the rows always add up to the total, on any winning hand', () => {
    const r = new Rng(2026);
    const pick = (n: number) => Math.floor(r.next() * n);
    let checked = 0;
    let capped = 0;
    let limits = 0;
    for (let k = 0; k < 4000; k++) {
      // Half the time one suit and the honours, so big hands come up too.
      const suit = pick(3) * 9;
      const pool = pick(2) ? MJ_KINDS.slice(0, 34) : [...MJ_KINDS.slice(suit, suit + 9), ...MJ_KINDS.slice(27, 34)];
      const used = new Map<MjTile, number>();
      const take = (t: MjTile, n: number) => (used.get(t) ?? 0) + n <= 4 && !!used.set(t, (used.get(t) ?? 0) + n);
      const concealed: MjTile[] = [];
      const melds: MjMeld[] = [];
      let ok = true;
      for (let s = 0; s < 4 && ok; s++) {
        const i = MJ_KINDS.indexOf(pool[pick(pool.length)]);
        const chow = i < 27 && i % 9 <= 6 && pick(2) === 0;
        const tiles = chow ? [0, 1, 2].map((d) => MJ_KINDS[i + d]) : new Array<MjTile>(pick(6) === 0 ? 4 : 3).fill(MJ_KINDS[i]);
        ok = chow ? tiles.every((t) => take(t, 1)) : take(tiles[0], tiles.length);
        if (tiles.length === 4) {
          const own = pick(2) === 0;
          melds.push({ kind: 'kong', tiles, from: own ? null : 1, concealed: own });
        } else if (pick(3) === 0) melds.push({ kind: chow ? 'chow' : 'pung', tiles, from: 1, concealed: false });
        else concealed.push(...tiles);
      }
      const pair = pool[pick(pool.length)];
      if (!ok || !take(pair, 2)) continue;
      concealed.push(pair, pair);
      const s = mjScore({
        concealed,
        melds,
        flowers: MJ_KINDS.slice(34).filter(() => pick(4) === 0),
        winTile: concealed[pick(concealed.length)],
        selfDrawn: pick(2) === 0,
        seatWind: pick(4),
        prevailing: pick(4),
        lastTile: pick(8) === 0,
        kongReplacement: false,
        robbedKong: false,
        heavenly: pick(200) === 0,
        earthly: false,
      })!;
      expect(s).not.toBeNull();
      expect(rows(s)).toBe(s.faan);
      expect(s.faan).toBeLessThanOrEqual(MJ_LIMIT);
      if (s.limit) expect(s.items).toEqual([expect.objectContaining({ faan: MJ_LIMIT })]);
      checked++;
      if (s.items.some((i) => i.name === 'Over the limit')) capped++;
      if (s.limit) limits++;
    }
    // Plenty of hands, including ones over the limit and limit hands.
    expect(checked).toBeGreaterThan(2000);
    expect(capped).toBeGreaterThan(10);
    expect(limits).toBeGreaterThan(10);
  });
});

describe('a hand of play', () => {
  it('a discard goes to whoever can use it, Pung before Chow', () => {
    // Seat 0 throws c5. Seat 1 (next) could Chow; seat 2 has a pair and Pungs.
    const h = setHand(['c5 we ws ww', 'c3 c4 d1 d1', 'c5 c5 b1 b2', 'dr dg dw wn']);
    expect(h.discard(0, 'c5')).toBe(true);
    expect(h.options(1).chows).toEqual(['c3']);
    expect(h.options(2).pung).toBe(true);
    expect(h.options(3).chows).toEqual([]);
    h.resolve([null, { t: 'chow', chow: 'c3' }, { t: 'pung' }, null]);
    expect(h.melds[2]).toEqual([{ kind: 'pung', tiles: T('c5 c5 c5'), from: 0, concealed: false }]);
    expect(h.turn).toBe(2);
    expect(h.step).toBe('discard');
    expect(h.discards[0]).toEqual([]);
    expect(h.log.at(-1)!.taken).toBe(true);
  });

  it('only the next player can Chow', () => {
    const h = setHand(['c5 we ws ww', 'd1 d1 d2 d2', 'c3 c4 b1 b2', 'dr dg dw wn']);
    h.discard(0, 'c5');
    expect(h.options(2).chows).toEqual([]);
  });

  it('nobody takes it: the next player draws', () => {
    const h = setHand(['c5 we ws ww', 'd1 d1 d2 d2', 'c3 c4 b1 b2', 'dr dg dw wn'], { wall: 'b9 b8' });
    h.discard(0, 'c5');
    h.resolve([null, { t: 'pass' }, null, null]);
    expect(h.turn).toBe(1);
    expect(h.drawn).toBe('b9');
    expect(h.hands[1]).toContain('b9');
  });

  it('Mahjong beats a Pung, and the nearest in turn wins a tie', () => {
    const h = setHand(['c5 we', 'c5 c5 b1 b2', 'd1 d2 d3 d4 d5 d6 b7 b7 b7 c9 c9 c9 c6', 'd1 d2 d3 d4 d5 d6 b7 b8 b9 c9 c9 c9 c5']);
    h.discard(0, 'c5');
    expect(h.options(2).win).toBe(false);
    expect(h.options(3).win).toBe(true);
    h.resolve([null, { t: 'pung' }, null, { t: 'win' }]);
    expect(h.result).toMatchObject({ winner: 3, from: 0, selfDrawn: false, tile: 'c5' });
    expect(h.step).toBe('done');
  });

  it('a Kong takes a replacement tile from the back of the wall', () => {
    const h = setHand(['c5 we', 'c5 c5 c5 b2', 'd1', 'd2'], { wall: 'b9 b8 b7' });
    h.discard(0, 'c5');
    expect(h.options(1).kong).toBe(true);
    h.resolve([null, { t: 'kong' }, null, null]);
    expect(h.melds[1][0].kind).toBe('kong');
    expect(h.drawn).toBe('b7');
    expect(h.turn).toBe(1);
  });

  it('an added Kong can be robbed by someone who wins on it', () => {
    const h = setHand(['c5 d9 we', 'd1 d2 d3 d4 d5 d6 b7 b8 b9 c9 c9 c3 c4', 'd7', 'd8'], { wall: 'b9 b8 b7' });
    h.melds[0] = [{ kind: 'pung', tiles: T('c5 c5 c5'), from: 2, concealed: false }];
    h.justDrew = true;
    expect(h.selfOptions(0)!.kongs).toEqual(['c5']);
    expect(h.declareKong(0, 'c5')).toBe(true);
    expect(h.step).toBe('rob');
    expect(h.options(1).win).toBe(true);
    h.resolve([null, { t: 'win' }, null, null]);
    expect(h.result).toMatchObject({ winner: 1, from: 0, tile: 'c5' });
    expect(h.melds[0][0]).toMatchObject({ kind: 'pung', tiles: T('c5 c5 c5') });
  });

  it('taking your winning tile as a Pung still lets you go Mahjong on it (paid by the discarder)', () => {
    // Seat 1: d1-3, d4-6, b7-9, a pair of c9 and a pair of c5. Seat 0 throws c5: Mahjong or Pung.
    for (const rules of [NO_POINTS, POINTS]) {
      const h = setHand(['c5 we', 'd1 d2 d3 d4 d5 d6 b7 b8 b9 c9 c9 c5 c5', 'd7', 'd8'], { rules });
      if (rules.points) h.flowers[1] = [];
      h.discard(0, 'c5');
      const o = h.options(1);
      expect(o.pung).toBe(true);
      if (!rules.points) expect(o.win).toBe(true);
      h.resolve([null, { t: 'pung' }, null, null]);
      expect(h.melds[1]).toHaveLength(1);
      // On their turn, Mahjong is still there.
      const self = h.selfOptions(1)!;
      if (!o.win) continue; // (with points it has to be worth 3 faan, which this plain hand may not be)
      expect(self.win).toBe(true);
      expect(h.declareWin(1)).toBe(true);
      expect(h.result).toMatchObject({ winner: 1, from: 0, tile: 'c5', selfDrawn: false });
      // The Pung went back into the hand: it was the winning tile.
      expect(h.melds[1]).toEqual([]);
      expect(h.hands[1]).toHaveLength(14);
    }
  });

  it('once you throw a tile away, that chance is gone', () => {
    const h = setHand(['c5 we', 'd1 d2 d3 d4 d5 d6 b7 b8 b9 c9 c9 c5 c5', 'd7', 'd8'], { wall: 'b1 b2 b3 b4' });
    h.discard(0, 'c5');
    h.resolve([null, { t: 'pung' }, null, null]);
    expect(h.discard(1, 'd1')).toBe(true);
    h.resolve([null, null, null, null]);
    expect(h.justClaimed).toBeNull();
  });

  it('with points, going out on a taken Pung scores as a win on that discard', () => {
    // A pure one-suit hand: worth plenty. Seat 1 takes the c5 as a Pung, then goes Mahjong.
    const h = setHand(['c5 we', 'c1 c2 c3 c4 c4 c4 c7 c8 c9 c9 c9 c5 c5', 'd7', 'd8'], { rules: POINTS });
    h.discard(0, 'c5');
    expect(h.options(1).win).toBe(true);
    h.resolve([null, { t: 'pung' }, null, null]);
    expect(h.declareWin(1)).toBe(true);
    const r = h.result!;
    expect(r.selfDrawn).toBe(false);
    expect(r.score!.items.map((i) => i.name)).toContain('Pure one suit');
    expect(r.pay[0]).toBeLessThan(0);
    expect(r.pay[0] + r.pay[1]).toBe(0);
  });

  it('the wall running out ends the hand with no winner', () => {
    const h = setHand(['c5 we', 'd1 d1', 'd2 d2', 'd3 d3'], { wall: '' });
    h.discard(0, 'c5');
    expect(h.options(1)).toEqual({ win: false, kong: false, pung: false, chows: [] });
    h.resolve([null, null, null, null]);
    expect(h.result).toMatchObject({ winner: null });
    expect(h.step).toBe('done');
  });

  it('with points, a hand under 3 faan can’t go Mahjong; without points it can', () => {
    // d1-3, d4-6 and c3-4-5 (with the discarded c5), a pair of c9 and a Chow taken earlier: complete,
    // but the only thing that scores is All Chows (1 faan): it was opened and has a flower.
    const melds: MjMeld[] = [{ kind: 'chow', tiles: T('b1 b2 b3'), from: 0, concealed: false }];
    const seat1 = 'd1 d2 d3 d4 d5 d6 c3 c4 c9 c9';
    const h = setHand(['c5 we', seat1, 'd7', 'd8'], { rules: POINTS });
    h.melds[1] = melds.map((m) => ({ ...m, tiles: [...m.tiles] }));
    h.flowers[1] = ['f4'];
    h.discard(0, 'c5');
    expect(h.options(1).win).toBe(false);
    const free = setHand(['c5 we', seat1, 'd7', 'd8'], { rules: NO_POINTS });
    free.melds[1] = melds;
    free.discard(0, 'c5');
    expect(free.options(1).win).toBe(true);
  });

  it('pays with points: the discarder pays, or all three pay half when self-drawn', () => {
    const h = setHand(['c5 we', 'd1 d2 d3 d4 d5 d6 d7 d8 d9 dr dr dr c5', 'd7', 'd8'], { rules: POINTS });
    h.discard(0, 'c5');
    h.resolve([null, { t: 'win' }, null, null]);
    const r = h.result!;
    expect(r.score!.faan).toBeGreaterThanOrEqual(3);
    expect(r.pay[0]).toBeLessThan(0);
    expect(r.pay[0] + r.pay[1]).toBe(0);
    expect(r.pay[2]).toBe(0);
  });
});

describe('the computer', () => {
  it('shanten: complete is -1, one away is 0', () => {
    expect(mjShanten(T('d1 d2 d3 d4 d5 d6 b7 b7 b7 c9 c9 c9 we we'), 0)).toBe(-1);
    expect(mjShanten(T('d1 d2 d3 d4 d5 d6 b7 b7 b7 c9 c9 c9 we'), 0)).toBe(0);
    expect(mjShanten(T('d1 d4 d7 b2 b5 b8 c3 c6 c9 we ws ww wn'), 0)).toBeGreaterThanOrEqual(5);
  });

  it('four computers finish hands without breaking the rules, with and without points', () => {
    for (const rules of [NO_POINTS, POINTS]) {
      let wins = 0;
      for (let seed = 1; seed <= 25; seed++) {
        const h = new MahjongHand(seed % 4, 0, rules, rnd(seed));
        let guard = 0;
        while (h.step !== 'done' && guard++ < 1000) {
          if (h.step === 'discard') {
            const seat = h.turn;
            const a = mjBotTurn(h, seat);
            const ok = a.t === 'win' ? h.declareWin(seat) : a.t === 'kong' ? h.declareKong(seat, a.tile) : h.discard(seat, a.tile);
            expect(ok).toBe(true);
          } else h.resolve([0, 1, 2, 3].map((s) => mjBotClaim(h, s)));
          // Tiles are never made or lost.
          const all = [...h.wall, ...h.hands.flat(), ...h.flowers.flat(), ...h.discards.flat(), ...h.melds.flat().flatMap((m) => m.tiles)];
          if ((h.step as string) !== 'done') expect(all).toHaveLength(144);
        }
        expect(h.step).toBe('done');
        if (h.result!.winner !== null) wins++;
        if (h.result!.score) expect(rows(h.result!.score)).toBe(h.result!.score.faan);
      }
      // They do win, most hands; with points too (they used to win 16 of these 25, now 24).
      expect(wins).toBeGreaterThan(rules.points ? 19 : 12);
    }
  });

  it('with points, a computer won’t open its hand for a set that leaves nothing to score', () => {
    // Seat 1 (South, a flower that isn't theirs) could Chow d1-d2-d3 and be ready, but on a
    // plain open hand of runs that wins only 1 or 2 faan: it stays concealed instead.
    const hands = ['d3 we', 'd1 d2 b4 b5 b6 c2 c3 c4 c7 c8 d8 d8 b9', 'd7', 'd8'];
    for (const rules of [NO_POINTS, POINTS]) {
      const h = setHand(hands, { rules });
      h.flowers[1] = ['f3'];
      h.discard(0, 'd3');
      expect(h.options(1).chows).toEqual(['d1']);
      expect(mjBotClaim(h, 1)).toEqual(rules.points ? { t: 'pass' } : { t: 'chow', chow: 'd1' });
    }
    // A dragon is still worth a Pung.
    const h = setHand(['dr we', 'd1 d2 b4 b5 b6 c2 c3 c4 c7 c8 dr dr b9', 'd7', 'd8'], { rules: POINTS });
    h.discard(0, 'dr');
    expect(mjBotClaim(h, 1)).toEqual({ t: 'pung' });
  });

  it('with points, a ready computer waits on a tile that scores enough to win', () => {
    // Throwing b7 waits on b6 or b9 (2 faan: not enough off a discard); throwing b8 waits on b7
    // or the red dragon, and the dragon makes 3. Without points the bigger wait wins.
    const hand = 'd8 d8 d8 b3 b4 b5 b7 b7 b8 c7 c8 c9 dr dr';
    for (const rules of [NO_POINTS, POINTS]) {
      const h = setHand(['c5 we', hand, 'd7', 'd8'], { rules, turn: 1 });
      h.flowers[1] = ['f2'];
      expect(mjBotDiscard(h, 1)).toBe(rules.points ? 'b8' : 'b7');
    }
  });
});

describe('messages', () => {
  it('reads Mahjong input, and only real tiles', () => {
    expect(parseGameInput({ t: 'mj-discard', tile: 'c5' })).toEqual({ t: 'mj-discard', tile: 'c5' });
    expect(parseGameInput({ t: 'mj-discard', tile: 'x5' })).toBeNull();
    expect(parseGameInput({ t: 'mj-claim', claim: 'chow', chow: 'b3' })).toEqual({ t: 'mj-claim', claim: 'chow', chow: 'b3' });
    expect(parseGameInput({ t: 'mj-claim', claim: 'chow' })).toBeNull();
    expect(parseGameInput({ t: 'mj-claim', claim: 'pung', extra: 1 })).toEqual({ t: 'mj-claim', claim: 'pung' });
    expect(parseGameInput({ t: 'mj-kong', tile: 'dr' })).toEqual({ t: 'mj-kong', tile: 'dr' });
    expect(parseGameInput({ t: 'mj-roll' })).toEqual({ t: 'mj-roll' });
    expect(parseClientMessage(JSON.stringify({ t: 'mj-rules', points: true, full: false }))).toEqual({ t: 'mj-rules', points: true, full: false, learning: false });
    expect(parseClientMessage(JSON.stringify({ t: 'mj-rules', points: 'yes', full: false }))).toBeNull();
  });
});
