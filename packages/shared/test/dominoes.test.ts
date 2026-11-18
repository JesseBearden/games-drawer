import { describe, expect, it } from 'vitest';
import {
  dealDominoes,
  DOMINOES_RULES,
  dominoesBotMove,
  DominoesRound,
  emptyLayout,
  endCount,
  fullSet,
  movesFor,
  openEnds,
  openingLead,
  place,
  pointsFor,
  Rng,
  roundToFive,
} from '../src/index';

/** Build a layout by playing tiles in order: [tile, line]. */
function layoutOf(...plays: [string, string][]) {
  const l = emptyLayout();
  for (const [tile, arm] of plays) expect(place(l, tile, arm, 0), `${tile} on ${arm}`).toBe(true);
  return l;
}

describe('dominoes basics', () => {
  it('a double-six set has 28 tiles; the family rule deals all of them, 7 each', () => {
    expect(fullSet()).toHaveLength(28);
    expect(DOMINOES_RULES).toMatchObject({ tilesEach: 7, target: 250 });
    const { hands, boneyard } = dealDominoes(() => 0);
    expect(hands.map((h) => h.length)).toEqual([7, 7, 7, 7]);
    expect(boneyard).toHaveLength(0);
    expect(new Set(hands.flat()).size).toBe(28);
    // Other deals still work (and leave a boneyard).
    const five = dealDominoes(() => 0, 4, 5);
    expect(five.hands.map((h) => h.length)).toEqual([5, 5, 5, 5]);
    expect(five.boneyard).toHaveLength(8);
  });

  it('with no boneyard, someone who can’t play passes straight away', () => {
    const r = new DominoesRound({ hands: [['6-6', '0-1'], ['2-3', '4-4'], ['5-6'], ['0-0']], boneyard: [] }, {});
    r.play(0, '6-6', 'e');
    expect(r.mustDraw(1)).toBe(false);
    expect(r.mustPass(1)).toBe(true);
    expect(r.pass(1)).toBe(true);
    expect(r.turn).toBe(2);
  });

  it('rounds leftover pips to the nearest 5', () => {
    expect([12, 13, 0, 7, 8, 25].map(roundToFive)).toEqual([10, 15, 0, 5, 10, 25]);
  });

  it('the first hand opens with the highest double', () => {
    expect(openingLead([['1-2', '3-3'], ['5-5', '0-6'], ['4-6'], ['2-2']])).toEqual({ seat: 1, tile: '5-5', rank: expect.any(Number) } as never);
    // Even a heavy tile like 5-6 comes after any double.
    expect(openingLead([['5-6', '6-4'], ['0-0'], ['3-5'], ['1-2']]).tile).toBe('0-0');
    // No doubles at all: the heaviest tile.
    expect(openingLead([['1-2'], ['4-6'], ['0-5'], ['2-3']]).tile).toBe('4-6');
  });
});

describe('counting the ends (All Fives scoring)', () => {
  it('a first tile counts both of its ends', () => {
    expect(endCount(layoutOf(['2-3', 'e']))).toBe(5);
    expect(pointsFor(endCount(layoutOf(['2-3', 'e'])))).toBe(5);
    expect(pointsFor(endCount(layoutOf(['1-3', 'e'])))).toBe(0);
  });

  it('a spinner counts double (once) until both of its sides are played on', () => {
    expect(endCount(layoutOf(['5-5', 'e']))).toBe(10);
    // One side played: the spinner still counts double on the other.
    expect(endCount(layoutOf(['5-5', 'e'], ['5-2', 'e']))).toBe(12);
    // Both sides played: only the tiles' ends count.
    expect(endCount(layoutOf(['5-5', 'e'], ['5-2', 'e'], ['5-3', 'w']))).toBe(5);
  });

  it('a double at the end of a line counts both halves', () => {
    expect(endCount(layoutOf(['1-3', 'e'], ['3-3', 'e']))).toBe(1 + 6);
  });

  it('the spinner’s other sides open only after both main sides are played, and then count', () => {
    let l = layoutOf(['4-4', 'e'], ['4-1', 'e']);
    expect(openEnds(l).map((e) => e.arm).sort()).toEqual(['e', 'w']);
    l = layoutOf(['4-4', 'e'], ['4-1', 'e'], ['4-2', 'w']);
    expect(openEnds(l).map((e) => e.arm).sort()).toEqual(['e', 'n', 's', 'w']);
    expect(place(l, '4-6', 'n', 0)).toBe(true);
    expect(endCount(l)).toBe(1 + 2 + 6);
  });

  it('a double played later becomes the spinner, with side lines once the line goes past it', () => {
    const l = layoutOf(['1-2', 'e'], ['2-2', 'e']);
    expect(l.spinner).toEqual({ arm: 'e', index: 0 });
    expect(openEnds(l).map((e) => e.arm).sort()).toEqual(['e', 'w']);
    expect(place(l, '2-5', 'e', 0)).toBe(true);
    expect(openEnds(l).map((e) => e.arm).sort()).toEqual(['e', 'e+', 'e-', 'w']);
    expect(place(l, '2-6', 'e+', 0)).toBe(true);
    expect(endCount(l)).toBe(1 + 5 + 6);
  });

  it('only matching tiles fit', () => {
    const l = layoutOf(['1-2', 'e']);
    expect(place(l, '3-4', 'e', 0)).toBe(false);
    expect(movesFor(l, ['3-4', '2-6', '1-1'])).toEqual([
      { tile: '2-6', arm: 'e' },
      { tile: '1-1', arm: 'w' },
    ]);
  });
});

