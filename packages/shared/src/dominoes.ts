/**
 * Dominoes, the "All Fives" game: rules, scoring and bots. Pure and deterministic given the
 * deal, so the server runs it and tests can replay whole games.
 *
 * House rules live in DOMINOES_RULES below. The rest:
 * - Double-six set (28 tiles). Each player draws `tilesEach`; any left over are the boneyard.
 *   The family game deals all 28 (7 each, 4 players), so there's no boneyard.
 * - First hand: whoever holds the highest double leads it (the heaviest tile if nobody has a
 *   double). Later hands: the last hand's winner leads anything.
 * - The first double played is the spinner: once both of its sides have tiles, play can also
 *   go off its other two sides.
 * - After every play, if the open ends add up to a multiple of 5, the player scores that many.
 *   A double at an end counts both halves; the spinner counts double until both sides are played.
 * - Can't play? Draw from the boneyard until you can; with no boneyard (or it's empty), pass.
 * - Play your last tile and you score everyone else's leftover pips, rounded to the nearest 5.
 *   If nobody can play (blocked), the lowest hand scores the others' pips the same way.
 * - First to `target` wins, even in the middle of a hand.
 */

export const DOMINOES_RULES = {
  /** Tiles each player draws at the start of a hand. 7 each with 4 players deals all 28. */
  tilesEach: 7,
  /** Points to win. */
  target: 250,
};

/** A tile is "a-b" with a <= b, e.g. "3-5" or "6-6". */
export type TileId = string;

export function tileId(a: number, b: number): TileId {
  return a <= b ? `${a}-${b}` : `${b}-${a}`;
}

export function pipsOf(t: TileId): [number, number] {
  return [Number(t[0]), Number(t[2])];
}

export function isTileId(v: unknown): v is TileId {
  return typeof v === 'string' && /^[0-6]-[0-6]$/.test(v) && Number(v[0]) <= Number(v[2]);
}

export const isDouble = (t: TileId) => t[0] === t[2];
export const tileWeight = (t: TileId) => Number(t[0]) + Number(t[2]);

export function fullSet(): TileId[] {
  const set: TileId[] = [];
  for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) set.push(tileId(a, b));
  return set;
}

/** Round to the nearest 5 (12 -> 10, 13 -> 15). */
export const roundToFive = (n: number) => Math.round(n / 5) * 5;

// ------------------------------------------------------------------ the layout on the table

export interface Placed {
  tile: TileId;
  /** The pip touching the tile it was played against. */
  inner: number;
  /** The pip facing outward (the open end, if it's the last tile of its line). */
  outer: number;
  seat: number;
}

/**
 * A line of tiles growing outward. The first tile on the table has lines 'e' and 'w' (and
 * 'n', 's' if it's the spinner); a spinner played later grows two side lines named
 * `<line>+` and `<line>-`.
 */
export interface Arm {
  id: string;
  /** Where it starts: the first tile, or a tile in another line (a later spinner). */
  from: 'root' | { arm: string; index: number };
  tiles: Placed[];
}

export interface Layout {
  root: Placed | null;
  arms: Arm[];
  /** The spinner: the first tile ('root') or a tile in a line. */
  spinner: 'root' | { arm: string; index: number } | null;
}

export const emptyLayout = (): Layout => ({ root: null, arms: [], spinner: null });

export interface Move {
  tile: TileId;
  /** Which line to play on (any line works for the very first tile; it's ignored). */
  arm: string;
}

function armById(l: Layout, id: string) {
  return l.arms.find((a) => a.id === id);
}

/** The pip a line's next tile must match. */
function needs(l: Layout, arm: Arm): number {
  if (arm.tiles.length) return arm.tiles.at(-1)!.outer;
  if (arm.from === 'root') {
    const r = l.root!;
    if (r.inner === r.outer) return r.inner;
    return arm.id === 'w' ? r.inner : r.outer;
  }
  const parent = armById(l, arm.from.arm)!;
  return parent.tiles[arm.from.index].outer;
}

