import { describe, expect, it } from 'vitest';
import {
  bestMelds,
  cardsInRound,
  isMeld,
  isTTCard,
  isWild,
  parseClientMessage,
  parseGameInput,
  Rng,
  ThreeThirteenRound,
  ttBotDiscard,
  ttBotTakesDiscard,
  ttDeck,
  ttPoints,
  TT_ROUNDS,
  wildRankOf,
} from '../src';

const rnd = (seed: number) => {
  const r = new Rng(seed);
  return (n: number) => Math.floor(r.next() * n);
};

/** A round with hands, pile and discards set by hand (seat 0 to play first). */
function setRound(round: number, hands: string[][], discard: string[] = ['2C1'], stock: string[] = ['9D1', '8D1', '7D1']) {
  const r = new ThreeThirteenRound(round, 3, rnd(1));
  r.hands = hands.map((h) => [...h]);
  r.discard = [...discard];
  r.stock = [...stock];
  r.turn = 0;
  return r;
}

describe('the cards', () => {
  it('two decks and four jokers: 108 different cards', () => {
    const deck = ttDeck();
    expect(deck).toHaveLength(108);
    expect(new Set(deck).size).toBe(108);
    expect(deck.filter((c) => c[0] === 'X')).toEqual(['XR0', 'XB0', 'XR1', 'XB1']);
    expect(deck.every(isTTCard)).toBe(true);
    for (const bad of ['QS', 'QS2', 'XG0', '1H0', 'QSX']) expect(isTTCard(bad)).toBe(false);
  });

  it('round 1 deals 3 with 3s wild, up to round 11: 13 cards, Kings wild', () => {
    expect([1, 11].map(cardsInRound)).toEqual([3, 13]);
    expect([1, 8, 9, 10, 11].map(wildRankOf)).toEqual([3, 10, 11, 12, 13]);
    expect(isWild('3H0', 1)).toBe(true);
    expect(isWild('3H0', 2)).toBe(false);
    expect(isWild('KS1', 11)).toBe(true);
    expect(isWild('XB0', 5)).toBe(true);
  });

  it('counts Aces 1, number cards their number, faces 10 and jokers 20', () => {
    expect(['AH0', '7C0', 'TD1', 'JS0', 'QH0', 'KC1', 'XR0'].map(ttPoints)).toEqual([1, 7, 10, 10, 10, 10, 20]);
  });
});

describe('melds', () => {
  it('sets and runs, Ace low, no wrapping', () => {
    expect(isMeld(['5H0', '5D0', '5S1'], 2)).toBe(true);
    expect(isMeld(['9S0', '9S1', '9H0'], 2)).toBe(true); // two decks: the same card twice is fine in a set
    expect(isMeld(['AH0', '2H0', '3H0'], 2)).toBe(true);
    expect(isMeld(['QH0', 'KH0', 'AH0'], 2)).toBe(false);
    expect(isMeld(['KH0', 'AH0', '2H0'], 3)).toBe(false);
    expect(isMeld(['5H0', '6H0', '7D0'], 2)).toBe(false);
    expect(isMeld(['5H0', '5H1', '6H0'], 2)).toBe(false);
  });

  it('wilds stand in anywhere, any number of them', () => {
    expect(isMeld(['3C0', '5C0', 'XR0'], 2)).toBe(true); // 3-joker-5
    expect(isMeld(['3C0', '6C0', 'XR0'], 2)).toBe(false); // needs two
    expect(isMeld(['3C0', '6C0', 'XR0', 'XB1'], 2)).toBe(true);
    expect(isMeld(['KD0', 'XR0', 'XB1'], 2)).toBe(true);
    expect(isMeld(['XR0', 'XB1', 'XR1'], 2)).toBe(true); // all wild
    expect(isMeld(['7H0', '4C0', '4S1'], 2)).toBe(true); // 4s are wild in round 2
  });

  it('finds the layout that leaves the fewest points', () => {
    expect(bestMelds(['5H0', '5D0', '5S0'], 2).points).toBe(0);
    expect(bestMelds(['QH0', 'KH0', 'AH0'], 3).points).toBe(21);
    expect(bestMelds(['7C0', '8C0', 'XR0'], 1).points).toBe(0);
    expect(bestMelds(['2C0', '9H0', 'XR0'], 1).points).toBe(31);
    // The 5 of hearts does more in the run than in the set of 5s...
    const p = bestMelds(['5H0', '6H0', '7H0', '5D0', '5S0'], 2);
    expect(p.points).toBe(10);
    expect(p.melds).toEqual([['5H0', '6H0', '7H0']]);
    // ...and with an 8, everything fits.
    expect(bestMelds(['5H0', '6H0', '7H0', '8H0', '5D0', '5S0', '5C1'], 2).points).toBe(0);
  });

  it('spends wilds where they do the most good, and the costly ones first', () => {
    // A joker and a 3 (wild in round 1) with two loose cards: one meld takes both wilds.
    const p = bestMelds(['KS0', 'XB0', '3H0', '9D0'], 1);
    expect(p.points).toBe(9);
    expect(p.loose).toEqual(['9D0']);
    // No meld possible: the leftover wilds count.
    expect(bestMelds(['KS0', '9D0', 'XB0'], 1).points).toBe(39);
    // A run with a gap: the joker fills it, in order.
    expect(bestMelds(['3C0', '5C0', 'XR0', 'KH0'], 2).melds).toEqual([['3C0', 'XR0', '5C0']]);
  });

  it('works out a full 14-card hand quickly', () => {
    const hand = ['2C0', '3C0', '4C0', '7H0', '7D0', '7S1', 'TD0', 'JD0', 'QD1', 'AS0', '9H1', 'XR0', '5S0', '8C1'];
    const t = Date.now();
    const p = bestMelds(hand, 11);
    expect(Date.now() - t).toBeLessThan(200);
    expect(p.melds.length).toBeGreaterThanOrEqual(3);
    for (const m of p.melds) expect(isMeld(m, 11)).toBe(true);
    expect([...p.melds.flat(), ...p.loose].sort()).toEqual([...hand].sort());
  });
});

