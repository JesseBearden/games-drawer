import { advanceShell, barrelTip, clamp, launchVelocity } from './physics';
import { moveSpeed } from './progression';
import type { Rng } from './rng';
import type { Tank } from './types';
import type { World } from './world';

/**
 * Bot brains. Bots play by the same rules as people and are paced like people:
 *
 *   1. After their shell lands (or after they touch down) they pause to react.
 *   2. They pick a target and decide where to aim. The aim point is off by a *distance*
 *      that shrinks with each shot at the same target (bracketing), and never gets small
 *      just because the target is close.
 *   3. They turn the turret, then change power, at the same speeds a held arrow key gives a
 *      person, so big adjustments take visibly longer.
 *   4. They settle briefly, then fire through the same fire() a human input uses.
 */
export interface BotBrain {
  phase: 'idle' | 'aiming' | 'settling';
  /** Earliest tick to start the next action. */
  readyAt: number;
  /** The bot couldn't fire last tick (shell in flight, falling, on the helicopter). */
  blocked: boolean;
  target: number | null;
  /** Aim error as a fraction of the (effective) distance to the target. */
  err: number;
  goalAngle: number;
  goalPower: number;
  /** Tick the current key "hold" started, for human-like acceleration. */
  holdStart: number;
  fireAt: number;
  moveUntil: number;
}

export function createBotBrain(rng: Rng, startErr: number): BotBrain {
  return {
    phase: 'idle',
    readyAt: 0,
    blocked: true,
    target: null,
    err: startErr,
    goalAngle: 60,
    goalPower: 50,
    holdStart: 0,
    fireAt: 0,
    moveUntil: 0,
  };
}

/** Same feel as a held key in the client: a short delay, then 25 rising to 80 units/s. */
const HOLD_DELAY_TICKS = 16;
function holdRate(heldTicks: number) {
  if (heldTicks < HOLD_DELAY_TICKS) return heldTicks === 0 ? 1 : 0;
  const secs = (heldTicks - HOLD_DELAY_TICKS) / 60;
  return (25 + Math.min(1, secs) * 55) / 60;
}

export function botThink(world: World, t: Tank, brain: BotBrain) {
  const cfg = world.cfg;
  const rng = world.rng;
  const tick = world.tick;
  if (tick >= brain.moveUntil && t.move !== 0) world.setMove(t.id, 0);

  if (!world.canFire(t)) {
    // Watching our shell fly, falling, or not landed yet. Start over once we can act.
    brain.blocked = true;
    if (brain.phase !== 'idle') brain.phase = 'idle';
    return;
  }
  if (brain.blocked) {
    brain.blocked = false;
    brain.readyAt = Math.max(brain.readyAt, tick + rng.int(cfg.botReactionMinTicks, cfg.botReactionMaxTicks));
  }

  switch (brain.phase) {
    case 'idle': {
      if (tick < brain.readyAt) return;
      // Occasionally reposition once movement is unlocked.
      if (moveSpeed(cfg, t.level) > 0 && rng.chance(0.15)) {
        world.setMove(t.id, rng.chance(0.5) ? 1 : -1);
        brain.moveUntil = tick + rng.int(30, 90);
        brain.readyAt = brain.moveUntil + rng.int(cfg.botReactionMinTicks, cfg.botReactionMaxTicks);
        return;
      }
      const target = chooseTarget(world, t, brain);
      if (!target) {
        brain.readyAt = tick + 30;
        return;
      }
      // Decide where to aim: the target, plus a miss measured as a distance.
      const dist = Math.abs(target.x - t.x);
      const missStd = brain.err * Math.max(dist, cfg.botAimNearDistance);
      const aimX = clamp(target.x + gauss(rng) * missStd, 5, cfg.worldWidth - 5);
      // Keep roughly the angle we have (mirrored if we now face the other way).
      const current = t.angle > 90 ? 180 - t.angle : t.angle;
      // Aim at the ground where we want it to land (the target itself when the offset is 0).
      const aimY = Math.abs(aimX - target.x) < cfg.tankWidth / 2 ? target.y - cfg.tankBodyHeight / 2 : surfaceNear(world, aimX, target.y);
      const aim = solveAim(world, t, aimX, aimY, current);
      if (!aim) {
        brain.readyAt = tick + 30;
        return;
      }
      brain.goalAngle = Math.round(clamp(aim.angle + gauss(rng) * 0.4, 0, 180) * 10) / 10;
      brain.goalPower = Math.round(clamp(aim.power, cfg.minPower, cfg.maxPower) * 10) / 10;
      brain.phase = 'aiming';
      brain.holdStart = tick;
      return;
    }
    case 'aiming': {
      // One key at a time, like a person: turret first, then power.
      const held = tick - brain.holdStart;
      const rate = holdRate(held);
      const dA = brain.goalAngle - t.angle;
      if (Math.abs(dA) > 0.05) {
        world.setAim(t.id, t.angle + clamp(dA, -rate, rate), t.power);
        if (Math.abs(brain.goalAngle - t.angle) <= 0.05) brain.holdStart = tick + 1;
        return;
      }
      const dP = brain.goalPower - t.power;
      if (Math.abs(dP) > 0.05) {
        world.setAim(t.id, t.angle, t.power + clamp(dP, -rate, rate));
        return;
      }
      brain.phase = 'settling';
      brain.fireAt = tick + rng.int(cfg.botFirePauseMinTicks, cfg.botFirePauseMaxTicks);
      return;
    }
    case 'settling': {
      if (tick < brain.fireAt) return;
      world.fire(t.id);
      brain.err = Math.max(cfg.botAimErrorMin, brain.err * cfg.botAimErrorDecay);
      brain.phase = 'idle';
      return;
    }
  }
}

