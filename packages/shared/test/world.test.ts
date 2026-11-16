import { describe, expect, it } from 'vitest';
import { lethalFallDistance } from '../src/config';
import { spreadReady } from '../src/progression';
import type { GameEvent } from '../src/types';
import { World } from '../src/world';
import { addPlaced, cfg, dropShellAt, flatWorld, runTicks, terrainFrom } from './helpers';

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T) {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

describe('helicopter drops', () => {
  it('spawns on a helicopter, drops on request, parachutes, settles with protection', () => {
    const w = flatWorld(800);
    const t = w.addTank({ name: 'A', controller: 'human' });
    w.step();
    expect(t.phase).toBe('carried');
    runTicks(w, 30);
    expect(w.requestDrop(t.id)).toBe(true);
    expect(t.phase).toBe('chute');
    // A second press is consumed (nothing to drop).
    expect(w.requestDrop(t.id)).toBe(false);
    const events = runTicks(w, 60 * 6);
    expect(t.phase).toBe('ground');
    expect(t.y).toBe(800);
    expect(ofType(events, 'settled')).toHaveLength(1);
    expect(w.isProtected(t)).toBe(true);
  });

  it('auto-drops near the end of the pass', () => {
    const w = flatWorld(800);
    const t = w.addTank({ name: 'A', controller: 'human' });
    const events = runTicks(w, 60 * 14);
    expect(ofType(events, 'drop')).toHaveLength(1);
    expect(t.phase === 'chute' || t.phase === 'ground').toBe(true);
  });

  it('a helicopter hit releases the tank and awards one kill and one level', () => {
    const w = flatWorld(800);
    const shooter = addPlaced(w, 'Shooter', 200);
    const passenger = w.addTank({ name: 'P', controller: 'human' });
    runTicks(w, 40);
    const heli = w.helis.find((h) => h.tankId === passenger.id)!;
    expect(heli.carrying).toBe(true);
    dropShellAt(w, shooter.id, heli.x + heli.dir * 3, heli.y);
    const events = w.step();
    expect(ofType(events, 'heliDown')).toHaveLength(1);
    expect(passenger.phase).toBe('chute');
    expect(passenger.deaths).toBe(0);
    expect(shooter.kills).toBe(1);
    expect(shooter.level).toBe(1);
    expect(w.helis.some((h) => h.id === heli.id)).toBe(false);
  });
});

describe('combat', () => {
  it('a direct hit kills and credits the shooter', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    dropShellAt(w, a.id, 900, 790);
    const events = w.step();
    const death = ofType(events, 'death')[0];
    expect(death.cause).toBe('direct');
    expect(death.killer).toBe(a.id);
    expect(b.phase).toBe('dead');
    expect(a.kills).toBe(1);
    expect(a.level).toBe(1);
    expect(a.shellsInFlight).toBe(0);
  });

  it('spawn protection blocks a direct hit until the tank fires', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    b.protectedUntil = w.tick + 600;
    dropShellAt(w, a.id, 900, 790);
    const events = w.step();
    expect(ofType(events, 'explode')[0].shielded).toBe(true);
    expect(b.phase).not.toBe('dead');
    // The crater drops it a little; once it settles it can fire, which ends protection.
    runTicks(w, 60);
    expect(b.phase).toBe('ground');
    expect(w.isProtected(b)).toBe(true);
    expect(w.fire(b.id, 60, 50)).toBe(true);
    expect(w.isProtected(b)).toBe(false);
  });

  it('fired shells land and free the shot slot', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    expect(w.fire(a.id, 60, 50)).toBe(true);
    expect(w.fire(a.id, 60, 50)).toBe(false);
    const events = runTicks(w, 60 * 4);
    expect(ofType(events, 'explode')).toHaveLength(1);
    expect(w.canFire(a)).toBe(true);
  });

  it('typical flight time is around a second', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    w.fire(a.id, 45, 55);
    let ticks = 0;
    while (a.shellsInFlight > 0 && ticks < 600) {
      w.step();
      ticks++;
    }
    expect(ticks / 60).toBeGreaterThan(0.6);
    expect(ticks / 60).toBeLessThan(1.6);
  });
});

