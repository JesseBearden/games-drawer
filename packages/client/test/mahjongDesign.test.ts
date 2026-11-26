import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/dom', () => ({ patchHtml: () => false, syncKeyed: () => {} }));
const { MJ_MAX_SCALE, MJ_ROOMY_LEAST, mjDesignFor } = await import('../src/mahjongView');

/** Which fixed design (and how big) the Mahjong table gets on each kind of screen. */
const pick = (w: number, h: number) => {
  const { d, s } = mjDesignFor(w, h);
  return { layout: d.layout, upright: d.h > d.w, block: d.block, s };
};

describe('Mahjong design for the screen', () => {
  it('gives an upright phone the upright design, near full size, buttons in a row', () => {
    const p = pick(390, 620);
    expect(p).toMatchObject({ layout: 'tall', block: false });
    expect(p.s).toBeGreaterThan(0.9);
    expect(pick(360, 560)).toMatchObject({ layout: 'tall', block: false });
    expect(pick(430, 760)).toMatchObject({ layout: 'tall', block: false });
  });

  it('keeps the buttons in a block beside the tiles on an upright window with a little room', () => {
    expect(pick(562, 664)).toMatchObject({ layout: 'tall', block: true });
    expect(pick(640, 760)).toMatchObject({ layout: 'tall', block: true });
  });

  it('gives a phone on its side the sideways design', () => {
    expect(pick(844, 340).layout).toBe('wide');
    expect(pick(740, 320).layout).toBe('wide');
  });

  it('gives tablets and computers the whole table, upright too', () => {
    expect(pick(1180, 700).layout).toBe('roomy');
    // An iPad on its side with Messages open beside the table.
    expect(pick(840, 680).layout).toBe('roomy');
    const upright = pick(820, 1040);
    expect(upright).toMatchObject({ layout: 'roomy', upright: true });
  });

  it('never shrinks the whole table past its least, or grows anything past the most', () => {
    for (const [w, h] of [
      [300, 500],
      [700, 500],
      [1000, 560],
      [1280, 560],
      [2560, 1300],
    ]) {
      const p = pick(w, h);
      if (p.layout === 'roomy') expect(p.s).toBeGreaterThanOrEqual(MJ_ROOMY_LEAST);
      expect(p.s).toBeLessThanOrEqual(MJ_MAX_SCALE);
    }
    expect(pick(2560, 1300)).toMatchObject({ layout: 'roomy', upright: false, s: MJ_MAX_SCALE });
  });
});
