/**
 * Spades: rules, scoring and simple bots. Pure and deterministic given the deal, so the server
 * runs it and tests can replay whole games.
 *
 * Rules used (the common partnership game):
 * - 4 players; partners sit across, so seats 0 and 2 are one team and 1 and 3 the other.
 * - 13 cards each, no passing. Starting left of the dealer, everyone bids how many tricks
 *   they'll take. A bid of 0 is "nil": a promise to take none at all.
 * - Left of the dealer leads. Follow suit if you can; otherwise play anything. Spades are
 *   trump, and can't be led until one has been played (unless you hold nothing else).
 * - A team that takes at least its combined bid scores 10 per trick bid, plus 1 per extra
 *   trick ("bag"). Falling short loses 10 per trick bid. Nil scores 100 if that player takes
 *   no tricks and loses 100 if they take any (their tricks count as bags for the team).
 * - Every 10 bags a team collects costs it 100 points.
 * - First team to 500 wins (higher score if both get there); a team at -200 loses.
 */
import { rankOf, suitOf, type Card, type Suit, type TrickCard } from './hearts';

export const SPADES_TARGET = 500;
export const SPADES_FLOOR = -200;
export const BAG_LIMIT = 10;
export const BAG_PENALTY = 100;
export const NIL_POINTS = 100;

/** Spades last in the hand, so trump sits together on the right. */
const SPADES_SUIT_ORDER: Suit[] = ['C', 'D', 'H', 'S'];

export function sortSpadesHand(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => SPADES_SUIT_ORDER.indexOf(suitOf(a)) - SPADES_SUIT_ORDER.indexOf(suitOf(b)) || rankOf(a) - rankOf(b));
}

export const teamOf = (seat: number) => seat % 2;
export const partnerOf = (seat: number) => (seat + 2) % 4;

/** The highest spade wins; with no spades, the highest card of the suit led. */
export function spadesTrickWinner(trick: TrickCard[]): number {
  let best = trick[0];
  for (const t of trick.slice(1)) {
    const same = suitOf(t.card) === suitOf(best.card);
    if (same ? rankOf(t.card) > rankOf(best.card) : suitOf(t.card) === 'S') best = t;
  }
  return best.seat;
}

export interface TeamHandResult {
  /** Combined bid, not counting nil bids. */
  bid: number;
  /** Tricks the team took, nil bidders included. */
  tricks: number;
  /** Points this hand, after any bag penalty. */
  points: number;
  /** Bags collected this hand. */
  bags: number;
  /** The team's bag count after this hand (penalties take 10 off). */
  bagsAfter: number;
  /** Missed the bid. */
  set: boolean;
  /** Paid the 10-bag penalty this hand. */
  bagPenalty: boolean;
  nils: { seat: number; made: boolean }[];
}

/** Score one hand for both teams. `bagsBefore` is each team's running bag count. */
export function scoreSpadesHand(bids: number[], tricks: number[], bagsBefore: number[]): TeamHandResult[] {
  return [0, 1].map((team) => {
    const seats = [team, team + 2];
    let bid = 0;
    let won = 0;
    let points = 0;
    let bags = 0;
    const nils: TeamHandResult['nils'] = [];
    for (const s of seats) {
      if (bids[s] > 0) {
        bid += bids[s];
        won += tricks[s];
      } else {
        const made = tricks[s] === 0;
        nils.push({ seat: s, made });
        points += made ? NIL_POINTS : -NIL_POINTS;
        // A nil bidder's tricks don't help the partner's bid; they're overtricks.
        points += tricks[s];
        bags += tricks[s];
      }
    }
    let set = false;
    if (bid > 0) {
      if (won >= bid) {
        points += 10 * bid + (won - bid);
        bags += won - bid;
      } else {
        points -= 10 * bid;
        set = true;
      }
    }
    let bagsAfter = bagsBefore[team] + bags;
    let bagPenalty = false;
    while (bagsAfter >= BAG_LIMIT) {
      bagsAfter -= BAG_LIMIT;
      points -= BAG_PENALTY;
      bagPenalty = true;
    }
    return { bid, tricks: seats.reduce((n, s) => n + tricks[s], 0), points, bags, bagsAfter, set, bagPenalty, nils };
  });
}

/** Which teams have won once scores are in, or null if the game goes on. */
export function spadesWinners(scores: number[]): number[] | null {
  const [a, b] = scores;
  if (a >= SPADES_TARGET || b >= SPADES_TARGET || a <= SPADES_FLOOR || b <= SPADES_FLOOR) {
    if (a === b) return [0, 1];
    return [a > b ? 0 : 1];
  }
  return null;
}