describe('falls', () => {
  it('a shot that cuts a ledge credits the shooter for the lethal fall', () => {
    const c = cfg;
    const terrain = terrainFrom((x) => (x < 400 ? 500 : 900));
    for (let x = 400; x < 470; x++) terrain.cols[x] = [500, 540, 900, c.worldHeight];
    const w = new World({ cfg: c, seed: 1, wind: 0, terrain });
    const a = addPlaced(w, 'A', 1200);
    const b = addPlaced(w, 'B', 448);
    expect(b.y).toBe(500);
    dropShellAt(w, a.id, 410, 515);
    const events = runTicks(w, 120);
    const death = ofType(events, 'death')[0];
    expect(death).toBeDefined();
    expect(death.tank).toBe(b.id);
    expect(death.cause).toBe('fall');
    expect(death.killer).toBe(a.id);
    expect(death.fallDistance!).toBeGreaterThanOrEqual(lethalFallDistance(c));
    expect(a.kills).toBe(1);
  });

  it('a short drop is survivable and is not a kill', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 1200);
    const b = addPlaced(w, 'B', 600);
    dropShellAt(w, a.id, 600 + 30, 806);
    const events = runTicks(w, 120);
    expect(ofType(events, 'death')).toHaveLength(0);
    expect(b.phase).toBe('ground');
    expect(b.y).toBeGreaterThan(800);
  });

  it('settling resets the fall measurement', () => {
    const terrain = terrainFrom((x) => (x < 600 ? 700 : x < 900 ? 770 : 840));
    const w = new World({ cfg, seed: 1, wind: 0, terrain });
    const b = addPlaced(w, 'B', 590);
    // Walk off two 70-unit steps (each under 6 body heights) with time to settle between.
    b.level = 10;
    w.setMove(b.id, 1);
    const events = runTicks(w, 60 * 14);
    expect(ofType(events, 'death')).toHaveLength(0);
    expect(b.x).toBeGreaterThan(900);
  });

  it('walking off a high cliff is an environmental death', () => {
    const terrain = terrainFrom((x) => (x < 600 ? 500 : 900));
    const w = new World({ cfg, seed: 1, wind: 0, terrain });
    const b = addPlaced(w, 'B', 585);
    b.level = 10;
    w.setMove(b.id, 1);
    const events = runTicks(w, 60 * 4);
    const death = ofType(events, 'death')[0];
    expect(death.cause).toBe('environment');
    expect(death.killer).toBeNull();
  });

  it('tanks slide off slopes steeper than 30 degrees', () => {
    // 45 degree slope down to the right.
    const terrain = terrainFrom((x) => Math.max(400, Math.min(800, 400 + (x - 500))));
    const w = new World({ cfg, seed: 1, wind: 0, terrain });
    const b = addPlaced(w, 'B', 600);
    const events = runTicks(w, 60 * 6);
    // 300 units of descent is lethal, and nobody shot it.
    const death = ofType(events, 'death')[0];
    expect(death.tank).toBe(b.id);
    expect(death.x).toBeGreaterThan(880);
    expect(death.cause).toBe('environment');
  });

  it('tanks rest on slopes gentler than 30 degrees', () => {
    // ~20 degree slope.
    const terrain = terrainFrom((x) => Math.round(400 + (x - 500) * 0.36));
    const w = new World({ cfg, seed: 1, wind: 0, terrain });
    const b = addPlaced(w, 'B', 700);
    const startX = b.x;
    runTicks(w, 60 * 3);
    expect(b.phase).toBe('ground');
    expect(b.x).toBe(startX);
  });
});

