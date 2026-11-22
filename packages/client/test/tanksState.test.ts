/** Tanks on a page that takes batches: a still battlefield sends few states, and nothing may look different. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, generateTerrain, PHASES, STILL_STATE_TICKS, type GameEvent, type TankDyn, type TankInfo } from '@tank/shared';

// (The ground's picture needs a real canvas.)
vi.mock('../src/terrainRenderer', () => ({ TerrainRenderer: class { reset() {} redraw() {} } }));

import { GameState, type TankInit } from '../src/state';

const GROUND = PHASES.indexOf('ground');
const TICK_MS = 1000 / DEFAULT_CONFIG.tickRate;
let now = 0;

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

function battle(stateEvery = DEFAULT_CONFIG.stateEvery) {
  const info = { id: 1, color: 0, name: 'Liz', controller: 'human', owner: 'Liz', kills: 0, level: 0, protectedUntil: 0 } as unknown as TankInfo;
  const init = {
    t: 'init',
    tankId: 1,
    reclaimed: false,
    config: { ...DEFAULT_CONFIG, stateEvery },
    snapshot: {
      tick: 0,
      terrain: generateTerrain(DEFAULT_CONFIG, 5).toData(),
      terrainSeed: 5,
      terrainRev: 0,
      wind: 0,
      tanks: [info],
      dyn: [[1, 100, 500, 45, GROUND, 0]],
      helis: [],
      shells: [],
      match: { state: 'playing' },
    },
  } as unknown as TankInit;
  const shown = { sounds: [] as string[], feed: 0, toasts: 0, banners: [] as (string | null)[], resyncs: 0, paints: 0 };
  const state = new GameState(init, {
    feed: () => shown.feed++,
    toast: () => shown.toasts++,
    banner: (b: string | null) => shown.banners.push(b),
    resync: () => shown.resyncs++,
    infoChanged() {},
    sound: (name: string) => shown.sounds.push(name),
  } as never);
  const paint = () => void shown.paints++;
  state.terrainView = { redraw: paint, reset: paint } as never;
  return {
    state,
    shown,
    events(events: object[]) {
      state.onMessage({ t: 'events', events: events as GameEvent[] });
    },
    get me() {
      return state.me!;
    },
    server(tick: number, x: number) {
      state.onMessage({ t: 'state', tick, dyn: [[1, x, 500, 45, GROUND, 0] as unknown as TankDyn], helis: [] });
    },
    /** Frames at 60 a second until this tick's time; returns where the tank was drawn in each. */
    playTo(tick: number) {
      const xs: number[] = [];
      while (now < tick * TICK_MS) {
        now = Math.min(now + TICK_MS, tick * TICK_MS);
        state.update(now);
        xs.push(state.me!.x);
      }
      return xs;
    },
  };
}

describe('how far behind it draws', () => {
  it.each([[3, 7], [6, 13]])('with a state every %i ticks, %i ticks behind, so a moving tank never waits', (every, behind) => {
    const b = battle(every);
    expect(b.state.renderTick).toBe(-behind);
    const xs: number[] = [];
    for (let tick = every; tick <= 240; tick += every) {
      b.server(tick, 100 + tick * 2);
      xs.push(...b.playTo(tick + every - 1));
    }
    const moves = xs.slice(80).map((x, i, all) => (i ? x - all[i - 1] : 2)).filter((_, i) => i > 0);
    // About 2 a frame all the way: no standing still between states.
    for (const d of moves) expect(d).toBeGreaterThan(0.5);
  });
});

describe('after a gap in frames', () => {
  const explosion = (tick: number, rev: number) => ({ type: 'explode', tick, rev, shell: rev, x: 100 + rev * 20, y: 520, r: 30, shielded: false, hitTank: null });

  it('what was missed changes the ground without all going off at once', () => {
    const b = battle();
    const missed: object[] = [];
    for (let i = 1; i <= 40; i++) missed.push(explosion(i * 20, i)); // ticks 20 to 800
    missed.push({ type: 'death', tick: 805, tank: 1, killer: null, x: 100, y: 500, cause: 'blast', reset: false, fallDistance: 0 });
    for (let i = 0; i < 46; i++) missed.push({ type: 'drop', tick: 810 + i, tank: 1, x: 100, y: 100 });
    missed.push(explosion(990, 41)); // this one only just happened
    b.events(missed);
    b.server(1000, 100);
    now = 1000 * TICK_MS;
    b.state.update(now);

    expect([b.state.terrainRev, b.shown.resyncs]).toEqual([41, 0]);
    expect(b.shown.sounds).toEqual(['explosion']);
    expect([b.shown.feed, b.shown.toasts]).toEqual([0, 0]);
    expect(b.state.effects.filter((e) => e.kind === 'explosion')).toHaveLength(1);
    expect(b.shown.paints).toBeLessThanOrEqual(2);
  });

  it('a win and a new battlefield that were missed still leave the match right', () => {
    const b = battle();
    b.events([
      { type: 'win', tick: 100, tank: 1, name: 'Liz', nukeAt: 300 },
      { type: 'nuke', tick: 300, rev: 1, seed: 9, wind: 12 },
    ]);
    b.server(1000, 100);
    now = 1000 * TICK_MS;
    b.state.update(now);
    expect(b.state.match).toEqual({ state: 'playing' });
    expect([b.state.terrainRev, b.state.wind]).toEqual([1, 12]);
    expect(b.shown.banners.at(-1)).toBeNull();
    expect([b.shown.sounds, b.state.effects, b.shown.paints]).toEqual([[], [], 1]);
  });

  it('in ordinary play everything is seen and heard', () => {
    const b = battle();
    b.events([explosion(10, 1)]);
    b.server(20, 100);
    b.playTo(30);
    expect(b.shown.sounds).toEqual(['explosion']);
    expect(b.state.effects.length).toBeGreaterThan(0);
  });
});

describe('a still battlefield', () => {
  it('time keeps running between its few states', () => {
    const b = battle();
    b.playTo(3);
    b.server(3, 100); // the first repeat: it's still
    b.playTo(30);
    // Not stuck at tick 3 waiting for the next state, and not ahead of where it would be.
    expect(b.state.renderTick).toBeGreaterThan(15);
    expect(b.state.renderTick).toBeLessThanOrEqual(30);
  });

  it('a tank that sets off after a still spell starts from where it stood, rather than sliding all along', () => {
    const b = battle();
    b.playTo(3);
    b.server(3, 100);
    b.playTo(27);
    b.server(27, 130); // it moved during the last 3 ticks
    const before = b.playTo(30); // what's drawn is 7 ticks behind: still before it moved
    for (const x of before) expect(x).toBe(100);
    b.server(30, 130);
    b.playTo(42);
    expect(b.me.x).toBe(130);
  });

  it('never runs more than a still spell past the newest state (a dropped connection)', () => {
    const b = battle();
    b.playTo(3);
    b.server(3, 100);
    b.playTo(600);
    expect(b.state.renderTick).toBeLessThanOrEqual(3 + STILL_STATE_TICKS);
  });

  it('while things move, time still waits for the server as before', () => {
    const b = battle();
    b.playTo(3);
    b.server(3, 110);
    b.playTo(120);
    expect(b.state.renderTick).toBe(3);
  });
});
