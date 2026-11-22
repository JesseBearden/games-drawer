/**
 * Three Thirteen: rules, scoring and a computer player. Pure and deterministic given the deal,
 * so the server runs it and tests can replay whole games.
 *
 * The user's family's rules (2026-11-20):
 * - Two decks with their four jokers (108 cards), 2 to 4 players: the table picks how many, and
 *   computers fill any seats in play that nobody takes.
 * - 11 rounds: round 1 deals 3 cards each, round 11 deals 13. That round's wilds are the jokers
 *   and the rank matching the cards dealt: 3s, then 4s … 10s, Jacks, Queens, Kings.
 * - Melds: sets (3 or more of a rank) and runs (3 or more in a row in one suit). Aces are low
 *   only (A-2-3), and runs don't wrap (no K-A-2). Wilds stand in anywhere, any number of them:
 *   a meld can even be all wilds.
 * - A turn: take the top of the pile or the top discard, then throw one away (not the card you
 *   just took from the discards).
 * - Going out: when everything but the card you throw away is in melds. Everyone else then gets
 *   one last turn. No adding to someone else's melds.
 * - Scoring: whatever isn't in a meld. Ace 1, 2-10 their number, J/Q/K 10, jokers 20 (a wild of
 *   the round's rank counts its own value). Lowest total after 11 rounds wins.
 */

/**
 * A card: rank, suit, then which of the two decks it's from: "QS0", "TD1" (ten of diamonds).
 * Jokers are "XR0", "XR1" (red) and "XB0", "XB1" (black).
 */
export type TTCard = string;

/** Ace low: A is 1, then 2-10, J 11, Q 12, K 13. */
export const TT_RANKS = 'A23456789TJQK';
export const TT_SUITS = ['C', 'D', 'S', 'H'] as const;
export const TT_ROUNDS = 11;
export const TT_SEATS = 4;
/** What an unmelded joker costs. */
export const JOKER_POINTS = 20;

export function isTTCard(v: unknown): v is TTCard {
  return typeof v === 'string' && /^(?:[A2-9TJQK][CDHS]|X[RB])[01]$/.test(v);
}

export const isJoker = (c: TTCard) => c[0] === 'X';
/** 1 (Ace) to 13 (King); jokers 0. */
export const ttRank = (c: TTCard) => (isJoker(c) ? 0 : TT_RANKS.indexOf(c[0]) + 1);
export const ttSuit = (c: TTCard) => c[1];
/** Round 1 deals 3 cards, round 11 deals 13. */
export const cardsInRound = (round: number) => round + 2;
/** The rank that's wild this round (3 in round 1 … 13, Kings, in round 11). */
export const wildRankOf = (round: number) => round + 2;
export const isWild = (c: TTCard, round: number) => isJoker(c) || ttRank(c) === wildRankOf(round);

export function ttPoints(c: TTCard): number {
  if (isJoker(c)) return JOKER_POINTS;
  return Math.min(10, ttRank(c));
}

/** Two decks and their four jokers, in order. */
export function ttDeck(): TTCard[] {
  const deck: TTCard[] = [];
  for (const copy of [0, 1]) {
    for (const s of TT_SUITS) for (const r of TT_RANKS) deck.push(`${r}${s}${copy}`);
    deck.push(`XR${copy}`, `XB${copy}`);
  }
  return deck;
}

