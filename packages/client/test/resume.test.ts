import { describe, expect, it } from 'vitest';
import { resumesTable } from '../src/resume';

describe('going back to your table after a reload', () => {
  it("goes back in from the table's own address", () => {
    expect(resumesTable({ kind: 'join', code: 'BCDFG' }, 'BCDFG')).toBe(true);
  });

  it('follows an invite to another table instead of going back to the old one', () => {
    expect(resumesTable({ kind: 'join', code: 'HJKLM' }, 'BCDFG')).toBe(false);
  });

  it('stays on the home, start, privacy and rules pages when one of those was asked for', () => {
    for (const kind of ['home', 'start', 'privacy', 'rules']) expect(resumesTable({ kind }, 'BCDFG')).toBe(false);
  });
});
