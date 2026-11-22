import { describe, expect, it } from 'vitest';
import { nukeShake } from '../src/renderer';

describe('the screen shake', () => {
  it('shakes through a nuke, and never with Reduce motion on', () => {
    expect(nukeShake(0.3, false)).toBeGreaterThan(5);
    for (let t = 0; t <= 1; t += 0.1) expect(nukeShake(t, true)).toBe(0);
  });
});
