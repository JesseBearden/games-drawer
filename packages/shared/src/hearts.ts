/**
 * Hearts: rules, scoring and a simple bot. Pure and deterministic given the deal, so the
 * server runs it and tests can replay whole games.
 *
 * Rules used (the common "house" set):
 * - 4 players, 13 cards each. Before each hand pass 3 cards: left, right, across, then hold.
 * - The 2 of clubs leads the first trick. Follow suit if you can.
 * - No points (hearts or the queen of spades) on the first trick unless you have nothing else.
 * - Hearts can't be led until a heart has been played, unless you only have hearts.
 * - Each heart is 1 point, the queen of spades 13. Take all 26 ("shoot the moon") and everyone
 *   else gets 26 instead. The game ends when someone reaches 100; lowest score wins.
 */

export type Suit = 'C' | 'D' | 'S' | 'H';
/** A card is rank + suit, e.g. "2C", "TD" (ten of diamonds), "QS", "AH". */
export type Card = string;

export const RANKS = '23456789TJQKA';
/** Display order in a hand: alternating colours. */
export const SUIT_ORDER: Suit[] = ['C', 'D', 'S', 'H'];
export const QUEEN_OF_SPADES = 'QS';
export const TWO_OF_CLUBS = '2C';
export const HEARTS_TARGET = 100;

export function isCard(v: unknown): v is Card {
  return typeof v === 'string' && v.length === 2 && RANKS.includes(v[0]) && 'CDHS'.includes(v[1]);
}

export const suitOf = (c: Card) => c[1] as Suit;
export const rankOf = (c: Card) => RANKS.indexOf(c[0]);

export function cardPoints(c: Card): number {
  if (c === QUEEN_OF_SPADES) return 13;
  return suitOf(c) === 'H' ? 1 : 0;
}

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUIT_ORDER) for (const r of RANKS) deck.push(r + s);
  return deck;
}

export function sortHand(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => SUIT_ORDER.indexOf(suitOf(a)) - SUIT_ORDER.indexOf(suitOf(b)) || rankOf(a) - rankOf(b));
}

/** Shuffle and deal 13 each. `randomInt(n)` returns 0..n-1 (crypto on the server). */
export function deal(randomInt: (n: number) => number): Card[][] {
  const deck = fullDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return [0, 1, 2, 3].map((s) => sortHand(deck.slice(s * 13, s * 13 + 13)));
}

export type PassDir = 'left' | 'right' | 'across' | 'none';
const PASS_CYCLE: PassDir[] = ['left', 'right', 'across', 'none'];

/** Hand 1 passes left, then right, across, hold, and round again. */
export function passDirFor(handNumber: number): PassDir {
  return PASS_CYCLE[(handNumber - 1) % 4];
}

/** Seats go clockwise, so "left" is the next seat. */
export function passTarget(seat: number, dir: PassDir): number {
  const step = dir === 'left' ? 1 : dir === 'across' ? 2 : dir === 'right' ? 3 : 0;
  return (seat + step) % 4;
}

export interface TrickCard {
  seat: number;
  card: Card;
}

export function trickWinner(trick: TrickCard[]): number {
  const led = suitOf(trick[0].card);
  let best = trick[0];
  for (const t of trick) if (suitOf(t.card) === led && rankOf(t.card) > rankOf(best.card)) best = t;
  return best.seat;
}

export interface HandResult {
  /** Points taken this hand, before the moon rule. */
  taken: number[];
  /** Points scored this hand (after the moon rule). */
  points: number[];
  /** Seat that took all 26, if anyone. */
  moon: number | null;
}

/** One hand of Hearts, from the deal to the last trick. */
export class HeartsRound {
  hands: Card[][];
  taken: Card[][] = [[], [], [], []];
  trick: TrickCard[] = [];
  lastTrick: { cards: TrickCard[]; winner: number } | null = null;
  /** Seat to play, or -1 while a finished trick waits to be collected (or outside play). */
  turn = -1;
  leader = -1;
  heartsBroken = false;
  tricksPlayed = 0;
  phase: 'passing' | 'playing' | 'done';
  passes: (Card[] | null)[] = [null, null, null, null];
  received: Card[][] = [[], [], [], []];

  constructor(
    dealt: Card[][],
    readonly passDir: PassDir,
  ) {
    this.hands = dealt.map((h) => sortHand(h));
    this.phase = passDir === 'none' ? 'playing' : 'passing';
    if (this.phase === 'playing') this.startPlay();
  }

