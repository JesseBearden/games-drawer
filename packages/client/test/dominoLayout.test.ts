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

  it('bends east and west both downward (mirror images) and keeps north and south straight: never a pinwheel', () => {
    const line = (id: string, pips: number[]) => ({
      id,
      from: 'root' as const,
      tiles: pips.slice(1).map((p, i) => ({ tile: `${Math.min(pips[i], p)}-${Math.max(pips[i], p)}`, inner: pips[i], outer: p, seat: 0 })),
    });
    const spots = layoutSpots(
      {
        root: { tile: '6-6', inner: 6, outer: 6, seat: 0 },
        spinner: 'root',
        // Each tile appears once, as in a real game.
        arms: [line('e', [6, 1, 1, 2, 2, 3]), line('w', [6, 0, 0, 3, 3, 4]), line('n', [6, 4, 4, 5, 5, 1]), line('s', [6, 5, 0, 2, 4, 0])],
      },
      { across: 4, upDown: 4 },
    );
    const end = (tile: string) => spots.find((s) => s.tile === tile)!;
    // East and west both end up below the centre line, on their own sides...
    expect(end('2-3').y).toBeGreaterThan(1);
    expect(end('2-3').x).toBeGreaterThan(1);
    expect(end('3-4').y).toBeGreaterThan(1);
    expect(end('3-4').x).toBeLessThan(-1);
    // ...while north and south stay in the centre column.
    expect(end('1-5').x).toBeCloseTo(0);
    expect(end('0-4').x).toBeCloseTo(0);
  });

  it('turns a corner cleanly right after a double', () => {
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
    const turned = spots.find((s) => s.tile === '2-3')!;
    expect(turned.horizontal).toBe(false);
    expect(overlap(dbl, turned)).toBe(false);
    // Tucked right under the double, touching it.
    expect(turned.x).toBeCloseTo(dbl.x);
    expect(turned.y - 1 - (dbl.y + 1)).toBeCloseTo(0);
  });
});