/** One hand of Spades, from bidding to the last trick. */
export class SpadesRound {
  hands: Card[][];
  bids: (number | null)[] = [null, null, null, null];
  tricks = [0, 0, 0, 0];
  trick: TrickCard[] = [];
  lastTrick: { cards: TrickCard[]; winner: number } | null = null;
  /** Seat to bid or play, or -1 while a finished trick waits to be collected (or after the hand). */
  turn: number;
  leader = -1;
  spadesBroken = false;
  tricksPlayed = 0;
  phase: 'bidding' | 'playing' | 'done' = 'bidding';

  constructor(
    dealt: Card[][],
    readonly dealer: number,
  ) {
    this.hands = dealt.map((h) => sortSpadesHand(h));
    this.turn = (dealer + 1) % 4;
  }

  /** Bid 0 (nil) to 13 tricks, in turn. */
  bid(seat: number, n: number): boolean {
    if (this.phase !== 'bidding' || this.turn !== seat || !Number.isInteger(n) || n < 0 || n > 13) return false;
    this.bids[seat] = n;
    if (this.bids.every((b) => b !== null)) {
      this.phase = 'playing';
      this.leader = (this.dealer + 1) % 4;
      this.turn = this.leader;
    } else {
      this.turn = (seat + 1) % 4;
    }
    return true;
  }

  /** Cards this seat may play right now (empty if it isn't their turn). */
  legal(seat: number): Card[] {
    if (this.phase !== 'playing' || this.turn !== seat) return [];
    const hand = this.hands[seat];
    if (this.trick.length === 0) {
      if (!this.spadesBroken) {
        const other = hand.filter((c) => suitOf(c) !== 'S');
        if (other.length) return other;
      }
      return [...hand];
    }
    const led = suitOf(this.trick[0].card);
    const follow = hand.filter((c) => suitOf(c) === led);
    return follow.length ? follow : [...hand];
  }

  /** Play a card. After the 4th card the trick waits for `collect()`. */
  play(seat: number, card: Card): boolean {
    if (!this.legal(seat).includes(card)) return false;
    this.hands[seat] = this.hands[seat].filter((c) => c !== card);
    this.trick.push({ seat, card });
    if (suitOf(card) === 'S') this.spadesBroken = true;
    this.turn = this.trick.length === 4 ? -1 : (seat + 1) % 4;
    return true;
  }

  get trickComplete() {
    return this.trick.length === 4;
  }

  /** Give the finished trick to its winner, who leads next. Returns the winner. */
  collect(): number {
    if (!this.trickComplete) throw new Error('trick not complete');
    const winner = spadesTrickWinner(this.trick);
    this.tricks[winner]++;
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

  /** Every card played so far this hand (public knowledge). */
  played(): Set<Card> {
    const s = new Set<Card>();
    for (const t of this.trick) s.add(t.card);
    return s;
  }
}

// ------------------------------------------------------------------ bots

const bySuit = (hand: Card[], s: Suit) => hand.filter((c) => suitOf(c) === s);
const lowest = (cards: Card[]) => cards.reduce((a, b) => (rankOf(b) < rankOf(a) ? b : a));
const highest = (cards: Card[]) => cards.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a));

/**
 * How many tricks a hand should take: aces and protected kings in the side suits, high and
 * long spades, and a little for being short in a suit (room to trump). Bids nil with a hand
 * that has no aces or kings and only a few low spades, unless the partner already bid nil.
 */
export function spadesBotBid(hand: Card[], partnerBid: number | null): number {
  let est = 0;
  let ruffs = 0;
  for (const s of ['C', 'D', 'H'] as Suit[]) {
    const cards = bySuit(hand, s);
    const has = (r: string) => cards.some((c) => c[0] === r);
    if (has('A')) est += cards.length <= 5 ? 1 : 0.7;
    if (has('K')) est += cards.length >= 2 ? (has('A') ? 0.85 : 0.55) : 0.15;
    if (has('Q') && cards.length >= 3 && (has('A') || has('K'))) est += 0.3;
    if (cards.length === 0) ruffs += 1.6;
    else if (cards.length === 1) ruffs += 0.8;
    else if (cards.length === 2) ruffs += 0.3;
  }
  const spades = bySuit(hand, 'S');
  const n = spades.length;
  const hasS = (r: string) => spades.some((c) => c[0] === r);
  let high = 0;
  if (hasS('A')) high += 1;
  if (hasS('K')) high += n >= 2 ? 0.95 : 0.4;
  if (hasS('Q')) high += n >= 3 ? 0.75 : 0.25;
  if (hasS('J')) high += n >= 4 ? 0.4 : 0;
  est += high + Math.max(0, n - 3) * 0.85;
  // Small spades can trump short suits.
  est += Math.min(ruffs, Math.max(0, n - Math.round(high))) * 0.7;

  // A slight lean upward: bots that only bid sure things make their bid ~90% of the time, which
  // is tamer than people play.
  const bid = Math.round(est + 0.3);
  const strongCards = hand.some((c) => c[0] === 'A' || c[0] === 'K');
  const topSpade = n ? Math.max(...spades.map(rankOf)) : -1;
  if (bid <= 1 && !strongCards && n <= 3 && topSpade <= rankOf('TS') && partnerBid !== 0) return 0;
  let b = Math.max(1, bid);
  if (partnerBid !== null && partnerBid + b > 13) b = Math.max(1, 13 - partnerBid);
  return b;
}

