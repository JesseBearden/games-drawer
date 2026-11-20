/**
 * Every game on Games Drawer, in the order the home page and lobby show them. This one list
 * drives the home page, each game's own page (gamesdrawer.com/<slug>), the private-room
 * lobby, link previews, and which games the server will start.
 */

import { DOMINOES_RULES } from './dominoes';

/** There's no domino emoji, so Dominoes draws its own little tile. */
const DOMINO_ICON =
  '<svg class="domino-icon" viewBox="0 0 24 44" width="1em" height="1.8em" aria-hidden="true"><rect x="1" y="1" width="22" height="42" rx="4" fill="#fffdf6" stroke="#1b1b28" stroke-width="2"/><line x1="4" y1="22" x2="20" y2="22" stroke="#1b1b28" stroke-width="2"/><circle cx="7" cy="7" r="2.4" fill="#1b1b28"/><circle cx="12" cy="12" r="2.4" fill="#1b1b28"/><circle cx="17" cy="17" r="2.4" fill="#1b1b28"/><circle cx="7" cy="27" r="2.4" fill="#1b1b28"/><circle cx="17" cy="27" r="2.4" fill="#1b1b28"/><circle cx="7" cy="37" r="2.4" fill="#1b1b28"/><circle cx="17" cy="37" r="2.4" fill="#1b1b28"/></svg>';

export type GameId = 'tanks' | 'hearts' | 'spades' | 'dominoes' | 'jigsaw';

/**
 * How far a game is rolled out. A new game ships as 'private' (only private rooms can pick
 * it, so friends try it first), then goes 'public' (its own page and public matchmaking).
 * 'off' hides it everywhere without removing the code.
 */
export type Availability = 'off' | 'private' | 'public';

export interface GameInfo {
  id: GameId;
  /** Short name for buttons and chat: "Tanks". */
  name: string;
  /** Page title: "Tank You For Being A Friend". */
  title: string;
  /** Its page: gamesdrawer.com/<slug>. */
  slug: string;
  /** Other addresses that lead to the same page. */
  aliases: string[];
  icon: string;
  /** One line, for link previews and under the title. */
  tagline: string;
  /** A sentence for the home page card and the lobby. */
  blurb: string;
  howTo: string[];
  players: string;
  availability: Availability;
  /** Still being finished: its tile at the table says "Work in Progress". (All off since
   *  2026-11-20, at the user's request: switch one back on when it needs it.) */
  underConstruction: boolean;
  /** Phones play it sideways. */
  landscape: boolean;
}

