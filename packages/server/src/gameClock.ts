/**
 * The server's fixed 60-a-second clock, which only wakes when there's something to do: every
 * tick while a Tanks battle runs, a few times a second for card and puzzle tables, and once a
 * second (housekeeping) with no game running at all.
 */

/** After a stall, catch up at most this many ticks rather than spiralling. */
const MAX_CATCH_UP = 10;
const HOUSEKEEPING_MS = 1000;

export interface ClockHooks {
  /** One tick has come. Every tick number is passed once and in order, unless we fell behind. */
  step(tick: number): void;
  /** The first tick after `tick` that any game needs, or null with no game running. */
  nextTick(tick: number): number | null;
  /** About once a second. */
  housekeeping(): void;
  /** How much later than asked the clock woke: a stalled event loop (slow work, a stuck disk) shows here. */
  late(ms: number): void;
  error(err: unknown): void;
}

export interface GameClock {
  /** A game may have just started: wake in time for it. */
  wake(): void;
  stop(): void;
}

export function startGameClock(tickRate: number, hooks: ClockHooks, now: () => number = () => performance.now()): GameClock {
  const tickMs = 1000 / tickRate;
  const startedAt = now();
  let done = 0;
  let houseAt = startedAt + HOUSEKEEPING_MS;
  let wakeAt = Infinity;
  let idle = true;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  // (A hair over, so a wake exactly on a tick isn't rounded down to the one before.)
  const ticksSoFar = () => Math.floor((now() - startedAt) / tickMs + 1e-6);

  function schedule() {
    if (stopped) return;
    const next = hooks.nextTick(done);
    idle = next === null;
    const at = Math.min(houseAt, next === null ? Infinity : startedAt + next * tickMs);
    if (at >= wakeAt) return; // already waking in time
    wakeAt = at;
    clearTimeout(timer);
    let delay = Math.ceil(at - now());
    // Windows rounds timers up to its 15.6 ms clock, which would make Tanks step two at a time.
    // (Only for waits that short: the long ones can be a little late.)
    if (process.platform === 'win32' && delay < 2 * tickMs) delay -= 15;
    timer = setTimeout(run, Math.max(1, delay));
  }

  function run() {
    const t = now();
    hooks.late(Math.max(0, t - wakeAt));
    wakeAt = Infinity;
    try {
      const target = ticksSoFar();
      if (target - done > MAX_CATCH_UP) done = target - MAX_CATCH_UP;
      while (done < target) hooks.step(++done);
      if (t >= houseAt) {
        houseAt = t + HOUSEKEEPING_MS;
        hooks.housekeeping();
      }
    } catch (err) {
      hooks.error(err);
    } finally {
      schedule();
    }
  }

  schedule();
  return {
    wake() {
      // A game starting on a sleeping server begins from now: it hasn't missed any ticks.
      if (idle) done = Math.max(done, ticksSoFar());
      schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