describe('a round', () => {
  it('deals the round’s cards to everyone, turns one up, and the player after the dealer starts', () => {
    const r = new ThreeThirteenRound(4, 2, rnd(7));
    expect(r.hands.map((h) => h.length)).toEqual([6, 6, 6, 6]);
    expect(r.discard).toHaveLength(1);
    expect(r.stock).toHaveLength(108 - 24 - 1);
    expect(r.turn).toBe(3);
    expect(r.step).toBe('draw');
  });

  it('draw, then throw away; not the card you just took from the discards', () => {
    const r = setRound(1, [['5H0', '6H0', 'KD0'], ['2S0', '9C0', 'JD0'], ['4D0', '4C0', '8S0'], ['TC0', 'TS0', '7H1']], ['7H0']);
    expect(r.throwAway(0, 'KD0')).toBe(false); // draw first
    expect(r.draw(1, 'stock')).toBeNull(); // not their turn
    expect(r.draw(0, 'discard')).toBe('7H0');
    expect(r.throwAway(0, '7H0')).toBe(false);
    // 5-6-7 of hearts with KD thrown away: that's going out.
    expect(r.goOutCard(0)).toBe('KD0');
    expect(r.throwAway(0, 'KD0')).toBe(true);
    expect(r.outSeat).toBe(0);
    expect(r.lastTurns).toEqual([1, 2, 3]);
    expect(r.turn).toBe(1);
  });

  it('after someone goes out, everyone else gets one last turn, then it’s scored', () => {
    const r = setRound(1, [['5H0', '6H0', 'KD0'], ['2S0', '9C0', 'JD0'], ['4D0', '4C0', '8S0'], ['TC0', 'TS0', '7H1']], ['7H0'], ['4S0', 'QD0', 'AC0']);
    r.draw(0, 'discard');
    r.throwAway(0, 'KD0');
    r.draw(1, 'stock'); // AC0
    r.throwAway(1, 'JD0');
    r.draw(2, 'stock'); // QD0
    r.throwAway(2, '8S0'); // 4D 4C QD: no meld (3s are wild, not 4s)
    expect(r.phase).toBe('playing');
    r.draw(3, 'stock'); // 4S0
    r.throwAway(3, '7H1'); // TC TS 4S: no meld
    expect(r.phase).toBe('done');
    expect(r.result!.map((x) => x.points)).toEqual([0, 2 + 9 + 1, 4 + 4 + 10, 10 + 10 + 4]);
    expect(r.result![0].out).toBe(true);
  });

  it('with two players, only their seats get cards and turns, and only the other gets a last turn', () => {
    const r = new ThreeThirteenRound(1, 2, rnd(3), [0, 2]);
    expect(r.hands.map((h) => h.length)).toEqual([3, 0, 3, 0]);
    expect(r.turn).toBe(0); // the dealer is seat 2, so seat 0 starts
    r.hands = [['5H0', '6H0', 'KD0'], [], ['2S0', '9C0', 'JD0'], []];
    r.discard = ['7H0'];
    r.draw(0, 'stock');
    r.throwAway(0, r.hands[0].find((c) => c !== '5H0' && c !== '6H0')!);
    expect(r.turn).toBe(2);
    r.draw(2, 'stock');
    r.throwAway(2, r.hands[2][0]);
    expect(r.turn).toBe(0);
    // Give seat 0 a hand that goes out.
    r.hands[0] = ['5H0', '6H0', '7H0', 'KD1'];
    r.step = 'discard';
    r.throwAway(0, 'KD1');
    expect(r.outSeat).toBe(0);
    expect(r.lastTurns).toEqual([2]);
    r.draw(2, 'stock');
    r.throwAway(2, r.hands[2][0]);
    expect(r.phase).toBe('done');
    expect(r.result![1].points).toBe(0);
    expect(r.result![3].points).toBe(0);
  });

  it('shuffles the discards back in when the pile runs out', () => {
    const r = setRound(1, [['5H0', '6H0', 'KD0'], [], [], []], ['2D0', '9S0', 'TH0'], []);
    expect(r.draw(0, 'stock')).not.toBeNull();
    expect(r.discard).toEqual(['TH0']);
    expect(r.stock).toHaveLength(1);
  });

  it('a hand can be put in any order, but only the same cards', () => {
    const r = setRound(1, [['5H0', '6H0', 'KD0'], [], [], []]);
    expect(r.arrange(0, ['KD0', '5H0', '6H0'])).toBe(true);
    expect(r.hands[0]).toEqual(['KD0', '5H0', '6H0']);
    expect(r.arrange(0, ['KD0', '5H0', '6H1'])).toBe(false);
    expect(r.arrange(0, ['KD0', '5H0'])).toBe(false);
  });
});