  /** Choose 3 cards to pass. Returns false if the choice isn't valid. */
  submitPass(seat: number, cards: Card[]): boolean {
    if (this.phase !== 'passing' || this.passes[seat]) return false;
    const unique = new Set(cards);
    if (cards.length !== 3 || unique.size !== 3 || !cards.every((c) => this.hands[seat].includes(c))) return false;
    this.passes[seat] = [...cards];
    if (this.passes.every((p) => p)) this.applyPasses();
    return true;
  }

  private applyPasses() {
    for (let s = 0; s < 4; s++) this.hands[s] = this.hands[s].filter((c) => !this.passes[s]!.includes(c));
    for (let s = 0; s < 4; s++) {
      const to = passTarget(s, this.passDir);
      this.received[to] = [...this.passes[s]!];
      this.hands[to] = sortHand([...this.hands[to], ...this.passes[s]!]);
    }
    this.phase = 'playing';
    this.startPlay();
  }

  private startPlay() {
    this.leader = this.hands.findIndex((h) => h.includes(TWO_OF_CLUBS));
    this.turn = this.leader;
  }

  /** Cards this seat may play right now (empty if it isn't their turn). */
  legal(seat: number): Card[] {
    if (this.phase !== 'playing' || this.turn !== seat) return [];
    const hand = this.hands[seat];
    if (this.trick.length === 0) {
      if (this.tricksPlayed === 0) return hand.includes(TWO_OF_CLUBS) ? [TWO_OF_CLUBS] : [];
      if (!this.heartsBroken) {
        const other = hand.filter((c) => suitOf(c) !== 'H');
        if (other.length) return other;
      }
      return [...hand];
    }
    const led = suitOf(this.trick[0].card);
    const follow = hand.filter((c) => suitOf(c) === led);
    if (follow.length) return follow;
    if (this.tricksPlayed === 0) {
      const safe = hand.filter((c) => cardPoints(c) === 0);
      if (safe.length) return safe;
    }
    return [...hand];
  }

  /** Play a card. After the 4th card the trick waits for `collect()`. */
  play(seat: number, card: Card): boolean {
    if (!this.legal(seat).includes(card)) return false;
    this.hands[seat] = this.hands[seat].filter((c) => c !== card);
    this.trick.push({ seat, card });
    if (suitOf(card) === 'H') this.heartsBroken = true;
    this.turn = this.trick.length === 4 ? -1 : (seat + 1) % 4;
    return true;
  }

  get trickComplete() {
    return this.trick.length === 4;
  }

  /** Give the finished trick to its winner, who leads next. Returns the winner. */
  collect(): number {
    if (!this.trickComplete) throw new Error('trick not complete');
    const winner = trickWinner(this.trick);
    this.taken[winner].push(...this.trick.map((t) => t.card));
    this.lastTrick = { cards: this.trick, winner };
    this.trick = [];
    this.tricksPlayed++;
    if (this.tricksPlayed === 13) {
      this.phase = 'done';
      this.turn = -1;
      this.leader = -1;
    } else {
      this.leader = winner;
      this.turn = winner;
    }
    return winner;
  }

  /** Points taken so far this hand. */
  takenPoints(): number[] {
    return this.taken.map((cards) => cards.reduce((sum, c) => sum + cardPoints(c), 0));
  }

  result(): HandResult {
    const taken = this.takenPoints();
    const moon = taken.findIndex((p) => p === 26);
    if (moon >= 0) return { taken, points: taken.map((_, i) => (i === moon ? 0 : 26)), moon };
    return { taken, points: taken, moon: null };
  }

  /** Every card played so far this hand (public knowledge). */
  played(): Set<Card> {
    const s = new Set<Card>();
    for (const cards of this.taken) for (const c of cards) s.add(c);
    for (const t of this.trick) s.add(t.card);
    return s;
  }
}

// ------------------------------------------------------------------ bot

/** Pick 3 cards to pass: dangerous spades, high hearts, and short suits to make voids. */
export function botPass(hand: Card[]): Card[] {
  const count = (s: Suit) => hand.filter((c) => suitOf(c) === s).length;
  const lowSpades = hand.filter((c) => suitOf(c) === 'S' && rankOf(c) < rankOf(QUEEN_OF_SPADES)).length;
  const danger = (c: Card) => {
    const s = suitOf(c);
    let d = rankOf(c);
    if (s === 'S') {
      const r = c[0];
      if (r === 'Q') d += lowSpades >= 3 ? -5 : 30;
      else if (r === 'K' || r === 'A') d += lowSpades >= 3 ? 2 : 18;
      else d -= 4; // low spades protect against the queen
    } else if (s === 'H') {
      d += rankOf(c) * 0.5;
    } else if (count(s) <= 2) {
      d += 6; // clear a short suit so we can discard later
    }
    if (c === TWO_OF_CLUBS) d -= 10;
    return d;
  };
  return [...hand].sort((a, b) => danger(b) - danger(a)).slice(0, 3);
}