/** A playable card for this seat. Aims to make the team's bid, cover a nil partner, and avoid bags. */
export function spadesBotPlay(round: SpadesRound, seat: number): Card {
  const legal = round.legal(seat);
  if (legal.length === 1) return legal[0];
  const partner = partnerOf(seat);
  const myBid = round.bids[seat] ?? 1;
  const partnerBid = round.bids[partner] ?? 1;
  const iAmNil = myBid === 0;
  const partnerNil = partnerBid === 0;
  const teamBid = (myBid > 0 ? myBid : 0) + (partnerBid > 0 ? partnerBid : 0);
  const teamTricks = (myBid > 0 ? round.tricks[seat] : 0) + (partnerBid > 0 ? round.tricks[partner] : 0);
  const needTricks = teamBid - teamTricks > 0;
  const nonSpades = (cs: Card[]) => cs.filter((c) => suitOf(c) !== 'S');
  const lowDiscard = (cs: Card[]) => {
    const side = nonSpades(cs);
    if (!side.length) return lowest(cs);
    // Shed from the shortest side suit, to make room for trumping later.
    const shortest = (['C', 'D', 'H'] as Suit[]).map((s) => bySuit(side, s)).filter((g) => g.length).sort((a, b) => a.length - b.length)[0];
    return lowest(shortest);
  };

  // Leading.
  if (round.trick.length === 0) {
    if (iAmNil) return lowDiscard(legal);
    if (needTricks) {
      const aces = legal.filter((c) => c[0] === 'A' && suitOf(c) !== 'S');
      if (aces.length) return aces[0];
    }
    // Lead low from the longest side suit, which is least likely to be trumped.
    const side = nonSpades(legal);
    if (!side.length) return needTricks ? highest(legal) : lowest(legal);
    const longest = (['C', 'D', 'H'] as Suit[]).map((s) => bySuit(side, s)).sort((a, b) => b.length - a.length)[0];
    return lowest(longest);
  }

  const wins = (c: Card) => spadesTrickWinner([...round.trick, { seat, card: c }]) === seat;
  const winners = legal.filter(wins);
  const losers = legal.filter((c) => !wins(c));
  const current = spadesTrickWinner(round.trick);
  const last = round.trick.length === 3;
  const following = suitOf(legal[0]) === suitOf(round.trick[0].card) && legal.every((c) => suitOf(c) === suitOf(round.trick[0].card));

  if (iAmNil) return losers.length ? highest(losers) : lowest(legal);
  // A nil partner who is winning this trick needs rescuing.
  if (partnerNil && current === partner && winners.length) return lowest(winners);
  if (current === partner && !partnerNil) {
    // Partner has it: don't waste a high card (unless we can't avoid it).
    return losers.length ? (following ? lowest(losers) : lowDiscard(losers)) : lowest(legal);
  }
  if (needTricks && winners.length) {
    if (last || !following) return lowest(winners);
    // Not last: play our best in the suit so later players are less likely to beat it.
    return highest(winners);
  }
  if (!needTricks && losers.length) {
    // Bid made: duck, to stay clear of bags.
    return following ? highest(losers) : lowDiscard(losers);
  }
  return following ? lowest(legal) : lowDiscard(legal);
}

// ------------------------------------------------------------------ what each player sees

export interface SpadesSeatView {
  name: string;
  alias: string | null;
  color: number;
  bot: boolean;
  away: boolean;
  /** Null until they've bid (bids are public once made). */
  bid: number | null;
  tricks: number;
  cards: number;
  team: number;
}

export interface SpadesTeamView {
  score: number;
  bags: number;
  /** This hand: combined bid so far (nil counts 0) and tricks taken. */
  bid: number;
  tricks: number;
}

export interface SpadesView {
  /** Your seat, or null if watching. */
  seat: number | null;
  phase: 'bidding' | 'playing' | 'handEnd' | 'gameOver';
  hand: number;
  dealer: number;
  seats: SpadesSeatView[];
  teams: SpadesTeamView[];
  /** Your cards. */
  cards: Card[];
  /** Cards you may play now. */
  legal: Card[];
  trick: TrickCard[];
  /** Seat taking the finished trick on the table, while it's shown. */
  trickWinner: number | null;
  /** Whose bid or play it is. */
  turn: number | null;
  spadesBroken: boolean;
  /** Team scores after each hand. */
  history: number[][];
  result: TeamHandResult[] | null;
  /** Winning team(s) once the game is over. */
  winners: number[];
  target: number;
}
