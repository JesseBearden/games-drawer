import { describe, expect, it } from 'vitest';
import { PERSON_FELTS, personFelt, seatFelts } from '../src/felts';

describe('each person’s own felt', () => {
  it('never uses a colour that already means something', () => {
    for (const bad of ['sunflower', 'butter', 'tomato', 'cobalt', 'grass']) expect(PERSON_FELTS).not.toContain(bad);
  });

  it('follows the colour number the table gives each person', () => {
    expect([0, 1, 2, 3].map(personFelt)).toEqual(['sky', 'lilac', 'peach', 'mint']);
    expect(personFelt(PERSON_FELTS.length)).toBe('sky');
  });

  it('keeps people’s own felts in a game and gives computers the spare ones, in order', () => {
    const seats = [
      { bot: true, color: 1 },
      { bot: false, color: 0 },
      { bot: true, color: 2 },
      { bot: false, color: 2 },
    ];
    // People: sky (0) and peach (2). Computers: lilac and mint, the first two nobody has.
    expect(seatFelts(seats)).toEqual(['lilac', 'sky', 'mint', 'peach']);
  });

  it('keeps an away person’s felt while a computer plays for them', () => {
    expect(seatFelts([{ bot: false, color: 3 }, { bot: true, color: 0 }])).toEqual(['mint', 'sky']);
  });
});