export function shuffled<T>(items: T[], randomInt: (n: number) => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A tidy starting order for a new hand: by suit, then rank, with wilds at the end. */
export function ttSortHand(cards: TTCard[], round: number): TTCard[] {
  const key = (c: TTCard) => (isWild(c, round) ? 1000 + ttPoints(c) : TT_SUITS.indexOf(ttSuit(c) as (typeof TT_SUITS)[number]) * 100 + ttRank(c));
  return [...cards].sort((a, b) => key(a) - key(b) || a.localeCompare(b));
}

// ------------------------------------------------------------------ melds

export interface MeldPlan {
  /** Groups of 3 or more that count: sets and runs (wilds included). */
  melds: TTCard[][];
  /** Everything else, which scores against you. */
  loose: TTCard[];
  /** What the loose cards cost. */
  points: number;
}

/** Whether these cards make one meld this round: a set or a run, wilds standing in. */
export function isMeld(cards: TTCard[], round: number): boolean {
  if (cards.length < 3) return false;
  const natural = cards.filter((c) => !isWild(c, round));
  if (natural.length <= 1) return true;
  // A set: every natural card the same rank.
  if (natural.every((c) => ttRank(c) === ttRank(natural[0]))) return true;
  // A run: one suit, no rank twice, and the gaps (and the ends) filled by wilds, Ace low.
  if (!natural.every((c) => ttSuit(c) === ttSuit(natural[0]))) return false;
  const ranks = natural.map(ttRank).sort((a, b) => a - b);
  for (let i = 1; i < ranks.length; i++) if (ranks[i] === ranks[i - 1]) return false;
  const span = ranks[ranks.length - 1] - ranks[0] + 1;
  return span <= cards.length && cards.length <= 13;
}

/**
 * The best way to lay out a hand: the melds that leave the fewest points loose. Searches every
 * way of grouping the natural cards (with wilds filling in), remembering what it has worked out.
 * A hand is at most 14 cards, so this stays quick.
 */
export function bestMelds(hand: TTCard[], round: number): MeldPlan {
  const wilds = hand.filter((c) => isWild(c, round)).sort((a, b) => ttPoints(b) - ttPoints(a) || a.localeCompare(b));
  const natural = hand
    .filter((c) => !isWild(c, round))
    .sort((a, b) => TT_SUITS.indexOf(ttSuit(a) as 'C') - TT_SUITS.indexOf(ttSuit(b) as 'C') || ttRank(a) - ttRank(b) || a.localeCompare(b));
  const n = natural.length;
  const W = wilds.length;
  const full = (1 << n) - 1;
  type Best = { cost: number; melds: number[][]; wildsIn: number[]; loose: number[] };
  const memo = new Map<number, Best>();

  // Melds are built from natural-card indexes plus a count of wilds.
  const solve = (mask: number, used: number, anyMeld: boolean): Best => {
    const key = (mask * 16 + used) * 2 + (anyMeld ? 1 : 0);
    const hit = memo.get(key);
    if (hit) return hit;
    let best: Best;
    if (mask === full) {
      const left = W - used;
      // Leftover wilds join any meld (there's no limit), or make one of their own.
      if (anyMeld || left >= 3 || left === 0) best = { cost: 0, melds: [], wildsIn: [], loose: [] };
      else {
        const cost = wilds.slice(used).reduce((s, c) => s + ttPoints(c), 0);
        best = { cost, melds: [], wildsIn: [], loose: [] };
      }
      memo.set(key, best);
      return best;
    }
    let i = 0;
    while (mask & (1 << i)) i++;
    const c = natural[i];
    // Leave it loose.
    {
      const sub = solve(mask | (1 << i), used, anyMeld);
      best = { cost: sub.cost + ttPoints(c), melds: sub.melds, wildsIn: sub.wildsIn, loose: [i, ...sub.loose] };
    }
    const tryMeld = (members: number[], wildCount: number) => {
      if (used + wildCount > W) return;
      let m = mask;
      for (const j of members) m |= 1 << j;
      const sub = solve(m, used + wildCount, true);
      if (sub.cost < best.cost) best = { cost: sub.cost, melds: [members, ...sub.melds], wildsIn: [wildCount, ...sub.wildsIn], loose: sub.loose };
    };
    const free = (j: number) => !(mask & (1 << j));
    // Sets: this card with any of the other same-rank cards still free, wilds making up 3.
    const same: number[] = [];
    for (let j = i + 1; j < n; j++) if (free(j) && ttRank(natural[j]) === ttRank(c)) same.push(j);
    for (let pick = 0; pick < 1 << same.length; pick++) {
      const members = [i, ...same.filter((_, k) => pick & (1 << k))];
      tryMeld(members, Math.max(0, 3 - members.length));
    }
    // Runs upward from this card in its suit (lower ones were dealt with already). Each rank
    // along the way is a free natural card or a wild; short runs are made up with wilds.
    const r = ttRank(c);
    const s = ttSuit(c);
    const at = (rank: number) => {
      for (let j = i + 1; j < n; j++) if (free(j) && ttSuit(natural[j]) === s && ttRank(natural[j]) === rank) return j;
      return -1;
    };
    const walk = (rank: number, members: number[], wildCount: number) => {
      const len = rank - r; // ranks r .. rank-1 covered
      if (len >= 1 && len + Math.max(0, 3 - len) <= 13) {
        // A run ending here (only worth trying if it has more than this one card or uses wilds).
        if (members.length > 1 || wildCount > 0 || len >= 1) tryMeld(members, wildCount + Math.max(0, 3 - len));
      }
      if (rank > 13) return;
      const j = at(rank);
      if (j >= 0) walk(rank + 1, [...members, j], wildCount);
      if (used + wildCount + 1 <= W) walk(rank + 1, members, wildCount + 1);
    };
    walk(r + 1, [i], 0);
    memo.set(key, best);
    return best;
  };

  const plan = solve(0, 0, false);
  // Turn indexes back into cards, wilds handed out to melds the way the search used them.
  let w = 0;
  const melds = plan.melds.map((members, k) => {
    const cards = members.map((j) => natural[j]);
    for (let x = 0; x < plan.wildsIn[k]; x++) cards.push(wilds[w++]);
    return cards;
  });
  const loose = plan.loose.map((j) => natural[j]);
  const leftWilds = wilds.slice(w);
  if (leftWilds.length) {
    if (melds.length) melds[0].push(...leftWilds);
    else if (leftWilds.length >= 3) melds.push(leftWilds);
    else loose.push(...leftWilds);
  }
  for (const m of melds) sortMeld(m, round);
  return { melds, loose, points: loose.reduce((t, c) => t + ttPoints(c), 0) };
}

/** Show a meld the way people read it: a run low to high (wilds in their gaps), a set together. */
function sortMeld(m: TTCard[], round: number) {
  const natural = m.filter((c) => !isWild(c, round)).sort((a, b) => ttRank(a) - ttRank(b));
  const wilds = m.filter((c) => isWild(c, round));
  const isRun = natural.length >= 2 && ttRank(natural[0]) !== ttRank(natural[natural.length - 1]);
  if (!isRun) {
    m.splice(0, m.length, ...natural, ...wilds);
    return;
  }
  const out: TTCard[] = [];
  const spare = [...wilds];
  for (let k = 0; k < natural.length; k++) {
    if (k > 0) for (let g = ttRank(natural[k - 1]) + 1; g < ttRank(natural[k]); g++) out.push(spare.shift()!);
    out.push(natural[k]);
  }
  // Any wilds left extend the run upward, then downward once it reaches the King.
  let top = ttRank(natural[natural.length - 1]);
  while (spare.length && top < 13) {
    out.push(spare.shift()!);
    top++;
  }
  out.unshift(...spare);
  m.splice(0, m.length, ...out);
}

// ------------------------------------------------------------------ a round

export type TTStep = 'draw' | 'discard';

export interface TTSeatResult {
  melds: TTCard[][];
  loose: TTCard[];
  points: number;
  /** This seat went out. */
  out: boolean;
}

/** Solved hands one round remembers (a computer's turn asks about 30 or so). */
const SOLVED_HANDS_KEPT = 300;

/** One round of Three Thirteen, from the deal to everyone's last turn. */
export class ThreeThirteenRound {
  hands: TTCard[][];
  stock: TTCard[];
  /** The discard pile; its top is the last card. */
  discard: TTCard[];
  turn: number;
  step: TTStep = 'draw';
  phase: 'playing' | 'done' = 'playing';
  /** Who went out, once someone has. */
  outSeat: number | null = null;
  /** After someone goes out: the seats still to take their last turn, in order. */
  lastTurns: number[] = [];
  /** The card the player to move just took from the discards (they can't throw it back). */
  tookFromDiscard: TTCard | null = null;
  /** The latest card thrown away, and by whom. */
  lastDiscard: { seat: number; card: TTCard } | null = null;
  /** Each seat's result once the round is done. */
  result: TTSeatResult[] | null = null;

  /**
   * `players`: the seats in play (2 to 4, in seat order); the others get no cards and no turns.
   * The dealer is one of them, and the next one along starts.
   */
  constructor(
    readonly round: number,
    readonly dealer: number,
    private randomInt: (n: number) => number,
    readonly players: number[] = [0, 1, 2, 3],
  ) {
    const deck = shuffled(ttDeck(), randomInt);
    const n = cardsInRound(round);
    this.hands = [];
    for (let s = 0; s < TT_SEATS; s++) this.hands.push(players.includes(s) ? ttSortHand(deck.splice(0, n), round) : []);
    this.discard = [deck.pop()!];
    this.stock = deck;
    this.turn = this.after(dealer);
  }

  /** The next seat in play after this one, going round the table. */
  after(seat: number): number {
    for (let d = 1; d <= TT_SEATS; d++) {
      const s = (seat + d) % TT_SEATS;
      if (this.players.includes(s)) return s;
    }
    return seat;
  }

  /** Solved hands this round, by their cards in any order. */
  private solved = new Map<string, MeldPlan>();

  /**
   * bestMelds, remembered for the round. A computer's turn asks about the same hands again and
   * again (take the discard? go out? what to throw?), as does everyone's view when someone only
   * rearranges. Don't change what it returns: it's shared.
   */
  plan(cards: readonly TTCard[]): MeldPlan {
    const key = [...cards].sort().join();
    let plan = this.solved.get(key);
    if (!plan) {
      if (this.solved.size >= SOLVED_HANDS_KEPT) this.solved.clear();
      plan = bestMelds([...cards], this.round);
      this.solved.set(key, plan);
    }
    return plan;
  }

  get discardTop(): TTCard | null {
    return this.discard.length ? this.discard[this.discard.length - 1] : null;
  }

  /** Take the top of the pile or of the discards. Returns the card, or null if not allowed. */
  draw(seat: number, from: 'stock' | 'discard'): TTCard | null {
    if (this.phase !== 'playing' || seat !== this.turn || this.step !== 'draw') return null;
    let card: TTCard | undefined;
    if (from === 'discard') {
      card = this.discard.pop();
      if (!card) return null;
      this.tookFromDiscard = card;
    } else {
      if (!this.stock.length) this.reshuffle();
      card = this.stock.pop();
      if (!card) return null;
      this.tookFromDiscard = null;
    }
    this.hands[seat].push(card);
    this.step = 'discard';
    return card;
  }

  /** The pile ran out: shuffle the discards (all but the top one) back in. */
  private reshuffle() {
    const top = this.discard.pop();
    this.stock = shuffled(this.discard, this.randomInt);
    this.discard = top ? [top] : [];
  }

  /** Whether throwing this card away now leaves everything else in melds. */
  goesOut(seat: number, card: TTCard): boolean {
    const hand = this.hands[seat];
    if (!hand.includes(card)) return false;
    const rest = [...hand];
    rest.splice(rest.indexOf(card), 1);
    return this.plan(rest).points === 0;
  }

  /** A card this seat could throw away to go out right now, or null. */
  goOutCard(seat: number): TTCard | null {
    if (this.phase !== 'playing' || seat !== this.turn || this.step !== 'discard') return null;
    // Prefer to throw away the card worth the most (it doesn't matter for scoring, but reads well).
    const options = [...new Set(this.hands[seat])].filter((c) => c !== this.tookFromDiscard).sort((a, b) => ttPoints(b) - ttPoints(a));
    for (const c of options) if (this.goesOut(seat, c)) return c;
    return null;
  }

  /** Throw a card away, ending the turn (and going out, if the rest is all melds). */
  throwAway(seat: number, card: TTCard): boolean {
    if (this.phase !== 'playing' || seat !== this.turn || this.step !== 'discard') return false;
    const hand = this.hands[seat];
    const k = hand.indexOf(card);
    if (k < 0 || card === this.tookFromDiscard) return false;
    const out = this.outSeat === null && this.goesOut(seat, card);
    hand.splice(k, 1);
    this.discard.push(card);
    this.lastDiscard = { seat, card };
    this.tookFromDiscard = null;
    this.step = 'draw';
    if (out) {
      this.outSeat = seat;
      this.lastTurns = [];
      for (let s = this.after(seat); s !== seat; s = this.after(s)) this.lastTurns.push(s);
    } else if (this.outSeat !== null) {
      this.lastTurns = this.lastTurns.filter((s) => s !== seat);
    }
    if (this.outSeat !== null && this.lastTurns.length === 0) {
      this.finish();
      return true;
    }
    this.turn = this.outSeat !== null ? this.lastTurns[0] : this.after(seat);
    return true;
  }

  /** Put a hand in the order its player likes. Must be exactly the same cards. */
  arrange(seat: number, order: TTCard[]): boolean {
    const hand = this.hands[seat];
    if (order.length !== hand.length) return false;
    const a = [...order].sort();
    const b = [...hand].sort();
    if (!a.every((c, i) => c === b[i])) return false;
    this.hands[seat] = [...order];
    return true;
  }

  private finish() {
    this.phase = 'done';
    this.turn = -1;
    this.result = this.hands.map((hand, s) => {
      const plan = this.plan(hand);
      return { ...plan, out: s === this.outSeat };
    });
  }
}

// ------------------------------------------------------------------ the computer player

/**
 * How much a set of loose cards still promises: cards near each other (same rank, or close in
 * one suit) may become melds, so they're worth keeping. Lower is better.
 */
function looseness(plan: MeldPlan, round: number): number {
  let promise = 0;
  const loose = plan.loose.filter((c) => !isWild(c, round));
  for (let a = 0; a < loose.length; a++) {
    for (let b = a + 1; b < loose.length; b++) {
      const x = loose[a];
      const y = loose[b];
      if (ttRank(x) === ttRank(y)) promise += 2;
      else if (ttSuit(x) === ttSuit(y) && Math.abs(ttRank(x) - ttRank(y)) <= 2) promise += 1.5;
    }
  }
  return plan.points - promise * 2;
}

/** Which card a computer player throws away from its hand (after drawing). */
export function ttBotDiscard(round: ThreeThirteenRound, seat: number): TTCard {
  const hand = round.hands[seat];
  const out = round.goOutCard(seat);
  if (out) return out;
  let best: TTCard | null = null;
  let bestScore = Infinity;
  for (const c of new Set(hand)) {
    if (c === round.tookFromDiscard) continue;
    const rest = [...hand];
    rest.splice(rest.indexOf(c), 1);
    const plan = round.plan(rest);
    // Fewest loose points first; then keep promising cards; never throw a wild if avoidable.
    const score = plan.points * 10 + looseness(plan, round.round) + (isWild(c, round.round) ? 1000 : 0) - ttPoints(c) * 0.1;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best ?? hand[0];
}

/** Whether a computer player takes the top discard (true) or draws from the pile. */
export function ttBotTakesDiscard(round: ThreeThirteenRound, seat: number): boolean {
  const top = round.discardTop;
  if (!top) return false;
  if (isWild(top, round.round)) return true;
  const hand = round.hands[seat];
  const now = round.plan(hand);
  // With the discard: the best hand after throwing something else away. Worth it if the card
  // goes into a meld, or saves real points; swapping a King for a 9 isn't worth giving up a
  // blind draw that might make a meld.
  const withTop = [...hand, top];
  for (const c of new Set(hand)) {
    const rest = [...withTop];
    rest.splice(rest.indexOf(c), 1);
    const plan = round.plan(rest);
    if (plan.points < now.points && plan.melds.some((m) => m.includes(top))) return true;
    if (plan.points <= now.points - 6) return true;
  }
  return false;
}

// ------------------------------------------------------------------ what each player sees

export interface TTSeatView {
  name: string;
  /** Player alias for humans (voice markers, mute); null for bots. */
  alias: string | null;
  color: number;
  bot: boolean;
  /** A person holds this seat but is disconnected; a computer plays for them. */
  away: boolean;
  /** Total so far (lower is better). */
  score: number;
  cards: number;
  /** Went out this round. */
  out: boolean;
  /** This seat is in the game (the table may have chosen fewer than four players). */
  playing: boolean;
}

export interface ThreeThirteenView {
  /** Your seat (0-3), or null if you're watching. */
  seat: number | null;
  phase: 'playing' | 'roundEnd' | 'gameOver';
  /** 1 to 11. */
  round: number;
  rounds: number;
  /** The wild rank this round (3 … 13; jokers are always wild). */
  wild: number;
  /** Which card back this game's deck has (1 to CARD_BACK_COUNT), the same for everyone. */
  back: number;
  dealer: number;
  seats: TTSeatView[];
  /** Your cards, in your order. */
  cards: TTCard[];
  /** How your hand lays out right now (melds and what's loose), or null when watching. */
  plan: MeldPlan | null;
  turn: number | null;
  step: TTStep;
  stock: number;
  discardTop: TTCard | null;
  /** Your turn: the card you just took from the discards (you can't throw it back). */
  tookFromDiscard: TTCard | null;
  /** Your turn: a card you could throw away to go out, if there is one. */
  goOut: TTCard | null;
  /** Who went out this round (everyone else then gets one last turn). */
  outSeat: number | null;
  lastDiscard: { seat: number; card: TTCard } | null;
  /** Each seat's melds and points, once the round is done. */
  result: TTSeatResult[] | null;
  /** Scores after each round, per seat. */
  history: number[][];
  /** Between rounds: seats whose player is ready for the next one. */
  ready: number[];
  winners: number[];
}