function alive(t: Tank) {
  return t.phase === 'ground' || t.phase === 'slide' || t.phase === 'air';
}

function chooseTarget(world: World, self: Tank, brain: BotBrain): Tank | null {
  const rng = world.rng;
  const candidates = [...world.tanks.values()].filter((o) => o.id !== self.id && alive(o));
  if (!candidates.length) return null;
  const unprotected = candidates.filter((o) => !world.isProtected(o));
  const pool = unprotected.length ? unprotected : candidates;
  const current = brain.target !== null ? pool.find((o) => o.id === brain.target) : undefined;
  if (current && rng.chance(0.8)) return current;
  // Prefer close and high-level tanks (players gang up on leaders, so bots do too).
  const weights = pool.map((o) => (1 / (1 + Math.abs(o.x - self.x) / 450)) * (1 + o.level / 12));
  let r = rng.next() * weights.reduce((a, b) => a + b, 0);
  let pick = pool[0];
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      pick = pool[i];
      break;
    }
  }
  if (pick.id !== brain.target) {
    brain.target = pick.id;
    brain.err = world.cfg.botAimErrorStart;
  }
  return pick;
}

interface Aim {
  angle: number;
  power: number;
}

/**
 * 'cross': came down through stopBelowY. 'low': never got as high as stopBelowY (too weak).
 * 'terrain' / 'out': hit the ground / left the world.
 */
export type ShotEnd = 'terrain' | 'out' | 'cross' | 'low' | null;

/** Where a shot from `shooter` ends: hitting terrain, leaving the world, or crossing stopBelowY. */
export function simulateShot(world: World, shooter: Tank, angle: number, power: number, ignoreTerrain: boolean, stopBelowY?: number) {
  const cfg = world.cfg;
  const tip = barrelTip(cfg, shooter.x, shooter.y, angle);
  const v = launchVelocity(cfg, angle, power, shooter.level);
  const s = { x: tip.x, y: tip.y, vx: v.vx, vy: v.vy };
  let hit: ShotEnd = null;
  // A shell only "comes down through" a height it actually climbed above.
  let wasAbove = stopBelowY === undefined || s.y < stopBelowY;
  for (let tick = 0; tick < cfg.shellLifetimeTicks && !hit; tick++) {
    advanceShell(cfg, s, world.wind, (p) => {
      if (stopBelowY !== undefined && p.y < stopBelowY) wasAbove = true;
      if (p.x < 0 || p.x >= cfg.worldWidth || p.y >= cfg.worldHeight) {
        hit = wasAbove ? 'out' : 'low';
        return true;
      }
      if (stopBelowY !== undefined && p.vy > 0 && p.y >= stopBelowY) {
        hit = wasAbove ? 'cross' : 'low';
        return true;
      }
      if (!ignoreTerrain && p.y >= 0 && world.terrain.solidAt(p.x, p.y)) {
        hit = 'terrain';
        return true;
      }
      return false;
    });
  }
  return { x: s.x, y: s.y, hit: hit as ShotEnd };
}

/**
 * Angle and power that bring a shell down through (aimX, aimY), avoiding terrain in the way.
 * Like a person, it keeps close to `preferredAngle` (normally the current turret angle) and
 * mostly changes power; it only swings the turret further when a ridge is in the way.
 */
export function solveAim(world: World, self: Tank, aimX: number, aimY: number, preferredAngle = 45): Aim | null {
  const cfg = world.cfg;
  const dir = aimX >= self.x ? 1 : -1;
  // Keep the current angle if it works; otherwise prefer comfortable mid angles to lobs.
  const pref = clamp(Math.round(preferredAngle), 20, 80);
  const COMFORT = 48;
  const others: number[] = [];
  for (let a = 20; a <= 80; a += 6) if (Math.abs(a - pref) >= 3) others.push(a);
  others.sort((a, b) => Math.abs(a - COMFORT) - Math.abs(b - COMFORT));
  // A steep lob forced by a ridge should not become a habit.
  const candidates = pref <= 66 ? [pref, ...others] : others;
  const tolerance = 12;
  let best: Aim | null = null;
  let bestMiss = Infinity;
  for (const a of candidates) {
    const angle = dir > 0 ? a : 180 - a;
    // Binary search power so the arc comes down through aimY at aimX.
    let lo = cfg.minPower;
    let hi = cfg.maxPower;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const r = simulateShot(world, self, angle, mid, true, aimY);
      const short = r.hit === 'low' || (r.hit === 'cross' ? (r.x - aimX) * dir < 0 : r.hit !== 'out' || (r.x - aimX) * dir < 0);
      if (short) lo = mid;
      else hi = mid;
    }
    const power = (lo + hi) / 2;
    // With terrain: does it actually get there, or does a ridge in between catch it?
    const check = simulateShot(world, self, angle, power, false);
    const miss = Math.abs(check.x - aimX) + (check.hit === 'out' ? 1000 : 0);
    if (miss < bestMiss) {
      bestMiss = miss;
      best = { angle, power };
    }
    if (miss <= tolerance) break;
  }
  return best;
}

/** The ground surface in column x nearest to height y (handles cliffs and overhangs). */
function surfaceNear(world: World, x: number, y: number): number {
  const terrain = world.terrain;
  const from = y - 80;
  if (!terrain.solidAt(x, from)) return terrain.groundBelow(x, from);
  // Inside a cliff at that height: walk up to its surface.
  let yy = from;
  while (yy > 0 && terrain.solidAt(x, yy - 1)) yy--;
  return yy;
}

function gauss(rng: Rng) {
  return (rng.next() + rng.next() + rng.next() - 1.5) / 0.5;
}
