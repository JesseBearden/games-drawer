// What names and the chat filter both need for telling disguises. (A small file of its own, so the
// filter's word lists can stay cached through game updates.)

/**
 * Characters that show as nothing: the invisible fillers (Hangul's, Khmer's, the joiners) and
 * Braille's blank. (Not the two selectors that make a heart an emoji heart.)
 */
export const SHOWS_NOTHING = /\u2800|(?![\uFE0E\uFE0F])\p{Default_Ignorable_Code_Point}/gu;

/** Letters from other alphabets that look just like an English one. */
const ALPHABETS = [
  ['АВЕЅІЈКМНОРСТУХԚԜ', 'ABESIJKMHOPCTYXQW'], // Cyrillic capitals
  ['аеѕіјорсухһԁԛԝ', 'aesijopcyxhdqw'], // Cyrillic
  ['ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ', 'ABEZHIKMNOPTYX'], // Greek capitals
  ['αικνορυχ', 'aikvopux'], // Greek
  ['ıɪɑɡ', 'iiag'], // Latin's own
] as const;

/** The text with each of those letters written as the English one it looks like. */
export function asEnglishLetters(text: string): string {
  return [...text]
    .map((c) => {
      for (const [theirs, english] of ALPHABETS) {
        const i = theirs.indexOf(c);
        if (i >= 0) return english[i];
      }
      return c;
    })
    .join('');
}
