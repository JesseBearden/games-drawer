import { DataSet, englishDataset } from 'obscenity';
import { describe, expect, it } from 'vitest';
import { ALLOWED_WORDS, checkChat, nameAllowed, SLUR_WORDS } from '../src/index';

describe('chat filter', () => {
  it('None lets swearing through, Hide stars it out, Block stops the message', () => {
    expect(checkChat('well shit', 'none')).toEqual({ ok: true, text: 'well shit', censored: false });
    expect(checkChat('well shit', 'hide')).toEqual({ ok: true, text: 'well ****', censored: true });
    expect(checkChat('well shit', 'block')).toEqual({ ok: false, reason: 'swearing' });
    expect(checkChat('nice shot', 'block')).toEqual({ ok: true, text: 'nice shot', censored: false });
  });

  it('sees through disguises, and blocks the spaced-out ones it cannot star out', () => {
    expect(checkChat('sh1t', 'block').ok).toBe(false);
    expect(checkChat('SHIIIIT', 'block').ok).toBe(false);
    expect(checkChat('s h i t', 'hide')).toEqual({ ok: false, reason: 'swearing' });
    expect(checkChat('this hit was great', 'block').ok).toBe(true);
  });

  it('every slur on the always-blocked list is a word the library knows, and is blocked with the filter off', () => {
    const words = new Set<string>();
    new DataSet<{ originalWord: string }>().addAll(englishDataset).removePhrasesIf((p) => (words.add(p.metadata!.originalWord), false));
    for (const w of SLUR_WORDS) expect(words.has(w)).toBe(true);
    for (const w of SLUR_WORDS) expect(checkChat(`you ${w}`, 'none')).toEqual({ ok: false, reason: 'slur' });
  });

  it('lets everyday words that contain a blocked one through', () => {
    for (const w of [...ALLOWED_WORDS, 'Scunthorpe', 'class', 'assassin', 'flame retardant', 'booby trap', 'pass the cumin']) {
      expect(checkChat(w, 'block').ok, w).toBe(true);
    }
  });

  it('extra blocked words apply in every room', () => {
    expect(checkChat('you are a wombat', 'none', ['wombat'])).toEqual({ ok: false, reason: 'blocked-word' });
  });

  it('names always use the strictest setting', () => {
    expect(nameAllowed('Captain Pancake')).toBe(true);
    expect(nameAllowed('Shithead')).toBe(false);
  });
});
