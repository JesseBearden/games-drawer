import { describe, expect, it } from 'vitest';
import { isRoomCode, roomCodeFromEntry } from '../src/protocol';

describe('what goes in "Have a table code?"', () => {
  it('takes the six letters however they are typed', () => {
    expect(roomCodeFromEntry('bcdfgh')).toBe('BCDFGH');
    expect(roomCodeFromEntry(' BCD FGH ')).toBe('BCDFGH');
    expect(roomCodeFromEntry('bcd-fgh')).toBe('BCDFGH');
  });

  it('takes only six letters (the 5-letter codes from before 2026-11-22 are gone)', () => {
    expect(roomCodeFromEntry('bcdfg')).toBe('');
    expect(isRoomCode('BCDFG')).toBe(false);
    expect(isRoomCode('BCDFGH')).toBe(true);
    expect(isRoomCode('BCDF')).toBe(false);
    expect(isRoomCode('BCDFGHJ')).toBe(false);
  });

  it('takes the code out of a pasted invite link', () => {
    expect(roomCodeFromEntry('https://gamesdrawer.com/r/BCDFGH')).toBe('BCDFGH');
    expect(roomCodeFromEntry('gamesdrawer.com/r/bcdfgh?i=abc123')).toBe('BCDFGH');
    expect(roomCodeFromEntry('Come play! https://gamesdrawer.com/r/BCDFGH/')).toBe('BCDFGH');
  });

  it('never reads the start of an address as a code', () => {
    expect(roomCodeFromEntry('https://gamesdrawer.com/')).toBe('');
    expect(roomCodeFromEntry('https:')).toBe('');
    expect(roomCodeFromEntry('gamesdrawer.com/r/BCDFGHJ')).toBe('');
  });

  it('is not a code with too few or too many letters', () => {
    expect(roomCodeFromEntry('bcdf')).toBe('');
    expect(roomCodeFromEntry('bcdfghj')).toBe('');
    expect(roomCodeFromEntry('')).toBe('');
  });
});
