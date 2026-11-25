import { describe, expect, it } from 'vitest';
import {
  MahjongHand,
  mjClaimWhyNot,
  mjLostClaim,
  mjMissedClaim,
  mjMissedKong,
  mjTurnWhyNot,
  parseClientMessage,
  type MjOfferContext,
  type MjOptions,
  type MjTile,
} from '../src';

const none: MjOptions = { win: false, kong: false, pung: false, chows: [] };
const names = ['You', 'Sparky', 'Beep Boop', 'Rusty'];
/** You're seat 0; Rusty (seat 3) plays right before you. */
const offer = (tile: MjTile, hand: MjTile[], from = 3, extra: Partial<MjOfferContext> = {}): MjOfferContext => ({
  tile,
  hand,
  addedKong: false,
  wallLeft: 60,
  seat: 0,
  from,
  names,
  options: none,
  ...extra,
});

describe('Learning Mode: why a discard can’t be taken that way', () => {
  it('says nothing when the choice works', () => {
    const o = { ...none, pung: true, chows: ['d4'] };
    expect(mjClaimWhyNot('pung', offer('d5', ['d5', 'd5'], 3, { options: o }))).toBeNull();
    expect(mjClaimWhyNot('chow', offer('d5', ['d4', 'd6'], 3, { options: o }))).toBeNull();
  });

  it('a Pung needs two of the tile; a Kong three', () => {
    const p = mjClaimWhyNot('pung', offer('d5', ['d5', 'b2']))!;
    expect(p.text).toBe('A Pung is three of a kind: you’d need two 5 dots in your hand, and you have one.');
    expect(p.help).toEqual(['d5']);
    const k = mjClaimWhyNot('kong', offer('we', ['we', 'we']))!;
    expect(k.text).toBe('A Kong is four of a kind: you’d need three East winds in your hand, and you have two.');
    expect(k.help).toEqual(['we', 'we']);
    expect(mjClaimWhyNot('pung', offer('dr', []))!.text).toContain('you have none');
  });

  it('a Chow only from the player right before you, never winds or dragons, and needs a run', () => {
    expect(mjClaimWhyNot('chow', offer('d5', ['d4', 'd6'], 1))!.text).toBe(
      'You can only make a Chow with a tile from Rusty, the player right before you. A tile from anyone can make a Pung, a Kong or Mahjong.',
    );
    expect(mjClaimWhyNot('chow', offer('dg', ['dg']))!.text).toBe('Winds and dragons can’t make a run, so they can’t make a Chow.');
    const c = mjClaimWhyNot('chow', offer('d5', ['d4', 'd9', 'b6', 'd7']))!;
    expect(c.text).toBe('A Chow is a run of three in one suit: with the 5 dots you’d need 3 and 4, 4 and 6, or 6 and 7 dots in your hand.');
    expect(c.help.sort()).toEqual(['d4', 'd7']);
    // At the ends of a suit there's only one way, or two.
    expect(mjClaimWhyNot('chow', offer('c1', []))!.text).toContain('with the 1 characters you’d need 2 and 3 characters');
    expect(mjClaimWhyNot('chow', offer('b8', []))!.text).toContain('with the 8 bamboo you’d need 6 and 7, or 7 and 9 bamboo');
  });

  it('Mahjong, the last tile, and a tile added to a Pung', () => {
    expect(mjClaimWhyNot('win', offer('d5', []))!.text).toBe('This tile doesn’t finish your hand: you need four sets and a pair.');
    expect(mjClaimWhyNot('pung', offer('d5', ['d5', 'd5'], 3, { wallLeft: 0 }))!.text).toContain('the last tile from the wall');
    expect(mjClaimWhyNot('chow', offer('d5', ['d4', 'd6'], 3, { addedKong: true }))!.text).toContain('can only be taken for Mahjong');
  });

  it('agrees with the rules about what can be taken, on real hands', () => {
    // Whatever the rules allow, there's no explanation; whatever they don't, there is one.
    let checked = 0;
    for (let seed = 1; seed < 40; seed++) {
      let r = seed;
      const h = new MahjongHand(0, 0, { points: false, full: false, learning: true }, (n) => (r = (r * 9301 + 49297) % 233280) % n);
      const t = h.hands[0].find((x) => !x.startsWith('f'))!;
      h.discard(0, t);
      for (const seat of [1, 2, 3]) {
        const o = h.options(seat);
        const ctx = offer(t, h.hands[seat], 0, { seat, options: o });
        expect(mjClaimWhyNot('pung', ctx) === null).toBe(o.pung);
        expect(mjClaimWhyNot('kong', ctx) === null).toBe(o.kong);
        expect(mjClaimWhyNot('chow', ctx) === null).toBe(o.chows.length > 0);
        expect(mjClaimWhyNot('win', ctx) === null).toBe(o.win);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('Learning Mode: your own turn', () => {
  const turn = (extra: Partial<Parameters<typeof mjTurnWhyNot>[1]> = {}) => ({ hand: [], melds: [], self: { win: false, kongs: [] }, drew: true, wallLeft: 40, ...extra });

  it('Mahjong needs a finished hand', () => {
    expect(mjTurnWhyNot('win', turn())!.text).toBe('Your tiles don’t make a finished hand yet: you need four sets and a pair.');
    expect(mjTurnWhyNot('win', turn({ self: { win: true, kongs: [] } }))).toBeNull();
  });

  it('a Kong needs all four, or the fourth for a Pung, after drawing', () => {
    expect(mjTurnWhyNot('kong', turn({ self: { win: false, kongs: ['d5'] } }))).toBeNull();
    const three = mjTurnWhyNot('kong', turn({ hand: ['d5', 'd5', 'd5', 'b1'] }))!;
    expect(three.text).toContain('You have three 5 dots: the fourth would make one.');
    expect(three.help).toEqual(['d5', 'd5', 'd5']);
    expect(mjTurnWhyNot('kong', turn({ melds: [{ kind: 'pung', tiles: ['we', 'we', 'we'], from: 1, concealed: false }] }))!.text).toContain(
      'The fourth East wind would go with your Pung.',
    );
    expect(mjTurnWhyNot('kong', turn({ drew: false }))!.text).toContain('Right after taking a tile for a set');
    expect(mjTurnWhyNot('kong', turn({ wallLeft: 0 }))!.text).toContain('no more Kongs');
  });
});

describe('Learning Mode: chances missed, and claims that lost', () => {
  it('passing on a tile you could have taken says what you could have made', () => {
    expect(mjMissedClaim({ ...none, pung: true }, 'd5', ['d5', 'd5'])).toBe('You could have made a Pung with your two 5 dots.');
    expect(mjMissedClaim({ ...none, pung: true, kong: true }, 'dr', ['dr', 'dr', 'dr'])).toBe('You could have made a Kong with your three Red dragons.');
    expect(mjMissedClaim({ ...none, pung: true, chows: ['d4'] }, 'd5', ['d4', 'd5', 'd5', 'd6'])).toBe(
      'You could have made a Pung with your two 5 dots, or a Chow with your 4 and 6 dots.',
    );
    expect(mjMissedClaim(none, 'd5', [])).toBeNull();
    expect(mjMissedClaim(null, 'd5', [])).toBeNull();
  });

  it('throwing away when you could have made a Kong says so', () => {
    expect(mjMissedKong(['b2'], [])).toBe('You could have made a Kong with your four 2 bamboo.');
    expect(mjMissedKong(['b2'], [{ kind: 'pung', tiles: ['b2', 'b2', 'b2'], from: 1, concealed: false }])).toBe(
      'You could have added your 2 bamboo to your Pung to make a Kong.',
    );
    expect(mjMissedKong([], [])).toBeNull();
  });

  it('a Chow loses to a Pung or Kong, anything to Mahjong', () => {
    expect(mjLostClaim('chow', 'Sparky', 'pung')).toBe('Sparky took it for a Pung, which comes before a Chow.');
    expect(mjLostClaim('pung', 'Sparky', 'win')).toBe('Sparky went Mahjong on it, which comes before everything else.');
    expect(mjLostClaim('pass', 'Sparky', 'pung')).toBeNull();
  });
});

describe('Learning Mode: the table choice', () => {
  it('reads it from the message, and older messages without it mean off', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'mj-rules', points: false, full: false, learning: true }))).toEqual({ t: 'mj-rules', points: false, full: false, learning: true });
    expect(parseClientMessage(JSON.stringify({ t: 'mj-rules', points: true, full: false }))).toEqual({ t: 'mj-rules', points: true, full: false, learning: false });
    expect(parseClientMessage(JSON.stringify({ t: 'mj-rules', points: true, full: false, learning: 'yes' }))).toBeNull();
  });
});
