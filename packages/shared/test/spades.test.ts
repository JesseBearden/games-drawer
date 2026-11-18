import { describe, expect, it } from 'vitest';
import {
  deal,
  Rng,
  scoreSpadesHand,
  spadesBotBid,
  spadesBotPlay,
  SpadesRound,
  spadesTrickWinner,
  spadesWinners,
  suitOf,
} from '../src/index';

const t = (...cards: string[]) => cards.map((card, seat) => ({ seat, card }));

describe('spades rules', () => {
  it('the highest spade wins, otherwise the highest card of the suit led', () => {
    expect(spadesTrickWinner(t('5H', 'KH', '2C', 'AH'))).toBe(3);
    expect(spadesTrickWinner(t('5H', 'KH', '2S', 'AH'))).toBe(2);
    expect(spadesTrickWinner(t('5H', '3S', '2S', 'AH'))).toBe(1);
    expect(spadesTrickWinner(t('AS', 'KH', 'QH', 'JH'))).toBe(0);
  });

  it('bids go round from the dealer’s left, who then leads', () => {
    const r = new SpadesRound(deal(() => 0), 2);
    expect(r.turn).toBe(3);
    expect(r.bid(0, 3)).toBe(false); // not their turn
    expect(r.bid(3, 14)).toBe(false); // too many
    for (const s of [3, 0, 1, 2]) expect(r.bid(s, s === 1 ? 0 : 3)).toBe(true);
    expect(r.phase).toBe('playing');
    expect(r.turn).toBe(3);
  });

  it('spades can’t be led until broken, unless that’s all you have', () => {
    const r = new SpadesRound(
      [
        ['AS', '2H', ...'3456789TJQK'.split('').map((x) => x + 'D')],
        ['KS', ...'23456789TJQK'.split('').map((x) => x + 'C')],
        ['QS', ...'3456789TJQKA'.split('').map((x) => x + 'H')],
        ['JS', 'TS', '9S', '8S', '7S', '6S', '5S', '4S', '3S', '2S', 'AC', 'AD', '2D'],
      ],
      3,
    );
    for (const s of [0, 1, 2, 3]) r.bid(s, 2);
    expect(r.legal(0)).not.toContain('AS');
    expect(r.play(0, '2H')).toBe(true);
    // Seat 1 has no hearts: anything goes, including a spade, which breaks spades.
    expect(r.legal(1)).toContain('KS');
    r.play(1, 'KS');
    expect(r.spadesBroken).toBe(true);
    // Seat 2 must follow hearts.
    expect(r.legal(2).every((c) => suitOf(c) === 'H')).toBe(true);
  });
});

describe('spades scoring', () => {
  it('made bids score 10 a trick plus a point per bag; missed bids lose 10 a trick', () => {
    const [a, b] = scoreSpadesHand([3, 4, 2, 3], [4, 2, 2, 3], [0, 0]);
    expect(a).toMatchObject({ bid: 5, tricks: 6, points: 51, bags: 1, set: false });
    expect(b).toMatchObject({ bid: 7, tricks: 5, points: -70, bags: 0, set: true });
  });

  it('nil is worth 100 either way, and a nil bidder’s tricks are bags for the team', () => {
    const [made] = scoreSpadesHand([0, 4, 4, 5], [0, 5, 4, 4], [0, 0]);
    expect(made).toMatchObject({ points: 140, nils: [{ seat: 0, made: true }] });
    const [missed] = scoreSpadesHand([0, 4, 4, 5], [2, 4, 4, 3], [0, 0]);
    // -100 for nil, +2 for its tricks as bags, +40 for the partner's 4.
    expect(missed).toMatchObject({ points: -58, bags: 2, nils: [{ seat: 0, made: false }] });
  });

  it('every 10 bags costs 100', () => {
    const [a] = scoreSpadesHand([2, 3, 2, 3], [4, 3, 3, 3], [8, 0]);
    expect(a).toMatchObject({ bags: 3, bagsAfter: 1, bagPenalty: true, points: 40 + 3 - 100 });
  });

  it('first team to 500 wins; a team at -200 loses', () => {
    expect(spadesWinners([480, 300])).toBeNull();
    expect(spadesWinners([510, 300])).toEqual([0]);
    expect(spadesWinners([510, 530])).toEqual([1]);
    expect(spadesWinners([100, -210])).toEqual([0]);
  });
});

describe('spades bots', () => {
  it('bid sensibly and only ever make legal plays, over hundreds of hands', () => {
    const rng = new Rng(11);
    let totalBids = 0;
    let nils = 0;
    const hands = 300;
    for (let h = 0; h < hands; h++) {
      const r = new SpadesRound(
        deal((n) => rng.int(0, n - 1)),
        h % 4,
      );
      while (r.phase === 'bidding') {
        const s = r.turn;
        const bid = spadesBotBid(r.hands[s], r.bids[(s + 2) % 4]);
        expect(bid).toBeGreaterThanOrEqual(0);
        expect(bid).toBeLessThanOrEqual(13);
        if (bid === 0) {
          nils++;
          expect(r.bids[(s + 2) % 4]).not.toBe(0);
        }
        expect(r.bid(s, bid)).toBe(true);
      }
      totalBids += r.bids.reduce<number>((a, b) => a + (b ?? 0), 0);
      while (r.phase === 'playing') {
        if (r.trickComplete) {
          r.collect();
          continue;
        }
        const s = r.turn;
        const card = spadesBotPlay(r, s);
        expect(r.legal(s)).toContain(card);
        r.play(s, card);
      }
      expect(r.tricks.reduce((a, b) => a + b, 0)).toBe(13);
    }
    // Real tables bid around 10-12 of the 13 tricks; nil should be occasional.
    const avg = totalBids / hands;
    expect(avg).toBeGreaterThan(8.5);
    expect(avg).toBeLessThan(13);
    expect(nils / (hands * 4)).toBeLessThan(0.15);
  });
});
