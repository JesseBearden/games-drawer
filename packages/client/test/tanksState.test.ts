/** Tanks on a page that takes batches: a still battlefield sends few states, and nothing may look different. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, generateTerrain, PHASES, STILL_STATE_TICKS, type TankDyn, type TankInfo } from '@tank/shared';

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

function battle() {
  const info = { id: 1, color: 0, name: 'Liz', controller: 'human', owner: 'Liz', kills: 0, level: 0, protectedUntil: 0 } as unknown as TankInfo;
  const init = {
    t: 'init',
    tankId: 1,
    reclaimed: false,
    config: DEFAULT_CONFIG,
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
  const state = new GameState(init, { feed() {}, toast() {}, banner() {}, resync() {}, infoChanged() {}, sound() {} } as never);
  return {
    state,
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