describe('computer players', () => {
  it('take a discard that helps and throw away what doesn’t', () => {
    const r = setRound(2, [['5H0', '6H0', 'KD0', '2C0'], [], [], []], ['7H0']);
    expect(ttBotTakesDiscard(r, 0)).toBe(true);
    r.draw(0, 'discard');
    expect(ttBotDiscard(r, 0)).toBe('KD0');
    const s = setRound(2, [['5H0', '6H0', 'KD0', '2C0'], [], [], []], ['9S0']);
    expect(ttBotTakesDiscard(s, 0)).toBe(false);
  });

  it('play whole games to the end: every round finishes', () => {
    for (const seed of [1, 2, 3]) {
      const rand = rnd(seed);
      const totals = [0, 0, 0, 0];
      let turns = 0;
      for (let round = 1; round <= TT_ROUNDS; round++) {
        const r = new ThreeThirteenRound(round, round % 4, rand);
        while (r.phase === 'playing') {
          const s = r.turn;
          r.draw(s, ttBotTakesDiscard(r, s) ? 'discard' : 'stock');
          expect(r.throwAway(s, ttBotDiscard(r, s))).toBe(true);
          if (++turns > 4000) throw new Error('a round never ended');
        }
        r.result!.forEach((x, i) => (totals[i] += x.points));
        expect(r.result!.filter((x) => x.out)).toHaveLength(1);
      }
      expect(totals.every((t) => t >= 0)).toBe(true);
    }
  });
});

describe('input from players', () => {
  it('keeps only well-formed moves', () => {
    expect(parseGameInput({ t: 'tt-draw', from: 'discard' })).toEqual({ t: 'tt-draw', from: 'discard' });
    expect(parseGameInput({ t: 'tt-draw', from: 'deck' })).toBeNull();
    expect(parseGameInput({ t: 'tt-discard', card: 'XR1', extra: 1 })).toEqual({ t: 'tt-discard', card: 'XR1' });
    expect(parseGameInput({ t: 'tt-discard', card: 'QS' })).toBeNull();
    expect(parseGameInput({ t: 'tt-arrange', cards: ['QS0', 'XR1'] })).toEqual({ t: 'tt-arrange', cards: ['QS0', 'XR1'] });
    expect(parseGameInput({ t: 'tt-arrange', cards: ['QS0', 'QS0'] })).toBeNull();
    expect(parseGameInput({ t: 'tt-arrange', cards: Array.from({ length: 15 }, () => 'QS0') })).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'players', n: 2 }))).toEqual({ t: 'players', n: 2 });
    for (const n of [1, 5, 2.5, '3']) expect(parseClientMessage(JSON.stringify({ t: 'players', n }))).toBeNull();
  });
});
