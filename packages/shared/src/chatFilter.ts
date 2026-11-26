/**
 * The chat filter, shared by the browser (which greys out Send before a message would be
 * caught) and the server (which has the final say, since a browser can be modified).
 *
 * Words come from the `obscenity` library's English list, which sees through capitals,
 * leetspeak ("sh1t"), stretched letters and accents. On top of that:
 * - spaced-out spellings ("s h i t") are joined up and checked too;
 * - so are words written with accents, look-alike letters, or punctuation inside them;
 * - slurs are blocked in every room, whatever its setting;
 * - EXTRA_BLOCKED words are blocked everywhere as well;
 * - ALLOWED_WORDS are ordinary words that happen to contain a blocked one ("cockpit").
 *
 * Each table picks how swearing is handled: 'none' lets it through, 'hide' stars it out,
 * 'block' doesn't send the message.
 */
import { asteriskCensorStrategy, DataSet, englishDataset, englishRecommendedTransformers, RegExpMatcher, TextCensor } from 'obscenity';
import { MAX_CHAT_LENGTH, type ChatFilterMode } from './chatModes';
import { asEnglishLetters, SHOWS_NOTHING } from './lookAlike';

const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

/**
 * Slurs against groups of people (by the library's base word), blocked in every room. Written
 * in ROT13 so they don't sit in the source as plain text.
 */
export const SLUR_WORDS = ['nob', 'norrq', 'nsevpbba', 'nenohfu', 'obbatn', 'puvatpubat', 'puvax', 'qlxr', 'snt', 'xvxr', 'arteb', 'avttre', 'ergneq', 'fcnfgvp', 'genaal'].map(rot13);

/** Extra words or phrases to block everywhere (the library covers the common ones). */
export const EXTRA_BLOCKED: string[] = [];

/**
 * Everyday words that contain a blocked one. Matches inside these are ignored. Add to this
 * when someone reports a harmless word being caught.
 */
export const ALLOWED_WORDS: string[] = [
  'cockpit',
  'cumin',
  'shiitake',
  'dickinson',
  'retardant',
  'booby',
  'chinking',
  'penistone',
  'pissarro',
  'fagin',
];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '|': 'l' };

/** Lower-case letters only, with accents, leetspeak and long repeats undone (for EXTRA_BLOCKED). */
export function normalizeForFilter(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c)
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1');
}

/**
 * Join runs of single characters ("f u c k", "s.h.i.t") into one word while leaving normal
 * words apart, so spaced-out spellings are caught without false hits across real words.
 */
export function joinSpacedLetters(text: string): string {
  const tokens = text.split(/[\s._\-*~+]+/).filter(Boolean);
  const out: string[] = [];
  let run = '';
  for (const tok of tokens) {
    if ([...tok].length === 1) {
      run += tok;
      continue;
    }
    if (run) out.push(run);
    run = '';
    out.push(tok);
  }
  if (run) out.push(run);
  return out.join(' ');
}

/**
 * A message with disguises taken off: accents, blank characters, and (in words that are partly
 * English) letters from other alphabets that look English. Words wholly in another alphabet are
 * left alone, or ordinary Russian and Greek would read as English nonsense.
 */
function undisguise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(SHOWS_NOTHING, '')
    .replace(/\p{M}/gu, '')
    .split(' ')
    .map((word) => (/[a-z]/i.test(word) ? asEnglishLetters(word) : word))
    .join(' ');
}

/** "don't", "he'll": the apostrophe belongs there. */
const CONTRACTION = /^(\p{L}+n['’]t|\p{L}+['’](re|ll|s|d|ve|m))$/iu;
/** What can follow a caught word and still be that word. */
const WORD_ENDING = /^(s|z|es|ed|er|ers|in|ing|y|ty|head|heads|hole|holes|face)?$/i;

/**
 * A word that's only a swear word once the punctuation inside it is taken out. The match has to
 * be the whole word: "push,it" and "this.hit" run two ordinary words together and are fine.
 */
function punctuatedMatch(m: RegExpMatcher, text: string): boolean {
  const words: string[] = [];
  for (const token of text.split(/\s+/)) {
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!/[^\p{L}\p{N}]/u.test(word) || CONTRACTION.test(word)) continue;
    words.push(word.replace(/[^\p{L}\p{N}]/gu, ''));
  }
  if (!words.length) return false;
  const joined = words.join(' ');
  return m.getAllMatches(joined).some(({ startIndex, endIndex }) => {
    if (startIndex > 0 && joined[startIndex - 1] !== ' ') return false;
    return WORD_ENDING.test(joined.slice(endIndex + 1).split(' ')[0]);
  });
}

function matcher(keep: (word: string) => boolean) {
  const data = new DataSet<{ originalWord: string }>().addAll(englishDataset).removePhrasesIf((p) => !keep(p.metadata?.originalWord ?? ''));
  const built = data.build();
  return new RegExpMatcher({ ...built, whitelistedTerms: [...(built.whitelistedTerms ?? []), ...ALLOWED_WORDS], ...englishRecommendedTransformers });
}

const slurs = new Set(SLUR_WORDS);
let matchers: { all: RegExpMatcher; slurs: RegExpMatcher } | null = null;
/** Built on first use (it compiles a few hundred patterns). */
function getMatchers() {
  matchers ??= { all: matcher(() => true), slurs: matcher((w) => slurs.has(w)) };
  return matchers;
}
const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

export type ChatCheck =
  | { ok: true; text: string; censored: boolean }
  | { ok: false; reason: 'empty' | 'too-long' | 'slur' | 'blocked-word' | 'swearing' };

/**
 * Decide what happens to a message. `extraBlocked` adds words (the server's blocklist file).
 * Returns the text to send (stars in place of swearing in 'hide' rooms), or why it can't go.
 */
export function checkChat(raw: string, mode: ChatFilterMode, extraBlocked: string[] = []): ChatCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if ([...text].length > MAX_CHAT_LENGTH) return { ok: false, reason: 'too-long' };
  const { all, slurs: slurMatcher } = getMatchers();
  const spaced = joinSpacedLetters(text);
  const plain = undisguise(text);
  /** Caught only with the disguise off, so it can't be starred out. */
  const disguised = (m: RegExpMatcher, as: string) => (as !== text && (m.hasMatch(as) || m.hasMatch(joinSpacedLetters(as)))) || punctuatedMatch(m, as);
  if (slurMatcher.hasMatch(text) || slurMatcher.hasMatch(spaced) || disguised(slurMatcher, plain)) return { ok: false, reason: 'slur' };
  const extra = [...EXTRA_BLOCKED, ...extraBlocked].map(normalizeForFilter).filter(Boolean);
  if (extra.length) {
    const norm = normalizeForFilter(text);
    if (extra.some((w) => norm.includes(w))) return { ok: false, reason: 'blocked-word' };
  }
  if (mode === 'none') return { ok: true, text, censored: false };
  const matches = all.getAllMatches(text, true);
  if (mode === 'block') return matches.length || all.hasMatch(spaced) || disguised(all, plain) ? { ok: false, reason: 'swearing' } : { ok: true, text, censored: false };
  // 'hide': star out what we can pinpoint. Spaced-out tricks can't be pinpointed, so they're blocked.
  const out = matches.length ? censor.applyTo(text, matches) : text;
  if (all.hasMatch(joinSpacedLetters(out)) || disguised(all, undisguise(out))) return { ok: false, reason: 'swearing' };
  return { ok: true, text: out, censored: out !== text };
}
