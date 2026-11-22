import { describe, expect, it } from 'vitest';
import { readActive, resumesTable } from '../src/resume';

describe('going back to your table after a reload', () => {
  it("goes back in from the table's own address", () => {
    expect(resumesTable({ kind: 'join', code: 'BCDFG' }, 'BCDFG')).toBe(true);
  });

  it('follows an invite to another table instead of going back to the old one', () => {
    expect(resumesTable({ kind: 'join', code: 'HJKLM' }, 'BCDFG')).toBe(false);
  });

  it('brings the mic back muted if it was muted, with the people you muted', () => {
    const was = { room: { kind: 'private', code: 'BCDFG' }, mic: true, muted: true, mutedPeople: [['a1b2', 'Sam']] };
    expect(readActive(JSON.stringify(was))).toEqual(was);
  });

  it('reads what an older page kept, and ignores junk', () => {
    const room = { kind: 'private', code: 'BCDFG' };
    const plain = { room, mic: false, muted: false, mutedPeople: [] };
    expect(readActive(JSON.stringify(room))).toEqual(plain);
    expect(readActive(JSON.stringify({ room, mic: true }))).toEqual({ ...plain, mic: true });
    expect(readActive(JSON.stringify({ room, muted: 'yes', mutedPeople: [7, ['x']] }))).toEqual(plain);
    for (const junk of [null, '', '{', '7', '{}']) expect(readActive(junk)).toBeNull();
  });

  it('stays on the home, start, privacy and rules pages when one of those was asked for', () => {
    for (const kind of ['home', 'start', 'privacy', 'rules']) expect(resumesTable({ kind }, 'BCDFG')).toBe(false);
  });
});
