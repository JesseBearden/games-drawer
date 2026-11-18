import type { Rng } from './rng';

/** Anything that can pick a whole number in a range (an Rng, or a game host's dice). */
export type IntSource = Pick<Rng, 'int'>;

/** Tank-pun names for the bots in Tanks. */
export const TANK_BOT_NAMES = [
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

/** @deprecated Tank bots only; people and card-game bots use randomName(). */
export const DEFAULT_NAMES = TANK_BOT_NAMES;

/** Player names are a title and a snack: "Captain Pancake", "Duchess Nugget". */
export const NAME_TITLES = [
  'Captain', 'Duchess', 'Professor', 'Sir', 'Lady', 'Baron', 'Admiral', 'Doctor', 'Count', 'Agent',
  'Chef', 'Coach', 'Major', 'Judge', 'Mayor', 'Duke', 'Queen', 'King', 'Auntie', 'Uncle',
  'Lil', 'Big', 'DJ', 'Sheriff', 'Grandma', 'Grandpa', 'Cousin', 'Detective', 'General', 'Saint',
];

export const NAME_SNACKS = [
  'Pancake', 'Nugget', 'Pickle', 'Waffles', 'Muffin', 'Toast', 'Dumpling', 'Meatball', 'Noodle', 'Biscuit',
  'Pretzel', 'Taco', 'Burrito', 'Nacho', 'Cupcake', 'Donut', 'Bagel', 'Crouton', 'Tater Tot', 'Gumdrop',
  'Jellybean', 'Marshmallow', 'Cheddar', 'Brisket', 'Churro', 'Cannoli', 'Popcorn', 'Sprinkles', 'Peanut', 'Pudding',
  'Meatloaf', 'Cornbread', 'Snickerdoodle', 'Spud', 'Pierogi', 'Empanada', 'Wonton', 'Gnocchi', 'Ravioli', 'Macaroni',
  'Fudge', 'Toffee', 'Tamale', 'Strudel', 'Croissant', 'Hotcake', 'Pop Tart', 'Fish Stick', 'Jelly Roll', 'Cheese Puff',
];

export const MAX_NAME_LENGTH = 20;

/** A random "Title Snack" name that fits the name length limit. */
export function randomName(rng?: IntSource): string {
  const pick = <T>(list: T[]) => list[rng ? rng.int(0, list.length - 1) : Math.floor(Math.random() * list.length)];
  for (;;) {
    const name = `${pick(NAME_TITLES)} ${pick(NAME_SNACKS)}`;
    if (name.length <= MAX_NAME_LENGTH) return name;
  }
}

/** A random name nobody in `taken` (lower-case) is using. */
export function freshName(taken: Set<string>, rng?: IntSource): string {
  for (let i = 0; i < 50; i++) {
    const n = randomName(rng);
    if (!taken.has(n.toLowerCase())) return n;
  }
  return uniqueName(randomName(rng), taken);
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