describe('a hand of dominoes', () => {
  const deal = (hands: string[][], boneyard: string[] = []) => ({ hands, boneyard });

  it('the opener must play the highest double; then turns go round', () => {
    const r = new DominoesRound(deal([['1-2', '0-0'], ['6-6', '3-4'], ['2-5', '1-6'], ['5-5', '0-1']]), {});
    expect(r.turn).toBe(1);
    expect(r.moves(1)).toEqual([{ tile: '6-6', arm: 'e' }]);
    expect(r.play(1, '3-4', 'e')).toBeNull();
    expect(r.play(1, '6-6', 'e')).toBe(0); // 12 isn't a multiple of 5
    expect(r.turn).toBe(2);
    // Ends: the spinner's open west side (12) + 1 = 13: no points.
    expect(r.play(2, '1-6', 'e')).toBe(0);
  });

  it('scores the ends when they make a multiple of 5', () => {
    const r = new DominoesRound(deal([['5-5', '1-1'], ['5-0', '2-2'], ['3-3'], ['4-4']]), {});
    expect(r.play(0, '5-5', 'e')).toBe(10);
    expect(r.play(1, '5-0', 'e')).toBe(10); // 5-5 still open on the west (10) + 0
  });

  it('nothing fits: draw until something does; with an empty boneyard, pass; everyone passing blocks the hand', () => {
    const r = new DominoesRound(deal([['6-6', '0-1'], ['2-3', '4-4'], ['1-2'], ['0-0']], ['5-6', '1-3']), {});
    r.play(0, '6-6', 'e');
    expect(r.moves(1)).toEqual([]);
    expect(r.mustDraw(1)).toBe(true);
    expect(r.pass(1)).toBe(false);
    expect(r.draw(1)).toBe('1-3');
    expect(r.draw(1)).toBe('5-6');
    expect(r.moves(1)).toEqual([{ tile: '5-6', arm: 'e' }]);
    expect(r.draw(1)).toBeNull(); // can play now, so no more drawing
  });

  it('going out scores everyone else’s pips, rounded to the nearest 5', () => {
    const r = new DominoesRound(deal([['3-3'], ['3-5', '6-6'], ['1-2'], ['0-4']]), { leader: 0 });
    r.play(0, '3-3', 'e');
    expect(r.phase).toBe('done');
    // 8 + 12 + 3 + 4 = 27 -> 25
    expect(r.result).toEqual({ winner: 0, blocked: false, points: 25, pips: [0, 20, 3, 4] });
  });

  it('a blocked hand goes to the lowest hand', () => {
    const r = new DominoesRound(deal([['6-6', '0-0'], ['1-1'], ['2-2'], ['3-4']]), {});
    r.play(0, '6-6', 'e');
    for (const s of [1, 2, 3, 0]) expect(r.pass(s)).toBe(true);
    expect(r.result).toMatchObject({ blocked: true, winner: 0, pips: [0, 2, 4, 7] });
    expect(r.result!.points).toBe(roundToFive(2 + 4 + 7));
  });

  it('bots only make legal moves, and hands always finish, over hundreds of deals', () => {
    const rng = new Rng(3);
    for (let h = 0; h < 400; h++) {
      const r = new DominoesRound(
        dealDominoes((n) => rng.int(0, n - 1)),
        { leader: h % 7 === 0 ? undefined : h % 4 },
      );
      let guard = 0;
      while (r.phase === 'playing' && guard++ < 300) {
        const s = r.turn;
        const m = dominoesBotMove(r, s);
        if (m) expect(r.play(s, m.tile, m.arm)).not.toBeNull();
        else if (r.mustDraw(s)) expect(r.draw(s)).not.toBeNull();
        else expect(r.pass(s)).toBe(true);
      }
      expect(r.phase).toBe('done');
    }
  });
});