describe('progression', () => {
  it('three deaths reset the run and its perks', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    b.level = 12;
    b.kills = 12;
    for (let i = 0; i < 3; i++) {
      w.killTank(b, 'direct', a.id, null);
      if (i < 2) {
        b.phase = 'ground';
      }
    }
    expect(b.deaths).toBe(0);
    expect(b.level).toBe(0);
    expect(b.kills).toBe(0);
    expect(a.kills).toBe(3);
  });

  it('reaching level 25 grants a fourth life even with two deaths', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    a.level = 24;
    a.deaths = 2;
    w.killTank(b, 'direct', a.id, null);
    expect(a.level).toBe(25);
    expect(a.extraLife).toBe(true);
    const events: GameEvent[] = [];
    w.killTank(a, 'direct', b.id, null);
    events.push(...runTicks(w, 1));
    expect(a.deaths).toBe(3);
    expect(a.level).toBe(25);
    a.phase = 'ground';
    w.killTank(a, 'direct', b.id, null);
    expect(a.deaths).toBe(0);
    expect(a.level).toBe(0);
    expect(a.extraLife).toBe(false);
  });

  it('every tenth shot at level 15 is a spread that counts as one shot', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const victim = addPlaced(w, 'V', 1500);
    a.level = 14;
    w.killTank(victim, 'direct', a.id, null);
    expect(a.level).toBe(15);
    const spreads: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      w.step();
      const ready = spreadReady(a);
      const before = w.shells.length;
      expect(w.fire(a.id, 80, 30)).toBe(true);
      spreads.push(w.shells.length - before === 3);
      expect(ready).toBe(w.shells.length - before === 3);
      runTicks(w, 200);
    }
    expect(spreads.map((s, i) => (s ? i : -1)).filter((i) => i >= 0)).toEqual([9, 19]);
    expect(a.shotsFired).toBe(20);
  });

  it('bounty mode awards levels by victim tier', () => {
    const w = flatWorld(800, { bountyMode: true });
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    b.level = 25;
    w.killTank(b, 'direct', a.id, null);
    expect(a.level).toBe(5);
    expect(a.kills).toBe(1);
  });

  it('level 50 wins, then a nuke resets terrain and everyone', () => {
    const w = flatWorld(800, { winCelebrationTicks: 30 });
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    a.level = 49;
    w.killTank(b, 'direct', a.id, null);
    expect(w.match.state).toBe('won');
    expect(w.fire(a.id, 60, 50)).toBe(false);
    const events = runTicks(w, 40);
    expect(ofType(events, 'nuke')).toHaveLength(1);
    expect(w.match.state).toBe('playing');
    expect(a.level).toBe(0);
    expect(a.phase).toBe('dead');
    runTicks(w, 120);
    expect(a.phase).toBe('carried');
  });

  it('a level 30 tank explodes on death and is credited for blast kills', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const big = addPlaced(w, 'Big', 900);
    const near = addPlaced(w, 'Near', 940);
    big.level = 30;
    w.killTank(big, 'direct', a.id, null);
    const events = runTicks(w, cfg.deathBlastDelayTicks + 1);
    expect(ofType(events, 'blast')).toHaveLength(1);
    const death = ofType(events, 'death').find((d) => d.tank === near.id)!;
    expect(death.cause).toBe('blast');
    expect(death.killer).toBe(big.id);
  });
});

describe('bots', () => {
  it('play a few minutes without errors and land kills', () => {
    const w = new World({ seed: 7 });
    for (let i = 0; i < 4; i++) w.addTank({ name: `Bot ${i}`, controller: 'bot' });
    const events = runTicks(w, 60 * 180);
    const fires = ofType(events, 'fire').length;
    const kills = ofType(events, 'kill').length;
    expect(fires).toBeGreaterThan(40);
    expect(kills).toBeGreaterThan(3);
    for (const t of w.tanks.values()) {
      expect(Number.isFinite(t.x) && Number.isFinite(t.y)).toBe(true);
    }
  });
});
