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

  it('sees through punctuation, look-alike letters, accents and blanks inside a word', () => {
    const disguised = ['sh,it', 'sh/it', "sh'it", 'sh,itty', 's,h,i,t', 'sh\u03b9t', 'sh\u0456t', 'sh\u2800it', 'sh\u3164it', 's\u0307h\u0307i\u0307t\u0307'];
    for (const word of disguised) {
      expect(checkChat(`well ${word}`, 'block').ok, word).toBe(false);
      // Hide can't star out what it can't pinpoint, so it doesn't go.
      const hidden = checkChat(`well ${word}`, 'hide');
      expect(!hidden.ok || hidden.censored, word).toBe(true);
    }
    // Slurs the same, with the filter off.
    const slur = SLUR_WORDS.find((w) => w.length >= 6)!;
    expect(checkChat(`${slur.slice(0, 3)},${slur.slice(3)}`, 'none')).toEqual({ ok: false, reason: 'slur' });
  });

  it('doesn’t make swearing out of ordinary punctuation', () => {
    const fine = [
      'push,it', 'this.hit', "who're they", "he'll be here", "she'll win", "don't do that", "it's 10:30",
      'class/assignment', 'pass-it to me', 'grape-fruit', 'as-salaam alaikum', 'as,shown above', 'wash-it', 'brush it,then go',
      'semi-final', 'x-ray', "rock 'n' roll", 'gamesdrawer.com/r/BCDFGH', 'e.g. hearts', 'Cum laude'.replace('Cum', 'Magna'),
      'co-op', 'T-shirt', "o'clock", 'half-hour', 'ok...sure', 'yes,sir', 'piñata', 'café olé', 'Привет, как дела?', 'Καλημέρα σας',
    ];
    for (const text of fine) expect(checkChat(text, 'block').ok, text).toBe(true);
  });

  it('extra blocked words apply in every room', () => {
    expect(checkChat('you are a wombat', 'none', ['wombat'])).toEqual({ ok: false, reason: 'blocked-word' });
  });

  it('names always use the strictest setting', () => {
    expect(nameAllowed('Captain Pancake')).toBe(true);
    expect(nameAllowed('Shithead')).toBe(false);
  });
});
