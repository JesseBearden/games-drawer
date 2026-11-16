import type { Rng } from './rng';

export const DEFAULT_NAMES = [
  'Tanks A Lot',
  'Tank Top',
  'Think Tank',
  'Fish Tank',
  'Septic Tank',
  'Tanksgiving',
  'Tank Half Full',
  'Tanky McTankface',
  'Shell Yeah',
  'Shell Shocked',
  'Sir Shells-a-Lot',
  'Blast Friend',
  'Friendly Fire',
  'Pal Howitzer',
  'Loose Cannon',
  'Barrel Roll',
  'Crater Later',
  'Crater Tot',
  'Dirt Nap',
  'Overhang Ten',
  'Tread Lightly',
  'Para-Shoot',
  'Chopper Dropper',
  'Windbag',
  'Boom Buddy',
];

export const MAX_NAME_LENGTH = 20;

export function randomName(rng?: Rng): string {
  const i = rng ? rng.int(0, DEFAULT_NAMES.length - 1) : Math.floor(Math.random() * DEFAULT_NAMES.length);
  return DEFAULT_NAMES[i];
}

/**
 * Make user text safe to show: NFC-normalise, turn control characters (newlines, tabs) into
 * spaces, drop other invisible characters (zero-width, bidi overrides, private use), cap
 * stacked accents at two per character, collapse whitespace and cap the length (in code
 * points, so emoji are never cut in half).
 */
export function cleanText(raw: string, maxLength: number): string {
  const s = raw
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    // \p{Cf} format, \p{Co} private use, \p{Cn} unassigned, \p{Cs} lone surrogates
    .replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, maxLength).join('').trim();
}

/** Clean a player name. Returns '' if nothing is left. */
export function cleanName(raw: string): string {
  return cleanText(raw, MAX_NAME_LENGTH);
}

/** Append " 2", " 3"... so names are unique within a room. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((n) => n.toLowerCase()));
  if (!set.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i++) {
    const suffix = ` ${i}`;
    const candidate = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
    if (!set.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}
