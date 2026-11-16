import { describe, expect, it } from 'vitest';
import { generateTerrain, subtractRange, Terrain } from '../src/terrain';
import { cfg, terrainFrom } from './helpers';

const opts = { minSliverThickness: 4, detachedDirtFalls: true };

describe('subtractRange', () => {
  it('splits a span when the hole is inside it', () => {
    const c = [100, 400];
    subtractRange(c, 200, 250);
    expect(c).toEqual([100, 200, 250, 400]);
  });
  it('trims and removes spans', () => {
    const c = [100, 150, 200, 400];
    subtractRange(c, 120, 220);
    expect(c).toEqual([100, 120, 220, 400]);
    subtractRange(c, 90, 130);
    expect(c).toEqual([220, 400]);
  });
});

describe('terrain generation', () => {
  it('is deterministic for a seed', () => {
    const a = generateTerrain(cfg, 1234);
    const b = generateTerrain(cfg, 1234);
    expect(a.cols).toEqual(b.cols);
    const c = generateTerrain(cfg, 999);
    expect(c.cols).not.toEqual(a.cols);
  });
  it('has pronounced elevation changes', () => {
    const t = generateTerrain(cfg, 77);
    const tops = t.cols.map((c) => c[0]);
    expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(250);
  });
});

describe('carving and collapse', () => {
  it('never carves bedrock', () => {
    const t = terrainFrom(() => 900);
    t.carve(500, cfg.worldHeight - 5, 40, opts);
    for (let x = 460; x <= 540; x++) expect(t.solidAt(x, cfg.worldHeight - 2)).toBe(true);
  });

  it('keeps an attached cave roof (overhang)', () => {
    const t = terrainFrom(() => 500);
    t.carve(600, 620, 40, opts);
    // Roof between 500 and ~580 stays, cave below it is open.
    expect(t.solidAt(600, 540)).toBe(true);
    expect(t.solidAt(600, 620)).toBe(false);
    expect(t.cols[600].length).toBe(4);
  });

  it('drops a detached chunk onto the ground below', () => {
    const t = terrainFrom(() => 900);
    for (let x = 300; x < 320; x++) t.cols[x] = [500, 540, 900, cfg.worldHeight];
    t.collapse(opts);
    for (let x = 300; x < 320; x++) expect(t.cols[x]).toEqual([860, cfg.worldHeight]);
  });

  it('crumbles thin slivers', () => {
    const t = terrainFrom(() => 900);
    // A thin roof attached to a plateau on the left.
    for (let x = 0; x < 300; x++) t.cols[x] = [500, cfg.worldHeight];
    for (let x = 300; x < 340; x++) t.cols[x] = [500, 502, 900, cfg.worldHeight];
    t.collapse(opts);
    for (let x = 300; x < 340; x++) expect(t.cols[x]).toEqual([900, cfg.worldHeight]);
  });

  it('cutting a ledge from its cliff makes it fall', () => {
    const t = terrainFrom((x) => (x < 400 ? 500 : 900));
    for (let x = 400; x < 470; x++) t.cols[x] = [500, 540, 900, cfg.worldHeight];
    // Ledge is attached, so it stays.
    t.collapse(opts);
    expect(t.cols[450]).toEqual([500, 540, 900, cfg.worldHeight]);
    t.carve(410, 520, 26, opts);
    expect(t.cols[450]).toEqual([860, cfg.worldHeight]);
  });

  it('replays identically from the same crater list', () => {
    const a = generateTerrain(cfg, 31337);
    const b = Terrain.fromData(a.toData(), cfg.bedrock);
    const craters = [
      [400, 600, 26],
      [410, 640, 26],
      [900, 300, 40],
      [905.4, 700.6, 26],
      [1200, 500, 70],
    ];
    for (const [x, y, r] of craters) {
      a.carve(x, y, r, opts);
      b.carve(x, y, r, opts);
    }
    expect(a.cols).toEqual(b.cols);
  });
});
