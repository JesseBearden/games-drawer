/**
 * Mahjong: Hong Kong style, with points optional. Rules, scoring and a computer player. Pure and
 * deterministic given the wall, so the server runs it and tests can replay whole hands.
 *
 * Agreed with the user (2026-11-22/23):
 * - 144 tiles (dots, bamboo and characters 1-9, four of each; the winds and dragons, four of each;
 *   four flowers and four seasons, one of each). Always 4 players: computers fill in.
 * - No passing tiles and no card (that's American Mahjong).
 * - The dealer starts with 14 tiles, everyone else 13. Flowers and seasons are set aside face up
 *   and replaced from the back of the wall, at the deal and whenever one is drawn.
 * - Play goes round the seats in order (counter-clockwise at the table). Your turn: take the next
 *   tile from the wall, then throw one away.
 * - Anyone can take a discard to make a Pung (three alike) or Kong (four alike); only the next
 *   player can take it for a Chow (three in a row, one suit). Mahjong beats Pung and Kong, which
 *   beat Chow. Two people going Mahjong on one discard: the next in turn from the discarder wins.
 * - A Kong takes a replacement tile from the back of the wall. Adding a fourth tile to your own Pung
 *   can be "robbed": anyone who could go Mahjong on that tile takes it.
 * - Mahjong is four sets and a pair (sets you've taken count), drawn yourself or off a discard.
 * - The wall running out ends the hand with no winner.
 * - Without points: any complete hand wins, no special hands, and the table counts hands won.
 * - With points (the "real way"): Hong Kong faan, at least MJ_MIN_FAAN to go Mahjong, limit hands
 *   (like Thirteen Orphans) allowed, flowers score. Points are play points only, never money.
 */

import { shuffled } from './threeThirteen';

/**
 * A tile kind: dots "d1"-"d9", bamboo "b1"-"b9", characters "c1"-"c9", winds "we" "ws" "ww" "wn",
 * dragons "dr" (red) "dg" (green) "dw" (white), flowers "f1"-"f4" and seasons "f5"-"f8".
 * Tiles of the same kind are interchangeable, so a hand is just a list of kinds.
 */
export type MjTile = string;

