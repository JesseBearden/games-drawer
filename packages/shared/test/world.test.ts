import { describe, expect, it } from 'vitest';
import { lethalFallDistance } from '../src/config';
import { PERK_LEVEL, spreadReady } from '../src/progression';
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
    const events = runTicks(w, 60 * 6);
    expect(ofType(events, 'explode')).toHaveLength(1);
    expect(w.canFire(a)).toBe(true);
  });

  it('a mid-range shot takes about two seconds', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    w.fire(a.id, 45, 40);
    const startX = w.shells[0].x;
    let ticks = 0;
    let landedX = 0;
    while (a.shellsInFlight > 0 && ticks < 900) {
      for (const e of w.step()) if (e.type === 'explode') landedX = e.x;
      ticks++;
    }
    // About 500 units away, landing after roughly two seconds.
    expect(landedX - startX).toBeGreaterThan(400);
    expect(landedX - startX).toBeLessThan(650);
    expect(ticks / 60).toBeGreaterThan(1.6);
    expect(ticks / 60).toBeLessThan(2.6);
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
    b.level = 4;
    w.setMove(b.id, 1);
    const events = runTicks(w, 60 * 14);
    expect(ofType(events, 'death')).toHaveLength(0);
    expect(b.x).toBeGreaterThan(900);
  });

  it('walking off a high cliff is an environmental death', () => {
    const terrain = terrainFrom((x) => (x < 600 ? 500 : 900));
    const w = new World({ cfg, seed: 1, wind: 0, terrain });
    const b = addPlaced(w, 'B', 585);
    b.level = 4;
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

describe('driving and dropping', () => {
  it('drives up a 40 degree hill, and slides back once parked on it', () => {
    // 40 degrees up to the left: surface rises as x decreases.
    const terrain = terrainFrom((x) => Math.round(Math.min(800, Math.max(300, 800 - (900 - x) * Math.tan((40 * Math.PI) / 180)))));
    const w = new World({ cfg, seed: 1, wind: 0, terrain });
    const t = addPlaced(w, 'T', 920);
    t.level = 4;
    const startY = t.y;
    w.setMove(t.id, -1);
    runTicks(w, 60 * 4);
    expect(t.phase).toBe('ground');
    expect(t.x).toBeLessThan(800);
    expect(t.y).toBeLessThan(startY - 50);
    w.setMove(t.id, 0);
    runTicks(w, 3);
    expect(t.phase).toBe('slide');
  });

  it('a 50 degree hill is still too steep to drive up', () => {
    const terrain = terrainFrom((x) => Math.round(Math.min(800, Math.max(300, 800 - (900 - x) * Math.tan((50 * Math.PI) / 180)))));
    const w = new World({ cfg, seed: 1, wind: 0, terrain });
    const t = addPlaced(w, 'T', 920);
    t.level = 4;
    w.setMove(t.id, -1);
    runTicks(w, 60 * 4);
    expect(t.x).toBeGreaterThan(880);
  });

  it('a parachute dropped right over another tank drifts away before landing', () => {
    const w = flatWorld(800);
    const sitter = addPlaced(w, 'Sitter', 900);
    const t = w.addTank({ name: 'Dropper', controller: 'human' });
    w.step();
    // Fly the helicopter to just above the sitter, then drop.
    const heli = w.helis.find((h) => h.tankId === t.id)!;
    heli.x = 900;
    t.x = 900;
    expect(w.requestDrop(t.id)).toBe(true);
    runTicks(w, 60 * 6);
    expect(t.phase).toBe('ground');
    expect(Math.abs(t.x - sitter.x)).toBeGreaterThanOrEqual(cfg.dropSpacing - 2);
  });
});

describe('progression', () => {
  it('three deaths reset the run and its perks', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    b.level = 6;
    b.kills = 2;
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

  it('reaching the extra-life level grants a fourth life even with two deaths', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    a.level = PERK_LEVEL.extraLife - 1;
    a.deaths = 2;
    w.killTank(b, 'direct', a.id, null);
    expect(a.level).toBe(PERK_LEVEL.extraLife);
    expect(a.extraLife).toBe(true);
    w.killTank(a, 'direct', b.id, null);
    runTicks(w, 1);
    expect(a.deaths).toBe(3);
    expect(a.level).toBe(PERK_LEVEL.extraLife);
    a.phase = 'ground';
    w.killTank(a, 'direct', b.id, null);
    expect(a.deaths).toBe(0);
    expect(a.level).toBe(0);
    expect(a.extraLife).toBe(false);
  });

  it('every 3rd shot is a triple, then a quintuple at the next perk, each counting as one shot', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const victim = addPlaced(w, 'V', 1500);
    a.level = PERK_LEVEL.triple - 1;
    w.killTank(victim, 'direct', a.id, null);
    expect(a.level).toBe(PERK_LEVEL.triple);
    const fireOnce = () => {
      w.step();
      const ready = spreadReady(a);
      const before = w.shells.length;
      expect(w.fire(a.id, 80, 30)).toBe(true);
      const n = w.shells.length - before;
      expect(ready).toBe(n > 1);
      runTicks(w, 260);
      return n;
    };
    const triples = Array.from({ length: 6 }, fireOnce);
    expect(triples).toEqual([1, 1, 3, 1, 1, 3]);
    a.level = PERK_LEVEL.quintuple - 1;
    victim.phase = 'ground';
    w.killTank(victim, 'direct', a.id, null);
    expect(a.level).toBe(PERK_LEVEL.quintuple);
    const quints = Array.from({ length: 6 }, fireOnce);
    expect(quints).toEqual([1, 1, 5, 1, 1, 5]);
    expect(a.shotsFired).toBe(12);
  });

  it('bounty: kills over 3, 6 and 9 are worth 2, 3 and 4 levels', () => {
    const cases: [number, number][] = [
      [0, 1],
      [3, 1],
      [4, 2],
      [6, 2],
      [7, 3],
      [9, 3],
      [10, 4],
      [25, 4],
    ];
    for (const [victimKills, expected] of cases) {
      const w = flatWorld(800);
      const a = addPlaced(w, 'A', 300);
      const b = addPlaced(w, 'B', 900);
      b.kills = victimKills;
      w.killTank(b, 'direct', a.id, null);
      expect(a.level, `victim with ${victimKills} kills`).toBe(expected);
      expect(a.kills).toBe(1);
    }
  });

  it('a bounty that jumps several levels grants every perk crossed', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    a.level = 3;
    b.kills = 10;
    w.killTank(b, 'direct', a.id, null);
    const events = runTicks(w, 1);
    expect(a.level).toBe(7);
    expect(a.extraLife).toBe(true);
    expect(a.shotsUntilSpread).toBe(2);
    expect(ofType(events, 'milestone').map((m) => m.level)).toEqual([4, 5, 6, 7]);
  });

  it('the win level ends the round (bounties cap there), then a nuke resets terrain and everyone', () => {
    const w = flatWorld(800, { winCelebrationTicks: 30 });
    expect(w.cfg.winLevel).toBe(10);
    const a = addPlaced(w, 'A', 300);
    const b = addPlaced(w, 'B', 900);
    a.level = w.cfg.winLevel - 1;
    b.kills = 10;
    w.killTank(b, 'direct', a.id, null);
    expect(a.level).toBe(w.cfg.winLevel);
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

  it('a tank at the death-blast level explodes on death and is credited for blast kills', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const big = addPlaced(w, 'Big', 900);
    const near = addPlaced(w, 'Near', 960);
    big.level = PERK_LEVEL.deathBlast;
    w.killTank(big, 'direct', a.id, null);
    const events = runTicks(w, cfg.deathBlastDelayTicks + 1);
    expect(ofType(events, 'blast')).toHaveLength(1);
    const death = ofType(events, 'death').find((d) => d.tank === near.id)!;
    expect(death.cause).toBe('blast');
    expect(death.killer).toBe(big.id);
  });

  it('a tank below the death-blast level does not explode', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const t = addPlaced(w, 'T', 900);
    t.level = PERK_LEVEL.deathBlast - 1;
    w.killTank(t, 'direct', a.id, null);
    expect(ofType(runTicks(w, cfg.deathBlastDelayTicks + 5), 'blast')).toHaveLength(0);
  });
});


