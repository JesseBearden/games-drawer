import { describe, expect, it } from 'vitest';
import {
  botPass,
  botPlay,
  cardPoints,
  deal,
  fullDeck,
  HeartsRound,
  passDirFor,
  passTarget,
  sortHand,
  trickWinner,
  type Card,
} from '../src/hearts';
import { Rng } from '../src/rng';

const randomInt = (rng: Rng) => (n: number) => rng.int(0, n - 1);

/** A round from fixed hands (13 cards each), no passing. */
function roundFrom(hands: Card[][]) {
  return new HeartsRound(hands, 'none');
}

/** Hands where seat 0 has the 2 of clubs and some useful cards for rule tests. */
function fixedHands(): Card[][] {
  return [
    ['2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', 'TC', 'JC', 'QC', 'KC', 'AC'],
    ['2D', '3D', '4D', '5D', '6D', '7D', '8D', '9D', 'TD', 'JD', 'QD', 'KD', 'AD'],
    ['2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', 'TS', 'JS', 'QS', 'KS', 'AS'],
    ['2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', 'TH', 'JH', 'QH', 'KH', 'AH'],
  ];
}

describe('cards and deals', () => {
  it('deals 52 different cards, 13 each, sorted', () => {
    const hands = deal(randomInt(new Rng(1)));
    const all = hands.flat();
    expect(all).toHaveLength(52);
    expect(new Set(all).size).toBe(52);
    for (const h of hands) {
      expect(h).toHaveLength(13);
      expect(h).toEqual(sortHand(h));
    }
    expect(new Set(fullDeck())).toEqual(new Set(all));
  });

  it('passes left, right, across, then holds', () => {
    expect([1, 2, 3, 4, 5].map(passDirFor)).toEqual(['left', 'right', 'across', 'none', 'left']);
    expect(passTarget(0, 'left')).toBe(1);
    expect(passTarget(0, 'right')).toBe(3);
    expect(passTarget(1, 'across')).toBe(3);
  });

  it('scores hearts 1 and the queen of spades 13', () => {
    expect(fullDeck().reduce((s, c) => s + cardPoints(c), 0)).toBe(26);
    expect(cardPoints('QS')).toBe(13);
    expect(cardPoints('KS')).toBe(0);
  });

  it('the highest card of the suit led wins the trick', () => {
    expect(trickWinner([{ seat: 2, card: '5D' }, { seat: 3, card: 'AS' }, { seat: 0, card: 'KD' }, { seat: 1, card: 'QD' }])).toBe(0);
  });
});

describe('passing', () => {
  it('exchanges three cards with the right player and then starts play', () => {
    const r = new HeartsRound(fixedHands(), 'left');
    expect(r.phase).toBe('passing');
    expect(r.submitPass(0, ['AC', 'KC', 'QC'])).toBe(true);
    expect(r.submitPass(0, ['JC', 'TC', '9C'])).toBe(false);
    expect(r.submitPass(1, ['AD', 'AD', 'KD'])).toBe(false);
    expect(r.submitPass(1, ['AS', 'KD', 'QD'])).toBe(false);
    expect(r.submitPass(1, ['AD', 'KD', 'QD'])).toBe(true);
    expect(r.submitPass(2, ['AS', 'KS', 'QS'])).toBe(true);
    expect(r.phase).toBe('passing');
    expect(r.submitPass(3, ['AH', 'KH', 'QH'])).toBe(true);
    expect(r.phase).toBe('playing');
    expect(r.hands[1]).toContain('AC');
    expect(r.received[1]).toEqual(['AC', 'KC', 'QC']);
    expect(r.hands[0]).toContain('AH');
    expect(r.hands.every((h) => h.length === 13)).toBe(true);
    expect(r.turn).toBe(0);
  });
});