export const GAMES: GameInfo[] = [
  {
    id: 'tanks',
    name: 'Tanks',
    title: 'Tank You For Being A Friend',
    slug: 'tanks',
    aliases: ['tankyouforbeingafriend', 'tank'],
    icon: '💥',
    tagline: 'Drop in by helicopter and blow up your friends.',
    blurb: 'Real-time artillery: aim, mind the wind, and blast your friends off the hills.',
    howTo: [
      'Aim and set your power, then fire. Wind bends every shot, so watch the windsock.',
      'Each kill levels you up: faster shells, driving, triple shots. Level 10 wins.',
      'On a computer: arrow keys aim, Space fires, A and D drive. On a phone, use the buttons on screen.',
    ],
    players: '1–4 players · bots fill in',
    availability: 'public',
    underConstruction: false,
    landscape: true,
  },
  {
    id: 'hearts',
    name: 'Hearts',
    title: 'Hearts',
    slug: 'hearts',
    aliases: [],
    icon: '♥️',
    tagline: 'The classic card game: dodge the hearts and the queen of spades.',
    blurb: 'The classic trick-taking card game. Avoid hearts and the queen of spades.',
    howTo: [
      'Pass 3 cards, then follow suit if you can.',
      'Each heart is a point and the queen of spades is 13. Lowest score wins.',
      'Take every heart and the queen to shoot the moon.',
    ],
    players: '4 seats · bots fill in',
    // Back to private rooms while it's finished (it was public).
    availability: 'private',
    underConstruction: false,
    landscape: false,
  },
  {
    id: 'spades',
    name: 'Spades',
    title: 'Spades',
    slug: 'spades',
    aliases: [],
    icon: '♠️',
    tagline: 'Team up with the player across from you, bid your tricks, and make them.',
    blurb: 'Partners bid how many tricks they’ll take. Spades are trump. Make your bid without piling up bags.',
    howTo: [
      'You and the player across are a team. Each of you bids how many tricks you’ll take.',
      'Follow suit if you can. Spades beat everything, but can’t be led until one is played.',
      'Make your team’s bid for 10 a trick; every 10 extra tricks costs 100. First to 500 wins.',
    ],
    players: '2 teams of 2 · bots fill in',
    // New: private rooms first, then everyone (see Availability).
    availability: 'private',
    underConstruction: false,
    landscape: false,
  },
  {
    id: 'dominoes',
    name: 'Dominoes',
    title: 'Dominoes',
    slug: 'dominoes',
    aliases: ['dominos', 'allfives', 'all-fives', 'muggins'],
    icon: DOMINO_ICON,
    tagline: 'All Fives: match the ends, and score when they add up to a multiple of 5.',
    blurb: 'All Fives: match the ends, and score whenever they add up to a multiple of 5.',
    howTo: [
      'Everyone gets 7 tiles. Play one that matches an open end; if nothing fits, you pass.',
      'After you play, if the open ends add up to 5, 10, 15… you score that many.',
      `Go out first to score everyone’s leftover pips. First to ${DOMINOES_RULES.target} wins.`,
    ],
    players: '4 seats · bots fill in',
    availability: 'private',
    underConstruction: false,
    landscape: false,
  },
  {
    id: 'jigsaw',
    name: 'Jigsaw',
    title: 'Jigsaw Puzzle',
    slug: 'jigsaw',
    aliases: ['puzzle', 'jigsaw-puzzle', 'jigsawpuzzle'],
    icon: '🧩',
    tagline: 'Build a jigsaw together: everyone works on the same table.',
    blurb: 'Choose a puzzle and how many pieces, then build it together. It saves as you go.',
    howTo: [
      'Drag pieces around the table. When two fit, they snap together and move as one.',
      'Pinch or scroll to zoom, and drag the empty table to look around.',
      'It saves as you go: come back any time and pick “Continue a puzzle”.',
    ],
    players: 'Up to 4 together',
    availability: 'public',
    underConstruction: false,
    landscape: false,
  },
];

export const GAME_IDS: GameId[] = GAMES.map((g) => g.id);
/** Games where where you sit matters (turn order, partners): people pick their seats first. */
export const SEATED_GAMES: readonly GameId[] = ['hearts', 'spades', 'dominoes'];
export const isSeated = (g: GameId | null): boolean => !!g && SEATED_GAMES.includes(g);
export const SEAT_COUNT = 4;
export const GAME_NAMES = Object.fromEntries(GAMES.map((g) => [g.id, g.name])) as Record<GameId, string>;

export function isGameId(v: unknown): v is GameId {
  return typeof v === 'string' && (GAME_IDS as string[]).includes(v);
}

export function gameInfo(id: GameId): GameInfo {
  return GAMES.find((g) => g.id === id)!;
}

/** Private rooms can pick it. */
export function canPlayPrivately(id: GameId) {
  return gameInfo(id).availability !== 'off';
}

/** It has its own page and public matchmaking. */
export function canPlayPublicly(id: GameId) {
  return gameInfo(id).availability === 'public';
}

/**
 * The game a page address is for: "/hearts", "/Hearts/", or an alias like
 * "/tankyouforbeingafriend". Games that are off have no page.
 */
export function gameForPath(pathname: string): GameInfo | null {
  const m = /^\/([A-Za-z0-9-]+)\/?$/.exec(pathname);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  const g = GAMES.find((x) => x.slug === slug || x.aliases.includes(slug));
  return g && g.availability !== 'off' ? g : null;
}
