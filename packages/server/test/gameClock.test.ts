import { afterEach, describe, expect, it, vi } from 'vitest';
import { startGameClock } from '../src/gameClock';

afterEach(() => vi.useRealTimers());

describe('the game clock', () => {
  it('a game starting mid-wait doesn’t read as a stall', () => {
    vi.useFakeTimers();
    let t = 0;
    let every = 6;
    let worst = 0;
    const clock = startGameClock(
      60,
      { step() {}, nextTick: (tick) => tick - (tick % every) + every, housekeeping() {}, late: (ms) => (worst = Math.max(worst, ms)), error() {} },
      () => t,
    );
    for (; t < 70; t++) vi.advanceTimersByTime(1);
    every = 1; // Tanks starts: the tick it wants is already behind us
    clock.wake();
    for (let i = 0; i < 100; i++) {
      t++;
      vi.advanceTimersByTime(1);
    }
    clock.stop();
    expect(worst).toBeLessThan(20);
  });
});
