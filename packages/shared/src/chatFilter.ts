/**
 * The chat filter, shared by the browser (which greys out Send before a message would be
 * caught) and the server (which has the final say, since a browser can be modified).
 *
 * Words come from the `obscenity` library's English list, which sees through capitals,
 * leetspeak ("sh1t"), stretched letters and accents. On top of that:
 * - spaced-out spellings ("s h i t") are joined up and checked too;
 * - slurs are blocked in every room, whatever its setting;
 * - EXTRA_BLOCKED words are blocked everywhere as well;
 * - ALLOWED_WORDS are ordinary words that happen to contain a blocked one ("cockpit").
 *
 * Private rooms pick how swearing is handled: 'none' lets it through, 'hide' stars it out,
 * 'block' doesn't send the message. Public rooms always use 'block'.
 */
import { asteriskCensorStrategy, DataSet, englishDataset, englishRecommendedTransformers, RegExpMatcher, TextCensor } from 'obscenity';

export type ChatFilterMode = 'none' | 'hide' | 'block';
export const CHAT_FILTER_MODES: ChatFilterMode[] = ['none', 'hide', 'block'];
export const MAX_CHAT_LENGTH = 200;

export function isChatFilterMode(v: unknown): v is ChatFilterMode {
  return v === 'none' || v === 'hide' || v === 'block';
}

/** What each setting does, for the menu and for the announcement in chat. */
export const CHAT_FILTER_LABELS: Record<ChatFilterMode, { name: string; detail: string }> = {
  none: { name: 'None', detail: 'swearing shows as typed (slurs are still blocked)' },
  hide: { name: 'Hide', detail: 'swear words show as ****' },
  block: { name: 'Block', detail: 'messages with swearing aren’t sent' },
};

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
  if (slurMatcher.hasMatch(text) || slurMatcher.hasMatch(spaced)) return { ok: false, reason: 'slur' };
  const extra = [...EXTRA_BLOCKED, ...extraBlocked].map(normalizeForFilter).filter(Boolean);
  if (extra.length) {
    const norm = normalizeForFilter(text);
    if (extra.some((w) => norm.includes(w))) return { ok: false, reason: 'blocked-word' };
  }
  if (mode === 'none') return { ok: true, text, censored: false };
  const matches = all.getAllMatches(text, true);
  if (mode === 'block') return matches.length || all.hasMatch(spaced) ? { ok: false, reason: 'swearing' } : { ok: true, text, censored: false };
  // 'hide': star out what we can pinpoint. Spaced-out tricks can't be pinpointed, so they're blocked.
  const out = matches.length ? censor.applyTo(text, matches) : text;
  if (all.hasMatch(joinSpacedLetters(out))) return { ok: false, reason: 'swearing' };
  return { ok: true, text: out, censored: out !== text };
}

/** Player names: always held to the strictest setting (they follow people into public games). */
export function nameAllowed(name: string, extraBlocked: string[] = []): boolean {
  return checkChat(name, 'block', extraBlocked).ok;
}
