import { describe, expect, it } from 'vitest';
import { scoreSheetHtml } from '../src/scoreSheet';

/** The sheet's cells, read back from its HTML: each row's cells as [class, text]. */
function cells(html: string) {
  return [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[hd] class="([^"]*)"[^>]*>(.*?)<\/t[hd]>/g)].map((c) => [c[1], c[2].replace(/<[^>]+>/g, '')]));
}

describe('score sheets', () => {
  it('have one row per player: the name, what each hand scored, then the total', () => {
    const html = scoreSheetHtml(
      [
        { label: 'Jesse', history: [5, 15, 15], total: 20 },
        { label: 'R2-D2', history: [0, 10, 40], total: 40 },
      ],
      false,
    );
    const [head, jesse, r2] = cells(html);
    expect(head.map((c) => c[1])).toEqual(['', 'Hand 1', 'Hand 2', 'Hand 3', 'Total']);
    // History holds running totals; the sheet shows each hand's own points.
    expect(jesse.map((c) => c[1])).toEqual(['Jesse', '5', '10', '0', '20']);
    expect(r2.map((c) => c[1])).toEqual(['R2-D2', '0', '10', '30', '40']);
  });

  it('show minus signs for lost points (Spades)', () => {
    const [, us] = cells(scoreSheetHtml([{ label: 'Us', history: [-100, -40], total: -40 }], false));
    expect(us.map((c) => c[1])).toEqual(['Us', '−100', '60', '−40']);
  });

  it('let older hands drop off: phones keep the last 3, everything else the last 8', () => {
    const history = Array.from({ length: 10 }, (_, i) => i * 5);
    const [head] = cells(scoreSheetHtml([{ label: 'Jesse', history, total: 45 }], true));
    const hands = head.slice(1, -1).map((c) => c[0]);
    expect(hands.slice(0, 2).every((c) => c.includes('ht-older'))).toBe(true);
    expect(hands.slice(2, 7).every((c) => c.includes('ht-old') && !c.includes('ht-older'))).toBe(true);
    expect(hands.slice(7).every((c) => !c.includes('ht-old'))).toBe(true);
    // The hand that just ended is picked out.
    expect(hands[9]).toContain('ht-fresh');
    expect(hands.slice(0, 9).some((c) => c.includes('ht-fresh'))).toBe(false);
  });

  it('show just the names and totals before any hand is over', () => {
    const [head, row] = cells(scoreSheetHtml([{ label: 'Jesse', history: [], total: 0 }], false));
    expect(head.map((c) => c[1])).toEqual(['', 'Total']);
    expect(row.map((c) => c[1])).toEqual(['Jesse', '0']);
  });
});