/** A spinner's extra sides open once both of its main sides have tiles. */
function armOpen(l: Layout, arm: Arm): boolean {
  if (arm.from === 'root') {
    if (arm.id === 'e' || arm.id === 'w') return true;
    return !!armById(l, 'e')?.tiles.length && !!armById(l, 'w')?.tiles.length;
  }
  const parent = armById(l, arm.from.arm)!;
  return parent.tiles.length > arm.from.index + 1;
}

/** Lines a tile could go on now, with the pip each needs. */
export function openEnds(l: Layout): { arm: string; needs: number }[] {
  if (!l.root) return [];
  return l.arms.filter((a) => armOpen(l, a)).map((a) => ({ arm: a.id, needs: needs(l, a) }));
}

const endValue = (p: Placed) => (p.inner === p.outer ? p.outer * 2 : p.outer);

/** What the open ends add up to (scored when it's a multiple of 5). */
export function endCount(l: Layout): number {
  const r = l.root;
  if (!r) return 0;
  let sum = 0;
  const e = armById(l, 'e')!;
  const w = armById(l, 'w')!;
  if (l.spinner === 'root') {
    // The spinner counts as one double end while either main side is still empty.
    if (!e.tiles.length && !w.tiles.length) sum += r.outer * 2;
    else for (const a of [e, w]) sum += a.tiles.length ? endValue(a.tiles.at(-1)!) : r.outer * 2;
  } else {
    for (const a of [e, w]) sum += a.tiles.length ? endValue(a.tiles.at(-1)!) : a.id === 'w' ? r.inner : r.outer;
  }
  // Other lines (the spinner's extra sides) count once they have tiles.
  for (const a of l.arms) if (a.id !== 'e' && a.id !== 'w' && a.tiles.length) sum += endValue(a.tiles.at(-1)!);
  return sum;
}

/** Points for a count: the count itself if it's a (non-zero) multiple of 5. */
export const pointsFor = (count: number) => (count > 0 && count % 5 === 0 ? count : 0);

/** Put a tile down. Returns false if it doesn't fit there. */
export function place(l: Layout, tile: TileId, armId: string, seat: number): boolean {
  const [a, b] = pipsOf(tile);
  if (!l.root) {
    // First tile: low pip on the west, high on the east.
    l.root = { tile, inner: a, outer: b, seat };
    l.arms = [
      { id: 'e', from: 'root', tiles: [] },
      { id: 'w', from: 'root', tiles: [] },
    ];
    if (a === b) {
      l.spinner = 'root';
      l.arms.push({ id: 'n', from: 'root', tiles: [] }, { id: 's', from: 'root', tiles: [] });
    }
    return true;
  }
  const arm = armById(l, armId);
  if (!arm || !armOpen(l, arm)) return false;
  const want = needs(l, arm);
  if (a !== want && b !== want) return false;
  const outer = a === want ? b : a;
  arm.tiles.push({ tile, inner: want, outer, seat });
  if (a === b && l.spinner === null) {
    const index = arm.tiles.length - 1;
    l.spinner = { arm: arm.id, index };
    l.arms.push({ id: `${arm.id}+`, from: { arm: arm.id, index }, tiles: [] }, { id: `${arm.id}-`, from: { arm: arm.id, index }, tiles: [] });
  }
  return true;
}

export function cloneLayout(l: Layout): Layout {
  return {
    root: l.root ? { ...l.root } : null,
    arms: l.arms.map((a) => ({ id: a.id, from: a.from === 'root' ? 'root' : { ...a.from }, tiles: a.tiles.map((t) => ({ ...t })) })),
    spinner: l.spinner === null || l.spinner === 'root' ? l.spinner : { ...l.spinner },
  };
}