const SUITS = ['d', 'b', 'c'] as const;
export const MJ_KINDS: readonly MjTile[] = [
  ...SUITS.flatMap((s) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${s}${n}`)),
  'we',
  'ws',
  'ww',
  'wn',
  'dr',
  'dg',
  'dw',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
];
/** Kinds that make hands (everything but the flowers). */
const PLAY_KINDS = 34;
const INDEX = new Map(MJ_KINDS.map((k, i) => [k, i]));
const WIND0 = 27;
const DRAGON0 = 31;

export const MJ_SEATS = 4;
/** Fewest faan that may go Mahjong when playing with points. */
export const MJ_MIN_FAAN = 3;
/** The most a hand can be worth; limit hands are worth this. */
export const MJ_LIMIT = 10;
/** Points for a hand of each faan, 0 up to the limit (Hong Kong "half-spicy"). */
export const MJ_FAAN_POINTS = [1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128];
export const WIND_NAMES = ['East', 'South', 'West', 'North'];
export const WIND_LETTERS = ['E', 'S', 'W', 'N'];

export function isMjTile(v: unknown): v is MjTile {
  return typeof v === 'string' && INDEX.has(v);
}

/** 0-41, the order of MJ_KINDS (also the art's order). */
export const mjIndex = (t: MjTile) => INDEX.get(t)!;
export const isFlower = (t: MjTile) => mjIndex(t) >= PLAY_KINDS;
const suited = (i: number) => i < 27;
const honor = (i: number) => i >= 27 && i < PLAY_KINDS;
const terminal = (i: number) => suited(i) && (i % 9 === 0 || i % 9 === 8);
const isDragon = (i: number) => i >= DRAGON0 && i < PLAY_KINDS;
const isWind = (i: number) => i >= WIND0 && i < DRAGON0;
/** Dots 0, bamboo 1, characters 2; honours 3. */
const suitOf = (i: number) => (suited(i) ? Math.floor(i / 9) : 3);

/** The whole set, in order: four of each playing kind and one of each flower and season. */
export function mjTileSet(): MjTile[] {
  const out: MjTile[] = [];
  for (let i = 0; i < PLAY_KINDS; i++) for (let k = 0; k < 4; k++) out.push(MJ_KINDS[i]);
  for (let i = PLAY_KINDS; i < MJ_KINDS.length; i++) out.push(MJ_KINDS[i]);
  return out;
}

/** "5 dots", "East wind", "Red dragon", "Flower 2". */
export function mjTileName(t: MjTile): string {
  const i = mjIndex(t);
  if (i < 27) return `${(i % 9) + 1} ${['dots', 'bamboo', 'characters'][Math.floor(i / 9)]}`;
  if (i < 31) return `${WIND_NAMES[i - 27]} wind`;
  if (i < DRAGON0 + 3) return `${['Red', 'Green', 'White'][i - DRAGON0]} dragon`;
  return i < 38 ? `Flower ${i - 33}` : `Season ${i - 37}`;
}

/** In the art's order: dots, bamboo, characters, winds, dragons, flowers. */
export function mjSort(tiles: readonly MjTile[]): MjTile[] {
  return [...tiles].sort((a, b) => mjIndex(a) - mjIndex(b));
}

function counts(tiles: readonly MjTile[]): number[] {
  const c = new Array<number>(PLAY_KINDS).fill(0);
  for (const t of tiles) {
    const i = mjIndex(t);
    if (i < PLAY_KINDS) c[i]++;
  }
  return c;
}

const countOf = (tiles: readonly MjTile[], t: MjTile) => tiles.reduce((n, x) => n + (x === t ? 1 : 0), 0);

function removeTiles(hand: MjTile[], tiles: readonly MjTile[]): boolean {
  const copy = [...hand];
  for (const t of tiles) {
    const i = copy.indexOf(t);
    if (i < 0) return false;
    copy.splice(i, 1);
  }
  hand.splice(0, hand.length, ...copy);
  return true;
}

// ------------------------------------------------------------------ hands

export type MjMeldKind = 'chow' | 'pung' | 'kong';

/** A set laid face up (or a concealed Kong, shown as one). */
export interface MjMeld {
  kind: MjMeldKind;
  tiles: MjTile[];
  /** Whose discard it took (null: made from your own tiles). */
  from: number | null;
  /** A Kong made of four tiles from your own hand. */
  concealed: boolean;
}

/** One set in a way of reading a hand: a Chow from `tile` up, or three (or four) of `tile`. */
interface ShapeSet {
  kind: 'chow' | 'pung';
  tile: number;
  kong: boolean;
  concealed: boolean;
}

/** Every way the tiles split into `need` sets (Chows and Pungs) and a pair. */
function shapes(c: number[], need: number): { pair: number; sets: ShapeSet[] }[] {
  const total = c.reduce((a, b) => a + b, 0);
  if (total !== need * 3 + 2) return [];
  const out: { pair: number; sets: ShapeSet[] }[] = [];
  const acc: ShapeSet[] = [];
  const sets = (i: number, pair: number) => {
    while (i < PLAY_KINDS && c[i] === 0) i++;
    if (i === PLAY_KINDS) {
      if (acc.length === need) out.push({ pair, sets: [...acc] });
      return;
    }
    if (acc.length >= need) return;
    if (c[i] >= 3) {
      c[i] -= 3;
      acc.push({ kind: 'pung', tile: i, kong: false, concealed: true });
      sets(i, pair);
      acc.pop();
      c[i] += 3;
    }
    if (suited(i) && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--, c[i + 1]--, c[i + 2]--;
      acc.push({ kind: 'chow', tile: i, kong: false, concealed: true });
      sets(i, pair);
      acc.pop();
      c[i]++, c[i + 1]++, c[i + 2]++;
    }
  };
  for (let p = 0; p < PLAY_KINDS; p++) {
    if (c[p] < 2) continue;
    c[p] -= 2;
    sets(0, p);
    c[p] += 2;
  }
  return out;
}

const ORPHANS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

function thirteenOrphans(c: number[]): boolean {
  let pairs = 0;
  for (let i = 0; i < PLAY_KINDS; i++) {
    if (ORPHANS.includes(i)) {
      if (c[i] < 1 || c[i] > 2) return false;
      if (c[i] === 2) pairs++;
    } else if (c[i]) return false;
  }
  return pairs === 1;
}

/** Is this a complete hand: four sets and a pair, counting the sets already laid down? */
export function mjIsComplete(concealed: readonly MjTile[], melds: readonly MjMeld[], special = false): boolean {
  const c = counts(concealed);
  if (shapes(c, 4 - melds.length).length) return true;
  return special && melds.length === 0 && thirteenOrphans(c);
}

// ------------------------------------------------------------------ scoring

export interface MjScoreItem {
  name: string;
  faan: number;
  /** A plain explanation, for learning. */
  why: string;
}

export interface MjScore {
  faan: number;
  items: MjScoreItem[];
  limit: boolean;
}

/** Everything about a win that its faan depends on. */
export interface MjWin {
  /** The winner's concealed tiles, with the winning tile. */
  concealed: MjTile[];
  melds: MjMeld[];
  flowers: MjTile[];
  winTile: MjTile;
  selfDrawn: boolean;
  /** 0-3: East, South, West, North. */
  seatWind: number;
  prevailing: number;
  lastTile: boolean;
  kongReplacement: boolean;
  robbedKong: boolean;
  heavenly: boolean;
  earthly: boolean;
}

const LIMIT_WHY: Record<string, string> = {
  'Heavenly hand': 'The dealer’s first 14 tiles were already a winning hand.',
  'Earthly hand': 'Won on the dealer’s very first discard.',
  'Thirteen orphans': 'One of every 1, 9, wind and dragon, plus a pair of one of them.',
  'All Kongs': 'Four Kongs and a pair.',
  'Four concealed Pungs': 'Four Pungs made from your own tiles, none taken from a discard.',
  'Big four winds': 'A Pung of every wind.',
  'Small four winds': 'Pungs of three winds and a pair of the fourth.',
  'All honours': 'Nothing but winds and dragons.',
  'All terminals': 'Nothing but 1s and 9s.',
  'Nine gates': '1-1-1-2-3-4-5-6-7-8-9-9-9 in one suit, plus any tile of that suit, all your own.',
};

/**
 * A limit hand is worth MJ_LIMIT however many limits it makes, so they share one row ("All Kongs
 * and Four concealed Pungs"): the rows a player sees always add up to the total.
 */
function limitScore(names: string[]): MjScore {
  const name = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return { faan: MJ_LIMIT, limit: true, items: [{ name, faan: MJ_LIMIT, why: names.map((n) => LIMIT_WHY[n]).join(' ') }] };
}

/** What a winner's flowers and seasons are worth: each item 1 faan. */
function flowerItems(flowers: readonly MjTile[], seatWind: number): MjScoreItem[] {
  const f = flowers.map(mjIndex);
  const out: MjScoreItem[] = [];
  const add = (name: string, why: string) => out.push({ name, faan: 1, why });
  if (!f.length) add('No flowers', 'No flowers or seasons all hand.');
  if (f.includes(PLAY_KINDS + seatWind)) add('Your own flower', `Flower ${seatWind + 1} goes with your seat (${WIND_NAMES[seatWind]}).`);
  if (f.includes(PLAY_KINDS + 4 + seatWind)) add('Your own season', `Season ${seatWind + 1} goes with your seat (${WIND_NAMES[seatWind]}).`);
  if ([0, 1, 2, 3].every((k) => f.includes(PLAY_KINDS + k))) add('All four flowers', 'Every flower.');
  if ([4, 5, 6, 7].every((k) => f.includes(PLAY_KINDS + k))) add('All four seasons', 'Every season.');
  return out;
}

/**
 * What a winning hand is worth, read the way that scores most. Null if it isn't a winning hand.
 * Limit hands are worth MJ_LIMIT; nothing is worth more (an ordinary hand that adds up to more
 * ends with an "Over the limit" row taking off the extra, so the rows still add up).
 */
export function mjScore(w: MjWin): MjScore | null {
  const c = counts(w.concealed);
  const winIdx = mjIndex(w.winTile);
  const exposedSets: ShapeSet[] = w.melds.map((m) => ({
    kind: m.kind === 'chow' ? 'chow' : 'pung',
    tile: mjIndex(m.tiles[0]),
    kong: m.kind === 'kong',
    concealed: m.concealed,
  }));
  const open = w.melds.some((m) => !m.concealed);

  const always: string[] = [];
  if (w.heavenly) always.push('Heavenly hand');
  if (w.earthly) always.push('Earthly hand');
  if (w.melds.length === 0 && thirteenOrphans(c)) return limitScore([...always, 'Thirteen orphans']);

  let best: MjScore | null = null;
  for (const shape of shapes(c, 4 - w.melds.length)) {
    // Off a discard, the Pung the winning tile finished counts as taken (unless it made the pair).
    const sets = [...shape.sets.map((s) => ({ ...s })), ...exposedSets];
    if (!w.selfDrawn && shape.pair !== winIdx) {
      const p = shape.sets.findIndex((s) => s.kind === 'pung' && s.tile === winIdx);
      const chow = shape.sets.some((s) => s.kind === 'chow' && winIdx >= s.tile && winIdx <= s.tile + 2);
      if (p >= 0 && !chow) sets[p].concealed = false;
    }
    const score = scoreShape(w, shape.pair, sets, open, always);
    if (!best || score.faan > best.faan) best = score;
  }
  return best;
}

function scoreShape(w: MjWin, pair: number, sets: ShapeSet[], open: boolean, always: string[]): MjScore {
  const tiles: number[] = [pair, pair];
  for (const s of sets) {
    if (s.kind === 'chow') tiles.push(s.tile, s.tile + 1, s.tile + 2);
    else tiles.push(s.tile, s.tile, s.tile);
  }
  const pungs = sets.filter((s) => s.kind === 'pung');
  const limits = [...always];
  if (sets.every((s) => s.kong)) limits.push('All Kongs');
  if (pungs.length === 4 && pungs.every((s) => s.concealed)) limits.push('Four concealed Pungs');
  const windPungs = pungs.filter((s) => isWind(s.tile));
  if (windPungs.length === 4) limits.push('Big four winds');
  else if (windPungs.length === 3 && isWind(pair)) limits.push('Small four winds');
  if (tiles.every(honor)) limits.push('All honours');
  if (tiles.every(terminal)) limits.push('All terminals');
  if (!open && w.melds.length === 0 && nineGates(counts(w.concealed))) limits.push('Nine gates');
  if (limits.length) return limitScore(limits);

  const items: MjScoreItem[] = [];
  const add = (name: string, faan: number, why: string) => items.push({ name, faan, why });
  if (w.selfDrawn) add('Self-drawn', 1, 'You drew the winning tile yourself.');
  if (!open) add('Concealed hand', 1, 'No sets taken from anyone else’s discards.');
  items.push(...flowerItems(w.flowers, w.seatWind));
  if (w.lastTile) add('Last tile', 1, 'Won when the wall ran out: on its very last tile, or on the discard after it.');
  if (w.kongReplacement) add('Win on a Kong', 1, 'Won with the extra tile a Kong gave you.');
  if (w.robbedKong) add('Robbing a Kong', 1, 'Won on the tile someone added to make a Kong.');
  if (sets.every((s) => s.kind === 'chow')) add('All Chows', 1, 'Every set is a run.');
  if (pungs.length === 4) add('All Pungs', 3, 'Every set is three (or four) alike.');
  const suits = new Set(tiles.map(suitOf));
  const hasHonor = suits.has(3);
  suits.delete(3);
  if (suits.size === 1 && !hasHonor) add('Pure one suit', 7, 'Every tile is from one suit.');
  else if (suits.size === 1 && hasHonor) add('Mixed one suit', 3, 'One suit, plus winds and dragons.');
  if (tiles.every((i) => terminal(i) || honor(i))) add('Ends and honours', 1, 'Only 1s, 9s, winds and dragons.');
  const dragonPungs = pungs.filter((s) => isDragon(s.tile));
  if (dragonPungs.length === 3) add('Big three dragons', 8, 'A Pung of every dragon.');
  else {
    if (dragonPungs.length === 2 && isDragon(pair)) add('Small three dragons', 3, 'Pungs of two dragons and a pair of the third.');
    for (const s of dragonPungs) add('Dragon Pung', 1, `A Pung of ${['red', 'green', 'white'][s.tile - DRAGON0]} dragons.`);
  }
  for (const s of windPungs) {
    const wind = s.tile - WIND0;
    if (wind === w.seatWind) add('Your seat’s wind', 1, `A Pung of ${WIND_NAMES[wind]}, your seat.`);
    if (wind === w.prevailing) add('The table’s wind', 1, `A Pung of ${WIND_NAMES[wind]}, this round’s wind.`);
  }
  const sum = items.reduce((n, x) => n + x.faan, 0);
  if (sum > MJ_LIMIT) add('Over the limit', MJ_LIMIT - sum, `No hand counts for more than ${MJ_LIMIT} faan, so ${sum - MJ_LIMIT} of these don’t count.`);
  return { faan: Math.min(MJ_LIMIT, sum), items, limit: false };
}

function nineGates(c: number[]): boolean {
  for (const s of [0, 9, 18]) {
    const run = c.slice(s, s + 9);
    if (run.reduce((a, b) => a + b, 0) !== 14) continue;
    const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
    if (run.every((n, k) => n >= need[k])) return true;
  }
  return false;
}

// ------------------------------------------------------------------ a hand of play

export interface MjRules {
  /** Hong Kong faan and play points; off: any complete hand wins and the table counts wins. */
  points: boolean;
  /** With points: play all four winds' rounds, not just East. */
  full: boolean;
  /**
   * Learning Mode (user, 2026-11-24): every discard asks each person what they'd do with it, with
   * no time limit, and explains anything that can't be done. Always without points.
   */
  learning?: boolean;
}

/** After a discard: what someone can do with it. */
export interface MjOptions {
  win: boolean;
  kong: boolean;
  pung: boolean;
  /** Each Chow they could make, by its lowest tile. */
  chows: MjTile[];
}

export type MjClaimKind = 'win' | 'kong' | 'pung' | 'chow' | 'pass';

export interface MjClaim {
  t: MjClaimKind;
  /** A Chow: its lowest tile. */
  chow?: MjTile;
}

/**
 * Where the hand is: someone choosing a tile to throw away, everyone else looking at a discard
 * ("claim"), an added Kong that could be robbed ("rob"), or over.
 */
export type MjStep = 'discard' | 'claim' | 'rob' | 'done';

export interface MjDiscard {
  seat: number;
  tile: MjTile;
  /** Someone took it for a set. */
  taken: boolean;
}

export interface MjResult {
  /** Null: the wall ran out and nobody won. */
  winner: number | null;
  /** Whose discard (or added Kong) it was; null for self-drawn. */
  from: number | null;
  tile: MjTile | null;
  selfDrawn: boolean;
  /** Won by robbing a Kong. */
  robbed: boolean;
  /** With points: what it was worth. */
  score: MjScore | null;
  /** With points: what each seat gains (or pays, negative). */
  pay: number[];
}

const noOptions = (o: MjOptions) => !o.win && !o.kong && !o.pung && !o.chows.length;

export class MahjongHand {
  /** The live wall, in draw order: the next tile is at the front, replacements come off the back. */
  wall: MjTile[];
  /** Tiles taken off the front (the deal and draws) and the back (replacements), for drawing the wall. */
  front = 0;
  back = 0;
  readonly wallSize: number;
  hands: MjTile[][] = [[], [], [], []];
  melds: MjMeld[][] = [[], [], [], []];
  flowers: MjTile[][] = [[], [], [], []];
  /** Each seat's discards still on the table (one taken for a set leaves). */
  discards: MjTile[][] = [[], [], [], []];
  /** Every discard, in order (for "All discards"). */
  log: MjDiscard[] = [];
  turn: number;
  step: MjStep = 'discard';
  /** The tile the player whose turn it is just drew (shown as new). */
  drawn: MjTile | null = null;
  /** They took a tile from the wall this turn (so they may go Mahjong or declare a Kong). */
  justDrew = false;
  /** The tile they just drew was a Kong's replacement. */
  kongDraw = false;
  lastDiscard: { seat: number; tile: MjTile } | null = null;
  /** An added Kong waiting to see if anyone robs it. */
  robbing: { seat: number; tile: MjTile } | null = null;
  result: MjResult | null = null;
  /** How many tiles have been thrown away (heavenly and earthly hands need none, or one). */
  discardsMade = 0;
  /** Someone has taken a set: no heavenly or earthly hand after that. */
  claimed = false;
  /**
   * The player whose turn it is just took a discard for a Pung or Chow (whose, and which tile).
   * If that finished their hand they may still go Mahjong on it, as if they'd called Mahjong
   * for it in the first place (user, 2026-11-23: his wife called Pung on her winning tile).
   */
  justClaimed: { from: number; tile: MjTile } | null = null;

  constructor(
    readonly dealer: number,
    /** The table's (round's) wind, 0-3. */
    readonly prevailing: number,
    readonly rules: MjRules,
    randomInt: (n: number) => number,
    wall?: MjTile[],
  ) {
    this.wall = wall ? [...wall] : shuffled(mjTileSet(), randomInt);
    this.wallSize = this.wall.length;
    this.turn = dealer;
    for (let round = 0; round < 13; round++) for (let k = 0; k < 4; k++) this.hands[(dealer + k) % 4].push(this.takeFront()!);
    this.hands[dealer].push(this.takeFront()!);
    // Flowers go aside and are replaced, the dealer first.
    for (let k = 0; k < 4; k++) {
      const seat = (dealer + k) % 4;
      for (;;) {
        const f = this.hands[seat].find(isFlower);
        if (!f || !this.wall.length) break;
        removeTiles(this.hands[seat], [f]);
        this.flowers[seat].push(f);
        this.hands[seat].push(this.takeBack()!);
      }
    }
    this.justDrew = true;
  }

  seatWind(seat: number) {
    return (seat - this.dealer + 4) % 4;
  }

  private takeFront() {
    if (!this.wall.length) return undefined;
    this.front++;
    return this.wall.shift();
  }

  private takeBack() {
    if (!this.wall.length) return undefined;
    this.back++;
    return this.wall.pop();
  }

  /** Draw for a turn (from the back after a Kong), setting flowers aside. False: the wall is empty. */
  private drawFor(seat: number, fromBack: boolean): boolean {
    let t = fromBack ? this.takeBack() : this.takeFront();
    while (t && isFlower(t)) {
      this.flowers[seat].push(t);
      t = this.takeBack();
    }
    if (!t) {
      this.endDrawn();
      return false;
    }
    this.hands[seat].push(t);
    this.turn = seat;
    this.drawn = t;
    this.justDrew = true;
    this.justClaimed = null;
    this.kongDraw = fromBack;
    this.step = 'discard';
    return true;
  }

  private endDrawn() {
    this.step = 'done';
    this.drawn = null;
    this.lastDiscard = null;
    this.result = { winner: null, from: null, tile: null, selfDrawn: false, robbed: false, score: null, pay: [0, 0, 0, 0] };
  }

  /** What winning would be worth (with points) or a zero score (without), or null if it isn't a win. */
  winScore(seat: number, extra: MjTile | null, how: { robbed?: boolean; claimed?: boolean } = {}): MjScore | null {
    let concealed = extra ? [...this.hands[seat], extra] : [...this.hands[seat]];
    let melds = this.melds[seat];
    // Going out on a discard just taken for a set: scored as a win on that discard, with the set's
    // tiles back in the hand.
    const claim = how.claimed ? this.justClaimed : null;
    if (claim) {
      concealed = [...this.hands[seat], ...melds[melds.length - 1].tiles];
      melds = melds.slice(0, -1);
    }
    if (!this.rules.points) return mjIsComplete(concealed, melds) ? { faan: 0, items: [], limit: false } : null;
    const selfDrawn = !extra && !claim;
    const firstGo = !this.claimed;
    const score = mjScore({
      concealed,
      melds,
      flowers: this.flowers[seat],
      winTile: extra ?? claim?.tile ?? this.drawn ?? concealed[concealed.length - 1],
      selfDrawn,
      seatWind: this.seatWind(seat),
      prevailing: this.prevailing,
      lastTile: this.wall.length === 0,
      kongReplacement: selfDrawn && this.kongDraw,
      robbedKong: !!how.robbed,
      heavenly: selfDrawn && firstGo && seat === this.dealer && this.discardsMade === 0,
      earthly: !selfDrawn && firstGo && !how.robbed && this.discardsMade === 1 && this.lastDiscard?.seat === this.dealer,
    });
    return score && score.faan >= MJ_MIN_FAAN ? score : null;
  }

  /** On your own turn, before throwing away: can you go Mahjong, and which Kongs can you declare? */
  selfOptions(seat: number): { win: boolean; kongs: MjTile[] } | null {
    if (this.step !== 'discard' || this.turn !== seat) return null;
    const win = (this.justDrew && !!this.winScore(seat, null)) || (!!this.justClaimed && !!this.winScore(seat, null, { claimed: true }));
    const kongs: MjTile[] = [];
    if (this.justDrew && this.wall.length) {
      const hand = this.hands[seat];
      for (const t of new Set(hand)) if (countOf(hand, t) === 4) kongs.push(t);
      for (const m of this.melds[seat]) if (m.kind === 'pung' && hand.includes(m.tiles[0])) kongs.push(m.tiles[0]);
    }
    return { win, kongs: mjSort(kongs) };
  }

  /** While a discard (or an added Kong) is on offer: what this seat could do with it. */
  options(seat: number): MjOptions {
    const none: MjOptions = { win: false, kong: false, pung: false, chows: [] };
    if (this.step === 'rob' && this.robbing && seat !== this.robbing.seat) {
      return { ...none, win: !!this.winScore(seat, this.robbing.tile, { robbed: true }) };
    }
    const d = this.lastDiscard;
    if (this.step !== 'claim' || !d || seat === d.seat) return none;
    const hand = this.hands[seat];
    const n = countOf(hand, d.tile);
    const win = !!this.winScore(seat, d.tile);
    // With the wall empty there's nothing to carry on with: only Mahjong.
    if (!this.wall.length) return { ...none, win };
    const chows: MjTile[] = [];
    const i = mjIndex(d.tile);
    if (seat === (d.seat + 1) % 4 && suited(i)) {
      for (let lo = i - 2; lo <= i; lo++) {
        if (lo < 0 || Math.floor(lo / 9) !== Math.floor(i / 9) || lo % 9 > 6) continue;
        const others = [lo, lo + 1, lo + 2].filter((k) => k !== i).map((k) => MJ_KINDS[k]);
        if (others.every((t) => hand.includes(t))) chows.push(MJ_KINDS[lo]);
      }
    }
    return { win, kong: n >= 3, pung: n >= 2, chows };
  }

  /** Seats that can do anything with what's on offer. */
  claimants(): number[] {
    return [0, 1, 2, 3].filter((s) => !noOptions(this.options(s)));
  }

  discard(seat: number, tile: MjTile): boolean {
    if (this.step !== 'discard' || this.turn !== seat || !this.hands[seat].includes(tile)) return false;
    removeTiles(this.hands[seat], [tile]);
    this.discards[seat].push(tile);
    this.log.push({ seat, tile, taken: false });
    this.lastDiscard = { seat, tile };
    this.discardsMade++;
    this.drawn = null;
    this.justDrew = false;
    this.justClaimed = null;
    this.kongDraw = false;
    this.step = 'claim';
    return true;
  }

  /** Go Mahjong on a tile you drew (or on the discard you've just taken for a set). */
  declareWin(seat: number): boolean {
    if (!this.selfOptions(seat)?.win) return false;
    const claim = this.justDrew ? null : this.justClaimed;
    const score = this.winScore(seat, null, { claimed: !!claim });
    if (!score) return false;
    if (claim) {
      // The set goes back into the hand: it was the winning tile all along.
      const m = this.melds[seat].pop()!;
      this.hands[seat].push(...m.tiles);
      this.finishWin(seat, claim.from, claim.tile, score);
      return true;
    }
    this.finishWin(seat, null, this.drawn, score);
    return true;
  }

  /** Declare a Kong on your turn: four alike from your hand, or the fourth added to a Pung. */
  declareKong(seat: number, tile: MjTile): boolean {
    if (!this.selfOptions(seat)?.kongs.includes(tile)) return false;
    const hand = this.hands[seat];
    const pung = this.melds[seat].find((m) => m.kind === 'pung' && m.tiles[0] === tile);
    if (pung) {
      removeTiles(hand, [tile]);
      pung.kind = 'kong';
      pung.tiles.push(tile);
      // Anyone who could win on that tile may rob it first.
      this.robbing = { seat, tile };
      this.step = 'rob';
      this.drawn = null;
      this.justDrew = false;
      return true;
    }
    removeTiles(hand, [tile, tile, tile, tile]);
    this.melds[seat].push({ kind: 'kong', tiles: [tile, tile, tile, tile], from: null, concealed: true });
    this.claimed = true;
    this.drawFor(seat, true);
    return true;
  }

  /**
   * Everyone has answered (or run out of time) on the discard or added Kong on offer: Mahjong
   * first (the nearest in turn after whoever offered it), then Pung or Kong, then Chow; with
   * nobody taking it, play moves on.
   */
  resolve(claims: (MjClaim | null)[]) {
    const robbing = this.step === 'rob' ? this.robbing : null;
    const offer = robbing ?? (this.step === 'claim' ? this.lastDiscard : null);
    if (!offer) return;
    const order = [1, 2, 3].map((k) => (offer.seat + k) % 4);
    const valid = (s: number, t: MjClaimKind) => {
      const c = claims[s];
      if (!c || c.t !== t) return false;
      const o = this.options(s);
      if (t === 'win') return o.win;
      if (t === 'kong') return o.kong;
      if (t === 'pung') return o.pung;
      if (t === 'chow') return !!c.chow && o.chows.includes(c.chow);
      return false;
    };
    const winner = order.find((s) => valid(s, 'win'));
    if (winner !== undefined) {
      const score = this.winScore(winner, offer.tile, { robbed: !!robbing })!;
      if (robbing) {
        // The Kong goes back to a Pung: its fourth tile is the winner's.
        const m = this.melds[robbing.seat].find((x) => x.kind === 'kong' && x.tiles[0] === robbing.tile && !x.concealed)!;
        m.kind = 'pung';
        m.tiles.pop();
      } else this.takeDiscard();
      this.hands[winner].push(offer.tile);
      this.finishWin(winner, offer.seat, offer.tile, score, !!robbing);
      return;
    }
    if (robbing) {
      this.robbing = null;
      this.claimed = true;
      this.drawFor(robbing.seat, true);
      return;
    }
    const t = offer.tile;
    const taker = order.find((s) => valid(s, 'kong') || valid(s, 'pung'));
    if (taker !== undefined) {
      const kong = valid(taker, 'kong');
      removeTiles(this.hands[taker], kong ? [t, t, t] : [t, t]);
      this.takeDiscard();
      this.melds[taker].push({ kind: kong ? 'kong' : 'pung', tiles: kong ? [t, t, t, t] : [t, t, t], from: offer.seat, concealed: false });
      this.afterClaim(taker, offer.seat, t);
      if (kong) this.drawFor(taker, true);
      return;
    }
    const next = (offer.seat + 1) % 4;
    if (valid(next, 'chow')) {
      const lo = mjIndex(claims[next]!.chow!);
      const run = [lo, lo + 1, lo + 2].map((k) => MJ_KINDS[k]);
      const mine = [...run];
      mine.splice(mine.indexOf(t), 1);
      removeTiles(this.hands[next], mine);
      this.takeDiscard();
      this.melds[next].push({ kind: 'chow', tiles: run, from: offer.seat, concealed: false });
      this.afterClaim(next, offer.seat, t);
      return;
    }
    this.lastDiscard = null;
    this.drawFor(next, false);
  }

  private takeDiscard() {
    const d = this.lastDiscard!;
    this.discards[d.seat].pop();
    this.log[this.log.length - 1].taken = true;
  }

  private afterClaim(seat: number, from: number, tile: MjTile) {
    this.claimed = true;
    this.justClaimed = { from, tile };
    this.lastDiscard = null;
    this.turn = seat;
    this.drawn = null;
    this.justDrew = false;
    this.kongDraw = false;
    this.step = 'discard';
  }

  private finishWin(winner: number, from: number | null, tile: MjTile | null, score: MjScore, robbed = false) {
    const pay = [0, 0, 0, 0];
    if (this.rules.points) {
      const base = MJ_FAAN_POINTS[Math.min(MJ_LIMIT, score.faan)];
      if (from === null) {
        // Self-drawn: the other three each pay half.
        for (let s = 0; s < 4; s++) if (s !== winner) (pay[s] -= base / 2), (pay[winner] += base / 2);
      } else {
        pay[from] -= base;
        pay[winner] += base;
      }
    }
    this.step = 'done';
    this.robbing = null;
    this.lastDiscard = null;
    this.result = { winner, from, tile, selfDrawn: from === null, robbed, score: this.rules.points ? score : null, pay };
  }
}

// ------------------------------------------------------------------ the computer player

/**
 * How far a hand is from complete: -1 complete, 0 one tile away ("ready"), and so on. Ordinary
 * hands only (four sets and a pair).
 */
export function mjShanten(tiles: readonly MjTile[], meldCount: number): number {
  const c = counts(tiles);
  // Each suit (and each wind or dragon) on its own: the ways it splits into sets, partial sets and
  // a pair. Then the best mix across them all.
  let states = new Set<number>([pack(0, 0, 0)]);
  const groups: number[][] = [0, 9, 18].map((s) => suitSplits(c.slice(s, s + 9)));
  for (let i = 27; i < PLAY_KINDS; i++) if (c[i]) groups.push(honorSplits(c[i]));
  for (const options of groups) {
    const next = new Set<number>();
    for (const s of states) {
      const [m, t, p] = unpack(s);
      for (const o of options) {
        const [m2, t2, p2] = unpack(o);
        if (p && p2) continue;
        next.add(pack(Math.min(4, m + m2), Math.min(8, t + t2), p | p2));
      }
    }
    states = next;
  }
  let best = 8;
  for (const s of states) {
    const [m0, t, p] = unpack(s);
    const m = Math.min(4, m0 + meldCount);
    best = Math.min(best, 8 - 2 * m - Math.min(t, 4 - m) - p);
  }
  return best;
}

const pack = (m: number, t: number, p: number) => m * 100 + t * 10 + p;
const unpack = (v: number) => [Math.floor(v / 100), Math.floor(v / 10) % 10, v % 10];

const honorSplits = (n: number): number[] => (n >= 3 ? [pack(1, 0, 0), pack(0, 0, 1)] : n === 2 ? [pack(0, 1, 0), pack(0, 0, 1)] : [pack(0, 0, 0)]);

const SUIT_CACHE = new Map<string, number[]>();

/** Every (sets, partial sets, pair) one suit's counts can make, kept to the useful ones. */
function suitSplits(c: number[]): number[] {
  const key = c.join('');
  const hit = SUIT_CACHE.get(key);
  if (hit) return hit;
  const found = new Set<number>();
  const rec = (i: number, m: number, t: number, p: number) => {
    while (i < 9 && c[i] === 0) i++;
    if (i >= 9) {
      found.add(pack(Math.min(m, 4), Math.min(t, 8), p));
      return;
    }
    if (!p && c[i] >= 2) {
      c[i] -= 2;
      rec(i, m, t, 1);
      c[i] += 2;
    }
    if (c[i] >= 3) {
      c[i] -= 3;
      rec(i, m + 1, t, p);
      c[i] += 3;
    }
    if (i <= 6 && c[i + 1] && c[i + 2]) {
      c[i]--, c[i + 1]--, c[i + 2]--;
      rec(i, m + 1, t, p);
      c[i]++, c[i + 1]++, c[i + 2]++;
    }
    if (c[i] >= 2) {
      c[i] -= 2;
      rec(i, m, t + 1, p);
      c[i] += 2;
    }
    if (i <= 7 && c[i + 1]) {
      c[i]--, c[i + 1]--;
      rec(i, m, t + 1, p);
      c[i]++, c[i + 1]++;
    }
    if (i <= 6 && c[i + 2]) {
      c[i]--, c[i + 2]--;
      rec(i, m, t + 1, p);
      c[i]++, c[i + 2]++;
    }
    c[i]--;
    rec(i, m, t, p);
    c[i]++;
  };
  rec(0, 0, 0, 0);
  // Drop any split another beats on every count.
  const all = [...found].map(unpack);
  const keep = all.filter((a) => !all.some((b) => b !== a && b[0] >= a[0] && b[1] >= a[1] && b[2] >= a[2] && (b[0] > a[0] || b[1] > a[1] || b[2] > a[2]))).map(([m, t, p]) => pack(m, t, p));
  if (SUIT_CACHE.size > 50_000) SUIT_CACHE.clear();
  SUIT_CACHE.set(key, keep);
  return keep;
}

/** How many of each kind this seat hasn't seen (not in its hand, on the table or in anyone's sets). */
function unseen(h: MahjongHand, seat: number): number[] {
  const c = new Array<number>(PLAY_KINDS).fill(4);
  const see = (t: MjTile) => {
    const i = mjIndex(t);
    if (i < PLAY_KINDS) c[i] = Math.max(0, c[i] - 1);
  };
  h.hands[seat].forEach(see);
  for (const d of h.discards) d.forEach(see);
  for (const ms of h.melds) for (const m of ms) m.tiles.forEach(see);
  return c;
}

/** Tiles worth points to this seat: dragons, its own wind and the table's. */
function valuable(h: MahjongHand, seat: number, i: number) {
  return isDragon(i) || i === WIND0 + h.seatWind(seat) || i === WIND0 + h.prevailing;
}

/**
 * With points, a computer leans towards one suit once most of its tiles are in it, sooner once
 * it has taken a set (an open hand has lost Concealed, and one suit is its likeliest way to score).
 */
function leanSuit(h: MahjongHand, seat: number): number | null {
  if (!h.rules.points) return null;
  const all = [...h.hands[seat], ...h.melds[seat].flatMap((m) => m.tiles)].map(mjIndex).filter(suited);
  const per = [0, 1, 2].map((s) => all.filter((i) => suitOf(i) === s).length);
  const top = per.indexOf(Math.max(...per));
  const chowElsewhere = h.melds[seat].some((m) => suitOf(mjIndex(m.tiles[0])) !== top && suited(mjIndex(m.tiles[0])));
  const open = h.melds[seat].some((m) => !m.concealed);
  return per[top] >= (open ? 6 : 8) && !chowElsewhere ? top : null;
}

/** With points: what a Pung of this wind or dragon is worth to this seat. */
function honourFaan(h: MahjongHand, seat: number, i: number) {
  return (isDragon(i) ? 1 : 0) + (i === WIND0 + h.seatWind(seat) ? 1 : 0) + (i === WIND0 + h.prevailing ? 1 : 0);
}

/**
 * With points: roughly how many faan a hand (its own tiles and its sets) can count on whatever it
 * wins on, before Self-drawn: what's banked (flowers, Concealed, valuable Pungs) plus what it's well
 * on the way to (a valuable pair, one suit, all Pungs). Under MJ_MIN_FAAN, opening the hand up
 * leaves it nothing to win with.
 */
function route(h: MahjongHand, seat: number, tiles: readonly MjTile[], melds: readonly MjMeld[], left: number[]): number {
  const c = counts(tiles);
  const at = melds.map((m) => mjIndex(m.tiles[0]));
  let f = flowerItems(h.flowers[seat], h.seatWind(seat)).length + (melds.every((m) => m.concealed) ? 1 : 0);
  for (let i = WIND0; i < PLAY_KINDS; i++) {
    const v = honourFaan(h, seat, i);
    if (at.includes(i) || c[i] >= 3) f += v;
    else if (c[i] === 2 && left[i]) f += v / 2;
  }
  // One suit: nothing in another suit, or little enough in the hand to throw away.
  const per = [0, 1, 2].map((s) => c.slice(s * 9, s * 9 + 9).reduce((a, b) => a + b, 0));
  for (const i of at) if (suited(i)) per[suitOf(i)] += 3;
  const top = per.indexOf(Math.max(...per));
  const off = per[0] + per[1] + per[2] - per[top];
  if (!at.some((i) => suited(i) && suitOf(i) !== top)) f += off === 0 ? 3 : off <= 3 ? 1.5 : 0;
  // All Pungs: no Chows, and enough Pungs and pairs that can still become them.
  if (melds.every((m) => m.kind !== 'chow')) {
    let sets = melds.length;
    let pairs = 0;
    for (let i = 0; i < PLAY_KINDS; i++) {
      if (c[i] >= 3) sets++;
      else if (c[i] === 2 && left[i]) pairs++;
    }
    if (sets + pairs >= 5) f += sets >= 3 ? 3 : 2;
  }
  return f;
}

/**
 * With points: how much each tile that would finish a ready hand is worth waiting for: 4 if it
 * can win on anyone's discard, 1 if only drawn yourself (Self-drawn adds the one faan it's
 * short), 0 if it can't reach MJ_MIN_FAAN at all.
 */
function winValue(h: MahjongHand, seat: number, melds: MjMeld[]) {
  const seatWind = h.seatWind(seat);
  const base = { melds, flowers: h.flowers[seat], selfDrawn: false, seatWind, prevailing: h.prevailing, lastTile: false, kongReplacement: false, robbedKong: false, heavenly: false, earthly: false };
  return (concealed: MjTile[], winTile: MjTile) => {
    // Off a discard (Self-drawn would add one).
    const faan = mjScore({ ...base, concealed, winTile })?.faan ?? 0;
    return faan >= MJ_MIN_FAAN ? 4 : faan === MJ_MIN_FAAN - 1 ? 1 : 0;
  };
}

/**
 * Shanten and how many unseen tiles would improve it, for a 13-tile (or fewer) hand. With points
 * (`value`), a ready hand's waits count by what they'd score, and a ready hand that can't win on
 * any of them is no nearer than one a tile off ready.
 */
function quality(tiles: MjTile[], meldCount: number, left: number[], value?: (concealed: MjTile[], winTile: MjTile) => number): { s: number; waits: number } {
  const s = mjShanten(tiles, meldCount);
  const c = counts(tiles);
  // A tile with nothing of its own kind, or within two in its suit, can't help: skip it.
  const near = (k: number) => (suited(k) ? [-2, -1, 0, 1, 2].some((d) => suitOf(k + d) === suitOf(k) && c[k + d] > 0) : c[k] > 0);
  let waits = 0;
  for (let k = 0; k < PLAY_KINDS; k++) {
    if (!left[k] || !near(k)) continue;
    const more = [...tiles, MJ_KINDS[k]];
    if (mjShanten(more, meldCount) < s) waits += left[k] * (s === 0 && value ? value(more, MJ_KINDS[k]) : 1);
  }
  if (s === 0 && value && !waits) return { s: 1, waits: 0 };
  return { s, waits };
}

/** The computer's throw-away: what keeps its hand closest to complete, with the most ways in. */
export function mjBotDiscard(h: MahjongHand, seat: number): MjTile {
  const hand = h.hands[seat];
  const left = unseen(h, seat);
  const lean = leanSuit(h, seat);
  const melds = h.melds[seat].length;
  const value = h.rules.points ? winValue(h, seat, h.melds[seat]) : undefined;
  let best: MjTile = hand[hand.length - 1];
  let bestScore = -Infinity;
  for (const t of new Set(hand)) {
    const rest = [...hand];
    rest.splice(rest.indexOf(t), 1);
    const q = quality(rest, melds, left, value);
    const i = mjIndex(t);
    let score = -q.s * 1000 + q.waits;
    // Loose winds and dragons that score nothing go first; ones that score are kept a while.
    if (honor(i)) score += valuable(h, seat, i) && h.rules.points ? -3 : 2;
    else if (terminal(i)) score += 1;
    if (lean !== null && suited(i) && suitOf(i) !== lean) score += 40;
    if (lean !== null && suitOf(i) === lean) score -= 40;
    // With points, while it isn't ready: keep what scores (a valuable pair, one suit, all Pungs).
    if (value && q.s > 0) score += 20 * Math.min(MJ_MIN_FAAN, route(h, seat, rest, h.melds[seat], left));
    if (score > bestScore) (bestScore = score), (best = t);
  }
  return best;
}

/** On its own turn: go Mahjong if it can, declare a Kong that costs nothing, or throw a tile away. */
export function mjBotTurn(h: MahjongHand, seat: number): { t: 'win' } | { t: 'kong'; tile: MjTile } | { t: 'discard'; tile: MjTile } {
  const o = h.selfOptions(seat);
  if (o?.win) return { t: 'win' };
  for (const k of o?.kongs ?? []) {
    const added = h.melds[seat].some((m) => m.kind === 'pung' && m.tiles[0] === k);
    if (added) return { t: 'kong', tile: k };
    // A Kong from its own hand, if the four aren't better used in runs.
    const rest = h.hands[seat].filter((x) => x !== k);
    const keep = [...h.hands[seat]];
    keep.splice(keep.indexOf(k), 1);
    const i = mjIndex(k);
    if (!suited(i) || terminal(i) || mjShanten(rest, h.melds[seat].length + 1) <= mjShanten(keep, h.melds[seat].length)) return { t: 'kong', tile: k };
  }
  return { t: 'discard', tile: mjBotDiscard(h, seat) };
}

/** What the computer does with a discard (or an added Kong) on offer. */
export function mjBotClaim(h: MahjongHand, seat: number): MjClaim {
  const o = h.options(seat);
  if (o.win) return { t: 'win' };
  if (h.step !== 'claim' || !h.lastDiscard) return { t: 'pass' };
  const t = h.lastDiscard.tile;
  const i = mjIndex(t);
  const hand = h.hands[seat];
  const melds = h.melds[seat].length;
  const lean = leanSuit(h, seat);
  const points = h.rules.points;
  const left = points ? unseen(h, seat) : [];
  const taken = (kind: MjMeldKind, tiles: MjTile[]): MjMeld[] => [...h.melds[seat], { kind, tiles, from: h.lastDiscard!.seat, concealed: false }];
  // After taking it and throwing the best tile away, is the hand closer to complete? With points,
  // closer to a win: the set opens the hand (no more Concealed), so it must leave a way to
  // MJ_MIN_FAAN, or a ready hand with a winning tile that scores enough.
  const after = (remove: MjTile[], ms: MjMeld[]) => {
    const rest = [...hand];
    removeTiles(rest, remove);
    const value = points ? winValue(h, seat, ms) : undefined;
    let s = Infinity;
    for (const d of new Set(rest)) {
      const r = [...rest];
      r.splice(r.indexOf(d), 1);
      let k = mjShanten(r, melds + 1);
      if (k === 0 && value) k = quality(r, melds + 1, left, value).s;
      s = Math.min(s, k);
      if (s <= 0) break;
    }
    if (points && s > 0 && route(h, seat, rest, ms, left) < MJ_MIN_FAAN) return Infinity;
    return s;
  };
  let current = mjShanten(hand, melds);
  if (points && current === 0) current = quality(hand, melds, left, winValue(h, seat, h.melds[seat])).s;
  const kongRest = hand.filter((x) => x !== t);
  if (o.kong && mjShanten(kongRest, melds + 1) <= current) {
    if (!points || valuable(h, seat, i) || route(h, seat, kongRest, taken('kong', [t, t, t, t]), left) >= MJ_MIN_FAAN) return { t: 'kong' };
  }
  if (o.pung) {
    if (points && valuable(h, seat, i)) return { t: 'pung' };
    if (lean === null || suitOf(i) === lean || honor(i)) if (after([t, t], taken('pung', [t, t, t])) < current) return { t: 'pung' };
  }
  for (const lo of o.chows) {
    if (lean !== null && suitOf(i) !== lean) break;
    const run = [0, 1, 2].map((k) => MJ_KINDS[mjIndex(lo) + k]);
    const mine = run.filter((x) => x !== t);
    if (after(mine, taken('chow', run)) < current) return { t: 'chow', chow: lo };
  }
  return { t: 'pass' };
}

// ------------------------------------------------------------------ what a player sees

export interface MjSeatView {
  name: string;
  alias: string | null;
  color: number;
  bot: boolean;
  away: boolean;
  /** 0-3: East, South, West, North. */
  wind: number;
  /** Tiles in their hand (face down to everyone else). */
  tiles: number;
  melds: MjMeld[];
  flowers: MjTile[];
  /** Their discards still on the table, oldest first. */
  discards: MjTile[];
  /** With points: their total. Without: hands won. */
  score: number;
  wins: number;
}

export type MjPhase = 'opening' | 'playing' | 'handEnd' | 'gameOver';
/** The opening: shuffling and building the wall, the dealer rolling the dice, then the deal. */
export type MjOpening = 'shuffle' | 'dice' | 'deal';

export interface MahjongView {
  /** Your seat (null: watching). */
  seat: number | null;
  phase: MjPhase;
  opening: MjOpening | null;
  /** The dealer's three dice, once rolled. */
  dice: number[] | null;
  /** Hand number, from 1. */
  hand: number;
  rules: MjRules;
  minFaan: number;
  /** The round's wind, 0-3. */
  prevailing: number;
  dealer: number;
  seats: MjSeatView[];
  /** Your own tiles. */
  tiles: MjTile[];
  /** The tile you just drew. */
  drawn: MjTile | null;
  /**
   * It's your turn after taking a tile from the wall (not one claimed for a set). The dealer's
   * first turn counts, though `drawn` is null then. (Optional: a server from before 2026-11-26.)
   */
  drew?: boolean;
  turn: number | null;
  step: MjStep | null;
  /** The discard (or added Kong) on offer right now. */
  offer: { seat: number; tile: MjTile; kong: boolean } | null;
  /** What you can do with it (null: nothing, or it isn't on offer). */
  options: MjOptions | null;
  /** You've answered this offer. */
  answered: MjClaimKind | null;
  /** Milliseconds left to answer, when you can. */
  claimMs: number | null;
  /** On your turn: Mahjong and Kongs you could declare. */
  self: { win: boolean; kongs: MjTile[] } | null;
  wall: { size: number; left: number; front: number; back: number; breakAt: number };
  log: MjDiscard[];
  result: (MjResult & { hands: MjTile[][] }) | null;
  /** Everyone's total after each hand. */
  history: number[][];
  ready: number[];
  winners: number[];
  /** The game ends after this many deals pass (points only; 0 never ends). */
  rounds: number;
}
