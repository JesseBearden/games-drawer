import { describe, expect, it } from 'vitest';
import { dealDominoes, dominoesBotMove, DominoesRound, Rng } from '@tank/shared';
import { layoutSpots, limitsFor, type TileSpot } from '../src/dominoLayout';

/** The screen shapes the board gets: phone upright and sideways, desktop, tablet, very wide. */
const SHAPES = [
  [393, 450],
  [700, 220],
  [845, 700],
  [600, 600],
  [1400, 300],
].map(([w, h]) => limitsFor(w, h));

function overlap(a: TileSpot, b: TileSpot) {
  const size = (s: TileSpot) => (s.horizontal ? [2, 1] : [1, 2]);
  const [aw, ah] = size(a);
  const [bw, bh] = size(b);
  const eps = 0.01;
  return Math.abs(a.x - b.x) < (aw + bw) / 2 - eps && Math.abs(a.y - b.y) < (ah + bh) / 2 - eps;
}

describe('domino table layout', () => {
  it('never draws two tiles on top of each other, over hundreds of real games and screen shapes', () => {
    const rng = new Rng(17);
    const problems: string[] = [];
    for (let hand = 0; hand < 600 && problems.length < 5; hand++) {
      const r = new DominoesRound(
        dealDominoes((n) => rng.int(0, n - 1), 4, hand % 3 === 0 ? 5 : 7),
        { leader: hand % 5 === 0 ? undefined : hand % 4 },
      );
      let guard = 0;
      while (r.phase === 'playing' && guard++ < 300 && problems.length < 5) {
        const s = r.turn;
        const m = dominoesBotMove(r, s, () => rng.next() * 3);
        if (m) r.play(s, m.tile, m.arm);
        else if (r.mustDraw(s)) r.draw(s);
        else r.pass(s);
        for (const limits of SHAPES) {
          const spots = layoutSpots(r.layout, limits);
          for (let i = 0; i < spots.length; i++)
            for (let j = i + 1; j < spots.length; j++)
              if (overlap(spots[i], spots[j])) problems.push(`hand ${hand}, limits ${JSON.stringify(limits)}: ${spots[i].tile} overlaps ${spots[j].tile} (${JSON.stringify(r.layout.arms.map((a) => [a.id, a.tiles.map((t) => t.tile)]))})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('bends east and west both downward, north east, and keeps south straight: never a pinwheel', () => {
    const line = (id: string, pips: number[]) => ({
      id,
      from: 'root' as const,
      tiles: pips.slice(1).map((p, i) => ({ tile: `${Math.min(pips[i], p)}-${Math.max(pips[i], p)}`, inner: pips[i], outer: p, seat: 0 })),
    });
    const spots = layoutSpots(
      {
        root: { tile: '6-6', inner: 6, outer: 6, seat: 0 },
        spinner: 'root',
        // Each tile appears once, as in a real game (no doubles: those never turn a corner).
        arms: [line('e', [6, 1, 2, 3, 4, 5]), line('w', [6, 0, 1, 3, 5, 2]), line('n', [6, 2, 4, 0, 3, 6]), line('s', [6, 5, 1, 4])],
      },
      { across: 4, upDown: 4 },
    );
    const end = (tile: string) => spots.find((s) => s.tile === tile)!;
    // East and west both end up below the centre line, on their own sides...
    expect(end('4-5').y).toBeGreaterThan(1);
    expect(end('4-5').x).toBeGreaterThan(1);
    expect(end('2-5').y).toBeGreaterThan(1);
    expect(end('2-5').x).toBeLessThan(-1);
    // ...north bends east into the open space above (no tall column), and south runs straight
    // down between the two bent sides: the four lines never all turn one way round.
    expect(end('3-6').x).toBeGreaterThan(1);
    expect(end('3-6').y).toBeLessThan(-1);
    expect(end('1-4').x).toBeCloseTo(0);
  });

  it('turns a corner as an L: the turning tile just past the end of the line, touching it', () => {
    const spots = layoutSpots(
      {
        root: { tile: '6-6', inner: 6, outer: 6, seat: 0 },
        spinner: 'root',
        arms: [
          {
            id: 'e',
            from: 'root',
            tiles: [
              { tile: '4-6', inner: 6, outer: 4, seat: 0 },
              { tile: '1-4', inner: 4, outer: 1, seat: 1 },
              { tile: '1-3', inner: 1, outer: 3, seat: 2 },
            ],
          },
          { id: 'w', from: 'root', tiles: [] },
          { id: 'n', from: 'root', tiles: [] },
          { id: 's', from: 'root', tiles: [] },
        ],
      },
      { across: 4, upDown: 8 },
    );
    const last = spots.find((s) => s.tile === '1-4')!;
    const turned = spots.find((s) => s.tile === '1-3')!;
    // Heading down, its top half (the 1) just past the line's end, level with the line.
    expect(turned.horizontal).toBe(false);
    expect(turned.first).toBe(1);
    expect(turned.x - 0.5).toBeCloseTo(last.x + 1);
    expect(turned.y - 1).toBeCloseTo(last.y - 0.5);
  });

  it('never turns at a double, or right after one: the line carries on straight', () => {
    // The case from the screenshot: a line runs into its edge on a crosswise double.
    const spots = layoutSpots(
      {
        root: { tile: '6-6', inner: 6, outer: 6, seat: 0 },
        spinner: 'root',
        arms: [
          {
            id: 'e',
            from: 'root',
            tiles: [
              { tile: '4-6', inner: 6, outer: 4, seat: 0 },
              { tile: '2-4', inner: 4, outer: 2, seat: 1 },
              { tile: '2-2', inner: 2, outer: 2, seat: 2 },
              { tile: '2-3', inner: 2, outer: 3, seat: 3 },
            ],
          },
          { id: 'w', from: 'root', tiles: [] },
          { id: 'n', from: 'root', tiles: [] },
          { id: 's', from: 'root', tiles: [] },
        ],
      },
      { across: 5, upDown: 8 },
    );
    const dbl = spots.find((s) => s.tile === '2-2')!;
    const next = spots.find((s) => s.tile === '2-3')!;
    // The double stays crosswise in the line, and the tile after it carries on east, level.
    expect(dbl.horizontal).toBe(false);
    expect(dbl.y).toBeCloseTo(0);
    expect(next.horizontal).toBe(true);
    expect(next.y).toBeCloseTo(0);
    expect(next.x - 1).toBeCloseTo(dbl.x + 0.5);
  });
});