/** Every move a hand has on this layout. */
export function movesFor(l: Layout, hand: TileId[]): Move[] {
  if (!l.root) return hand.map((tile) => ({ tile, arm: 'e' }));
  const moves: Move[] = [];
  const ends = openEnds(l);
  for (const tile of hand) {
    const [a, b] = pipsOf(tile);
    const seen = new Set<string>();
    for (const end of ends) {
      if (a !== end.needs && b !== end.needs) continue;
      // An untouched spinner's sides are all alike: offer one.
      const key = `${end.needs}:${armById(l, end.arm)!.tiles.length === 0 && l.spinner === 'root' && end.arm !== 'n' && end.arm !== 's' ? 'root-side' : end.arm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      moves.push({ tile, arm: end.arm });
    }
  }
  return moves;
}

// ------------------------------------------------------------------ one hand

export interface DominoesHandResult {
  /** Who went out (or had the lowest hand when blocked); null for a blocked tie. */
  winner: number | null;
  blocked: boolean;
  /** Points the winner scored for the leftover pips. */
  points: number;
  /** Pips left in each hand. */
  pips: number[];
}

/** Shuffle and deal. `randomInt(n)` returns 0..n-1 (crypto on the server). */
export function dealDominoes(randomInt: (n: number) => number, players = 4, tilesEach = DOMINOES_RULES.tilesEach) {
  const set = fullSet();
  for (let i = set.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [set[i], set[j]] = [set[j], set[i]];
  }
  const hands = Array.from({ length: players }, (_, p) => set.slice(p * tilesEach, p * tilesEach + tilesEach));
  return { hands, boneyard: set.slice(players * tilesEach) };
}

/** The opening lead for a first hand: the highest double, or the heaviest tile. */
export function openingLead(hands: TileId[][]): { seat: number; tile: TileId } {
  let best: { seat: number; tile: TileId; rank: number } | null = null;
  hands.forEach((h, seat) => {
    for (const tile of h) {
      // Any double outranks every other tile; then by weight.
      const rank = isDouble(tile) ? 1000 + tileWeight(tile) : tileWeight(tile) * 10 + Number(tile[2]);
      if (!best || rank > best.rank) best = { seat, tile, rank };
    }
  });
  return best!;
}

export class DominoesRound {
  hands: TileId[][];
  boneyard: TileId[];
  layout: Layout = emptyLayout();
  turn: number;
  phase: 'playing' | 'done' = 'playing';
  /** The tile that must open the hand (first hand only). */
  mustLead: TileId | null;
  passesInRow = 0;
  lastPlay: { seat: number; tile: TileId; arm: string; points: number } | null = null;
  result: DominoesHandResult | null = null;

  constructor(dealt: { hands: TileId[][]; boneyard: TileId[] }, opts: { leader?: number }) {
    this.hands = dealt.hands.map((h) => [...h]);
    this.boneyard = [...dealt.boneyard];
    if (opts.leader === undefined) {
      const lead = openingLead(this.hands);
      this.turn = lead.seat;
      this.mustLead = lead.tile;
    } else {
      this.turn = opts.leader;
      this.mustLead = null;
    }
  }

  get players() {
    return this.hands.length;
  }

  /** Moves this seat can make now (empty if it isn't their turn). */
  moves(seat: number): Move[] {
    if (this.phase !== 'playing' || this.turn !== seat) return [];
    const all = movesFor(this.layout, this.hands[seat]);
    return this.mustLead ? all.filter((m) => m.tile === this.mustLead) : all;
  }

  /** Nothing fits, but there's something to draw. */
  mustDraw(seat: number) {
    return this.phase === 'playing' && this.turn === seat && this.moves(seat).length === 0 && this.boneyard.length > 0;
  }

  /** Nothing fits and the boneyard is empty. */
  mustPass(seat: number) {
    return this.phase === 'playing' && this.turn === seat && this.moves(seat).length === 0 && this.boneyard.length === 0;
  }

  /** Play a tile; returns the points it scored, or null if it isn't allowed. */
  play(seat: number, tile: TileId, arm: string): number | null {
    if (!this.moves(seat).some((m) => m.tile === tile && (!this.layout.root || m.arm === arm || this.sameSpot(m.arm, arm)))) return null;
    if (!place(this.layout, tile, arm, seat)) return null;
    this.hands[seat] = this.hands[seat].filter((t) => t !== tile);
    this.mustLead = null;
    this.passesInRow = 0;
    const points = pointsFor(endCount(this.layout));
    this.lastPlay = { seat, tile, arm, points };
    if (this.hands[seat].length === 0) this.finish(seat, false);
    else this.turn = (seat + 1) % this.players;
    return points;
  }

  /** The untouched spinner's two main sides are the same spot for choosing. */
  private sameSpot(a: string, b: string) {
    return this.layout.spinner === 'root' && (a === 'e' || a === 'w') && (b === 'e' || b === 'w') && !armById(this.layout, a)!.tiles.length && !armById(this.layout, b)!.tiles.length;
  }

  /** Take one tile from the boneyard (only when nothing fits). */
  draw(seat: number): TileId | null {
    if (!this.mustDraw(seat)) return null;
    const tile = this.boneyard.pop()!;
    this.hands[seat].push(tile);
    return tile;
  }

  /** Pass (only when nothing fits and the boneyard is empty). */
  pass(seat: number): boolean {
    if (!this.mustPass(seat)) return false;
    this.passesInRow++;
    if (this.passesInRow >= this.players) {
      const pips = this.pipsLeft();
      const low = Math.min(...pips);
      const lows = pips.flatMap((p, i) => (p === low ? [i] : []));
      this.finish(lows.length === 1 ? lows[0] : null, true);
    } else {
      this.turn = (seat + 1) % this.players;
    }
    return true;
  }

  pipsLeft() {
    return this.hands.map((h) => h.reduce((n, t) => n + tileWeight(t), 0));
  }

  private finish(winner: number | null, blocked: boolean) {
    const pips = this.pipsLeft();
    const others = winner === null ? 0 : pips.reduce((n, p, i) => (i === winner ? n : n + p), 0);
    this.result = { winner, blocked, points: winner === null ? 0 : roundToFive(others), pips };
    this.phase = 'done';
    this.turn = -1;
  }
}

// ------------------------------------------------------------------ bots

/**
 * A bot's move: take points when it can, otherwise get rid of heavy tiles (and doubles, which
 * are hard to place later), and avoid leaving the next player an easy score.
 */
export function dominoesBotMove(round: DominoesRound, seat: number, wobble: () => number = () => 0): Move | null {
  const moves = round.moves(seat);
  if (!moves.length) return null;
  let best: { m: Move; score: number } | null = null;
  for (const m of moves) {
    const l = cloneLayout(round.layout);
    place(l, m.tile, m.arm, seat);
    const points = pointsFor(endCount(l));
    // How easily could the next player score off this? Check every tile they might hold.
    // Roughly: covering an end showing n with a tile whose other half is p changes the count by p - n.
    let danger = 0;
    const count = endCount(l);
    for (const end of openEnds(l)) {
      for (let p = 0; p <= 6; p++) danger = Math.max(danger, pointsFor(count - end.needs + p));
    }
    const score = points * 10 + tileWeight(m.tile) * 1.5 + (isDouble(m.tile) ? 4 : 0) - danger * 0.6 + wobble();
    if (!best || score > best.score) best = { m, score };
  }
  return best!.m;
}

// ------------------------------------------------------------------ what each player sees

export interface DominoesSeatView {
  name: string;
  alias: string | null;
  color: number;
  bot: boolean;
  away: boolean;
  score: number;
  /** How many tiles they hold. */
  tiles: number;
}

export interface DominoesView {
  seat: number | null;
  phase: 'playing' | 'handEnd' | 'gameOver';
  hand: number;
  seats: DominoesSeatView[];
  layout: Layout;
  /** What the open ends add up to right now. */
  count: number;
  boneyard: number;
  /** Your tiles. */
  tiles: TileId[];
  /** Your moves, when it's your turn. */
  moves: Move[];
  mustDraw: boolean;
  turn: number | null;
  lastPlay: { seat: number; tile: TileId; arm: string; points: number } | null;
  result: DominoesHandResult | null;
  /** Everyone's score after each hand. */
  history: number[][];
  /** Between hands: the seats that are ready for the next one. */
  ready: number[];
  winners: number[];
  target: number;
}
