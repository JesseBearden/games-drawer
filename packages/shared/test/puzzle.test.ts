import { describe, expect, it } from 'vitest';
import { cutPuzzle, gridFor, isPuzzleId, parseGameInput, PIECE_COUNTS, puzzleProgress, PUZZLE_IMAGES, tabCurve } from '../src';

describe('jigsaw grids', () => {
  it('get close to each piece count with nearly square pieces, for every picture', () => {
    for (const img of PUZZLE_IMAGES) {
      for (const n of PIECE_COUNTS) {
        const { cols, rows } = gridFor(img.width, img.height, n);
        expect(Math.abs(cols * rows - n) / n, `${img.id} ${n}`).toBeLessThan(0.12);
        const aspect = img.width / cols / (img.height / rows);
        expect(aspect, `${img.id} ${n}`).toBeGreaterThan(0.75);
        expect(aspect, `${img.id} ${n}`).toBeLessThan(1.34);
      }
    }
  });

  it('cut the dog photo the way we expect', () => {
    expect(gridFor(1600, 1067, 100)).toEqual({ cols: 12, rows: 8 });
    expect(gridFor(1600, 1067, 50)).toEqual({ cols: 9, rows: 6 });
  });
});

describe('jigsaw piece shapes', () => {
  it('are the same for the same seed (everyone sees the same pieces) and differ between puzzles', () => {
    expect(cutPuzzle(10, 8, 42)).toEqual(cutPuzzle(10, 8, 42));
    expect(cutPuzzle(10, 8, 42)).not.toEqual(cutPuzzle(10, 8, 43));
  });

  it('vary from edge to edge: tabs in and out, different sizes and positions', () => {
    const cut = cutPuzzle(40, 25, 7);
    const tabs = [...cut.horizontal, ...cut.vertical];
    expect(cut.horizontal).toHaveLength(40 * 24);
    expect(cut.vertical).toHaveLength(39 * 25);
    // No two edges are exactly alike.
    expect(new Set(tabs.map((t) => JSON.stringify(t))).size).toBe(tabs.length);
    // Roughly half stick out each way.
    const out = tabs.filter((t) => t.flip === 1).length / tabs.length;
    expect(out).toBeGreaterThan(0.4);
    expect(out).toBeLessThan(0.6);
    // Sizes and positions spread across their ranges, not bunched up.
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(spread(tabs.map((t) => t.size))).toBeGreaterThan(0.025);
    expect(spread(tabs.map((t) => t.centre))).toBeGreaterThan(0.15);
    expect(spread(tabs.map((t) => t.a))).toBeGreaterThan(0.06);
  });

  it('make each edge one smooth line from corner to corner', () => {
    for (const t of cutPuzzle(6, 5, 3).horizontal) {
      const segs = tabCurve(t);
      expect(segs[0][0][0]).toBeGreaterThan(0); // first control point heads along the edge
      expect(segs.at(-1)!.at(-1)).toEqual([1, 0]);
      // Each curve ends where the next begins, and the curves stay within the tab's reach.
      for (const seg of segs) for (const [, y] of seg) expect(Math.abs(y)).toBeLessThan(0.4);
      for (let i = 1; i < segs.length; i++) expect(segs[i - 1].at(-1)![0]).toBeLessThan(1);
    }
  });
});

describe('jigsaw bits and pieces', () => {
  it('measures progress by how many pieces are in place: joined up, or set in the frame', () => {
    const loose = Array.from({ length: 4 }, (_, i) => ({ x: 0, y: 0, g: i }));
    expect(puzzleProgress(loose)).toBe(0);
    expect(puzzleProgress(loose.map((p) => ({ ...p, g: p.g < 2 ? 0 : p.g })))).toBe(0.5);
    // A single piece set in its spot counts too.
    expect(puzzleProgress(loose, [3])).toBe(0.25);
    expect(puzzleProgress(loose.map((p) => ({ ...p, g: 0 })))).toBe(1);
  });

  it('only accepts proper save ids', () => {
    expect(isPuzzleId('abcdefgh01234567')).toBe(true);
    expect(isPuzzleId('../../etc/passwd')).toBe(false);
    expect(isPuzzleId('ABCDEFGH01234567')).toBe(false);
    expect(isPuzzleId('abc')).toBe(false);
  });

  it('turns away bad puzzle messages', () => {
    expect(parseGameInput({ t: 'pz-new', image: 'dog', pieces: 100 })).toEqual({ t: 'pz-new', image: 'dog', pieces: 100 });
    expect(parseGameInput({ t: 'pz-new', image: 'dog', pieces: '100' })).toBeNull();
    expect(parseGameInput({ t: 'pz-resume', id: '../secrets' })).toBeNull();
    expect(parseGameInput({ t: 'pz-saves', ids: Array(41).fill('abcdefgh01234567') })).toBeNull();
    expect(parseGameInput({ t: 'pz-drag', x: Infinity, y: 0 })).toBeNull();
    expect(parseGameInput({ t: 'pz-grab', piece: -1 })).toBeNull();
  });
});
