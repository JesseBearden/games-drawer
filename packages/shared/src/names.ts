import { asEnglishLetters, SHOWS_NOTHING } from './lookAlike';
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
  'Tank McTankface',
  'Shell Yeah',
  'Shell Shocked',
  'Sir Shellsalot',
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

/** First names, or a first name and an initial ("Mike B"), not full names (the user, 2026-11-21). */
export const MAX_NAME_LENGTH = 15;

/**
 * Computer players in the card games have made-up robot names, so it's plain who isn't a
 * person (their name tags also carry a small computer symbol). Our own names only: no robots
 * from films, shows or toys. No two that look alike at a glance (Beep Boop and Bleep Bloop
 * were too close: user, 2026-11-20).
 */
export const ROBOT_NAMES = [
  'Robo-Bob',
  'Beep Boop',
  'Sprocket',
  'Rusty Bolts',
  'Botley',
  'Widget',
  'Unit 7',
  'Tin Can Tom',
  'Sparky 3000',
];

/** A robot name nobody in `taken` (lower-case) is using. */
export function freshBotName(taken: Set<string>, rng?: IntSource): string {
  const free = ROBOT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  const list = free.length ? free : ROBOT_NAMES;
  const n = list[rng ? rng.int(0, list.length - 1) : Math.floor(Math.random() * list.length)];
  return free.length ? n : uniqueName(n, taken);
}

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

/** What two names share when they can't be told apart at a glance. */
export function nameKey(name: string): string {
  const plain = name.normalize('NFKC').replace(SHOWS_NOTHING, '').replace(/[\uFE0E\uFE0F]/g, '');
  return asEnglishLetters(plain).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Names that would pass for the site itself. */
const RESERVED = new Set(['gamesdrawer', 'admin', 'administrator', 'moderator']);

export function isReservedName(name: string): boolean {
  return RESERVED.has(nameKey(name).replace(/[^a-z0-9]/g, ''));
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
    .replace(SHOWS_NOTHING, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, maxLength).join('').trim();
}

/** Clean a player name. Returns '' if nothing readable is left: no letter, number or emoji. */
export function cleanName(raw: string): string {
  // (An emoji's own selector stays. No lookbehind: iPhones before 16.4 can't read one.)
  const bare = raw.replace(/(\p{Extended_Pictographic}[\uFE0E\uFE0F])|[\uFE0E\uFE0F]/gu, (_, emoji?: string) => emoji ?? '');
  const name = cleanText(bare, MAX_NAME_LENGTH);
  return /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(name) ? name : '';
}

/** Append " 2", " 3"... so no two names in a room are the same, or look it (nameKey). */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map(nameKey));
  if (!set.has(nameKey(name))) return name;
  for (let i = 2; i < 100; i++) {
    const suffix = ` ${i}`;
    const candidate = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
    if (!set.has(nameKey(candidate))) return candidate;
  }
  return name;
}
