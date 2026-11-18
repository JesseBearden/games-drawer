import { describe, expect, it } from 'vitest';
import { freshName, MAX_NAME_LENGTH, NAME_SNACKS, NAME_TITLES, randomName, Rng } from '../src/index';

describe('player names', () => {
  it('are a title and a snack, and always fit the length limit', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 2000; i++) {
      const n = randomName(rng);
      expect(n.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(NAME_TITLES.some((t) => n.startsWith(t + ' ') && NAME_SNACKS.includes(n.slice(t.length + 1)))).toBe(true);
    }
  });

  it('there are plenty of them', () => {
    let fits = 0;
    for (const t of NAME_TITLES) for (const s of NAME_SNACKS) if (`${t} ${s}`.length <= MAX_NAME_LENGTH) fits++;
    expect(fits).toBeGreaterThan(1000);
  });

  it('freshName avoids names already in the room', () => {
    const rng = new Rng(9);
    const taken = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const n = freshName(taken, rng);
      expect(taken.has(n.toLowerCase())).toBe(false);
      taken.add(n.toLowerCase());
    }
  });
});