describe('bot pacing', () => {
  it('waits after its shell lands, turns the turret at human speed, then fires', () => {
    const w = flatWorld(800);
    const bot = addPlaced(w, 'Bot', 300, 'bot');
    addPlaced(w, 'Target', 1100);
    // A fresh bot starts out "blocked", so it reacts before its first shot too.
    bot.angle = 150; // facing the wrong way: a big turn is needed
    let lastLanded = w.tick;
    let lastAngle = bot.angle;
    let maxTurnPerTick = 0;
    const gaps: number[] = [];
    for (let i = 0; i < 60 * 40; i++) {
      for (const e of w.step()) {
        if (e.type === 'fire' && e.tank === bot.id) gaps.push(e.tick - lastLanded);
        if (e.type === 'explode' && e.owner === bot.id) lastLanded = e.tick;
        if (e.type === 'shellGone') lastLanded = e.tick;
      }
      maxTurnPerTick = Math.max(maxTurnPerTick, Math.abs(bot.angle - lastAngle));
      lastAngle = bot.angle;
    }
    expect(gaps.length).toBeGreaterThan(3);
    // Never fires sooner than the reaction pause plus the pause before firing.
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(cfg.botReactionMinTicks + cfg.botFirePauseMinTicks);
    // The turret never moves faster than a held key (80 degrees/second).
    expect(maxTurnPerTick).toBeLessThanOrEqual(80 / 60 + 0.11);
  });

  it('a bot that lands right next to you rarely hits with its first shot', () => {
    let firstShots = 0;
    let firstHits = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const w = new World({ cfg, seed, wind: 0, terrain: terrainFrom(() => 800) });
      const bot = addPlaced(w, 'Bot', 600, 'bot');
      const target = addPlaced(w, 'Target', 760);
      for (let i = 0; i < 60 * 12 && firstShots < seed; i++) {
        for (const e of w.step()) {
          if (e.type === 'fire' && e.tank === bot.id) firstShots++;
          if (e.type === 'explode' && e.owner === bot.id) {
            if (e.hitTank === target.id) firstHits++;
            i = 1e9;
          }
        }
      }
    }
    expect(firstShots).toBeGreaterThan(30);
    expect(firstHits / firstShots).toBeLessThan(0.2);
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