/** Choose a card for `seat`. Uses only public information plus the bot's own hand. */
export function botPlay(round: HeartsRound, seat: number): Card {
  const legal = round.legal(seat);
  if (legal.length <= 1) return legal[0];
  const hand = round.hands[seat];
  const played = round.played();
  const high = (cards: Card[]) => cards.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a));
  const low = (cards: Card[]) => cards.reduce((a, b) => (rankOf(b) < rankOf(a) ? b : a));
  const queenOut = !played.has(QUEEN_OF_SPADES) && !hand.includes(QUEEN_OF_SPADES);
  const trick = round.trick;

  if (trick.length === 0) {
    // Leading. Smoke out the queen with low spades if we can't be caught by it.
    const spades = legal.filter((c) => suitOf(c) === 'S');
    const safeSpades = spades.filter((c) => rankOf(c) < rankOf(QUEEN_OF_SPADES));
    if (queenOut && safeSpades.length && safeSpades.length === spades.length) return low(safeSpades);
    const nonHearts = legal.filter((c) => suitOf(c) !== 'H' && c !== QUEEN_OF_SPADES);
    const pool = nonHearts.length ? nonHearts : legal;
    return low(pool);
  }

  const led = suitOf(trick[0].card);
  const winning = trick.filter((t) => suitOf(t.card) === led).reduce((a, b) => (rankOf(b.card) > rankOf(a.card) ? b : a)).card;
  const points = trick.reduce((sum, t) => sum + cardPoints(t.card), 0);
  const last = trick.length === 3;
  const following = suitOf(legal[0]) === led && legal.every((c) => suitOf(c) === led);

  if (following) {
    // Dump the queen under a higher spade.
    if (led === 'S' && legal.includes(QUEEN_OF_SPADES) && rankOf(winning) > rankOf(QUEEN_OF_SPADES)) return QUEEN_OF_SPADES;
    const below = legal.filter((c) => rankOf(c) < rankOf(winning) && c !== QUEEN_OF_SPADES);
    if (below.length) return high(below);
    const noQueen = legal.filter((c) => c !== QUEEN_OF_SPADES);
    const pool = noQueen.length ? noQueen : legal;
    // We're winning this trick: if it's clean and we're last, shed our highest card.
    if (last && points === 0) return high(pool);
    // Otherwise go just above, so later players can still take it.
    return low(pool);
  }

  // Can't follow suit: discard the most dangerous card.
  if (legal.includes(QUEEN_OF_SPADES)) return QUEEN_OF_SPADES;
  if (queenOut) {
    const bigSpades = legal.filter((c) => c === 'AS' || c === 'KS');
    if (bigSpades.length) return high(bigSpades);
  }
  const hearts = legal.filter((c) => suitOf(c) === 'H');
  if (hearts.length) return high(hearts);
  // Highest card from our shortest suit, to work toward a void.
  const bySuit = (s: Suit) => legal.filter((c) => suitOf(c) === s);
  const suits = SUIT_ORDER.filter((s) => bySuit(s).length).sort((a, b) => bySuit(a).length - bySuit(b).length);
  return high(bySuit(suits[0]));
}

// ------------------------------------------------------------------ what each player sees

export interface HeartsSeatView {
  name: string;
  /** Player alias for humans (voice markers, mute); null for bots. */
  alias: string | null;
  color: number;
  bot: boolean;
  /** A person holds this seat but is disconnected; a bot plays for them. */
  away: boolean;
  score: number;
  /** Points taken so far this hand. */
  taken: number;
  cards: number;
  passed: boolean;
}

export interface HeartsView {
  /** Your seat (0-3), or null if you're watching. */
  seat: number | null;
  phase: 'passing' | 'playing' | 'handEnd' | 'gameOver';
  hand: number;
  passDir: PassDir;
  seats: HeartsSeatView[];
  /** Your cards. */
  cards: Card[];
  /** Cards you may play now (your turn only). */
  legal: Card[];
  /** The 3 cards you passed, once you've passed (until the exchange happens). */
  passing: Card[] | null;
  /** Cards passed to you this hand. */
  received: Card[];
  trick: TrickCard[];
  /** Seat that won the trick on the table (shown briefly before it's collected). */
  trickWinner: number | null;
  turn: number | null;
  heartsBroken: boolean;
  /** Scores after each hand, per seat. */
  history: number[][];
  /** Result of the hand just finished (handEnd / gameOver). */
  result: HandResult | null;
  winners: number[];
  target: number;
}