describe('playing rules', () => {
  it('the 2 of clubs leads, and nobody else can play first', () => {
    const r = roundFrom(fixedHands());
    expect(r.legal(0)).toEqual(['2C']);
    expect(r.play(1, '2D')).toBe(false);
    expect(r.play(0, '3C')).toBe(false);
    expect(r.play(0, '2C')).toBe(true);
    expect(r.turn).toBe(1);
  });

  it('no points on the first trick unless you have nothing else', () => {
    const hands = fixedHands();
    // Seat 1: no clubs, some diamonds and the queen. Seat 3: only hearts.
    hands[1] = ['QS', '2D', '3D', '4D', '5D', '6D', '7D', '8D', '9D', 'TD', 'JD', 'QD', 'KD'];
    hands[2] = ['AD', '2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', 'TS', 'JS', 'KS', 'AS'];
    const r = roundFrom(hands);
    r.play(0, '2C');
    expect(r.legal(1)).not.toContain('QS');
    expect(r.play(1, 'QS')).toBe(false);
    expect(r.play(1, '2D')).toBe(true);
    r.play(2, 'AD');
    // Seat 3 holds only hearts, so it may play one.
    expect(r.legal(3).length).toBe(13);
    expect(r.play(3, '2H')).toBe(true);
    expect(r.trickComplete).toBe(true);
    expect(r.collect()).toBe(0);
    expect(r.heartsBroken).toBe(true);
  });

  it('must follow suit when able', () => {
    const hands = fixedHands();
    hands[0] = ['2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', 'TC', 'JC', 'QC', 'KC', '2D'];
    hands[1] = ['AC', '3D', '4D', '5D', '6D', '7D', '8D', '9D', 'TD', 'JD', 'QD', 'KD', 'AD'];
    const r = roundFrom(hands);
    r.play(0, '2C');
    expect(r.legal(1)).toEqual(['AC']);
    expect(r.play(1, '3D')).toBe(false);
  });

  it('hearts cannot be led until broken, unless that is all you have', () => {
    const hands = fixedHands();
    // Seat 0 wins the first trick and holds a heart plus clubs.
    hands[0] = ['2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', 'TC', 'JC', 'QC', 'KC', 'AH'];
    hands[3] = ['AC', '2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', 'TH', 'JH', 'QH', 'KH'];
    const r = roundFrom(hands);
    r.play(0, '2C');
    r.play(1, '2D');
    r.play(2, '2S');
    r.play(3, 'AC');
    expect(r.collect()).toBe(3);
    // Seat 3 has only hearts left: it may lead one even though hearts aren't broken.
    expect(r.heartsBroken).toBe(false);
    expect(r.legal(3)).toHaveLength(12);
    r.play(3, '2H');
    expect(r.heartsBroken).toBe(true);
  });

  it('applies the moon rule', () => {
    const r = roundFrom(fixedHands());
    r.taken[2] = fullDeck().filter((c) => cardPoints(c) > 0);
    r.tricksPlayed = 13;
    const res = r.result();
    expect(res.moon).toBe(2);
    expect(res.points).toEqual([26, 26, 0, 26]);
  });
});

describe('bots', () => {
  function playHand(seed: number) {
    const rng = new Rng(seed);
    const r = new HeartsRound(deal(randomInt(rng)), passDirFor(1 + (seed % 4)));
    if (r.phase === 'passing') for (let s = 0; s < 4; s++) expect(r.submitPass(s, botPass(r.hands[s]))).toBe(true);
    let plays = 0;
    while (r.phase === 'playing') {
      if (r.trickComplete) {
        r.collect();
        continue;
      }
      const seat = r.turn;
      const card = botPlay(r, seat);
      expect(r.legal(seat)).toContain(card);
      expect(r.play(seat, card)).toBe(true);
      plays++;
    }
    return { r, plays };
  }

  it('play hundreds of hands using only legal moves', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { r, plays } = playHand(seed);
      expect(plays).toBe(52);
      expect(r.hands.every((h) => h.length === 0)).toBe(true);
      expect(r.takenPoints().reduce((a, b) => a + b, 0)).toBe(26);
    }
  });

  it('pass the queen of spades when they cannot protect it', () => {
    const hand = sortHand(['QS', 'AS', '2C', '3C', '4C', '5C', '6C', '2D', '3D', '4D', '5D', '6D', '7D']);
    expect(botPass(hand)).toEqual(expect.arrayContaining(['QS', 'AS']));
  });

  it('dump the queen of spades when they cannot follow suit', () => {
    const hands = fixedHands();
    hands[1] = ['QS', '2D', '3D', '4D', '5D', '6D', '7D', '8D', '9D', 'TD', 'JD', 'QD', 'KD'];
    hands[2] = ['AD', '2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', 'TS', 'JS', 'KS', 'AS'];
    const r = roundFrom(hands);
    r.play(0, '2C');
    r.play(1, '2D');
    r.play(2, 'AD');
    r.play(3, '2H');
    r.collect();
    // Seat 0 leads a club; seat 1 has no clubs and holds the queen.
    r.play(0, '3C');
    expect(botPlay(r, 1)).toBe('QS');
  });

  it('do not lead points when they have a choice', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rng = new Rng(seed);
      const r = new HeartsRound(deal(randomInt(rng)), 'none');
      while (r.phase === 'playing') {
        if (r.trickComplete) {
          r.collect();
          continue;
        }
        const card = botPlay(r, r.turn);
        if (r.trick.length === 0 && card === 'QS') {
          expect(r.legal(r.turn).every((c) => c === 'QS' || c[1] === 'H')).toBe(true);
        }
        r.play(r.turn, card);
      }
    }
  });
});
