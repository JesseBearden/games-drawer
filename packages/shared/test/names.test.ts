import { describe, expect, it } from 'vitest';
import { cleanName, cleanText, freshBotName, freshName, isReservedName, MAX_NAME_LENGTH, NAME_SNACKS, NAME_TITLES, randomName, Rng, ROBOT_NAMES, uniqueName } from '../src/index';

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

  it('a name that shows as nothing is no name', () => {
    for (const blank of ['\u3164', '\u2800', '\uFFA0', '\u115F\u1160', '\u034F', '\uFE0F', '...']) expect(cleanName(blank), JSON.stringify(blank)).toBe('');
    for (const padded of ['Mom\u3164', 'Mom\uFE0F', 'Mo\u034Fm', '\u2800Mom']) expect(cleanName(padded), JSON.stringify(padded)).toBe('Mom');
    for (const real of ['Łukasz', 'Jose\u0301', 'R2-D2', '李', 'राम', '김민', 'Mike B', '\u2764\uFE0F', '🌻']) expect(cleanName(real), real).toBe(real.normalize('NFC'));
    // An emoji in a message keeps the mark that makes it one.
    expect(cleanText('love you \u2764\uFE0F', 50)).toBe('love you \u2764\uFE0F');
  });

  it('a name that looks like one already here gets a number', () => {
    for (const twin of ['mom', 'M\u043Em', '\u039Com', '\uFF2D\uFF4F\uFF4D']) expect(uniqueName(twin, ['Mom']), twin).toBe(`${twin} 2`);
    expect(uniqueName('Tom', ['Mom'])).toBe('Tom');
    expect(uniqueName('Вова', ['Вера'])).toBe('Вова');
  });

  it('the Greek letter that looks like a v counts as a v', () => {
    expect(uniqueName('Li\u03BD', ['Liv'])).toBe('Li\u03BD 2');
  });

  it('making room for the number never cuts an emoji in half', () => {
    const long = '🙂'.repeat(MAX_NAME_LENGTH);
    expect(uniqueName(long, [long])).toBe(`${'🙂'.repeat(MAX_NAME_LENGTH - 2)} 2`);
  });

  it('nobody can be called the site', () => {
    for (const n of ['Games Drawer', 'ADMIN', '\u0410dmin', 'moderator']) expect(isReservedName(n), n).toBe(true);
    for (const n of ['Adam', 'Drew', 'Captain Pancake']) expect(isReservedName(n), n).toBe(false);
  });

  it('computer players get made-up robot names, never two the same at a table', () => {
    const rng = new Rng(5);
    for (let t = 0; t < 200; t++) {
      // A person is already called Sprocket: the three computer players pick around them.
      const taken = new Set(['sprocket']);
      for (let i = 0; i < 3; i++) {
        const n = freshBotName(taken, rng);
        expect(ROBOT_NAMES).toContain(n);
        expect(taken.has(n.toLowerCase())).toBe(false);
        taken.add(n.toLowerCase());
      }
    }
    // Every robot taken: still a name nobody has.
    const all = new Set(ROBOT_NAMES.map((n) => n.toLowerCase()));
    expect(all.has(freshBotName(all, rng).toLowerCase())).toBe(false);
  });
});
