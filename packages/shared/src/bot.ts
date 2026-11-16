import { advanceShell, barrelTip, inBox, launchVelocity, tankHitbox } from './physics';
import { moveSpeed } from './progression';
import type { Rng } from './rng';
import type { Tank } from './types';
import type { World } from './world';

/**
 * Bot brains. Bots play by the same rules as people: they choose an angle and power and
 * call the same fire() a human input would. They aim by simulating candidate shots, then add
 * error that shrinks while they keep shooting at the same target (like a person bracketing).
 */
export interface BotBrain {
  nextThink: number;
  target: number | null;
  /** Fractional aim error; shrinks with repeated shots at one target. */
  err: number;
  moveUntil: number;
}

const START_ERR = 0.2;
const MIN_ERR = 0.03;

export function createBotBrain(rng: Rng): BotBrain {
  return { nextThink: rng.int(60, 150), target: null, err: START_ERR, moveUntil: 0 };
}

export function botThink(world: World, t: Tank, brain: BotBrain) {
  if (world.tick >= brain.moveUntil && t.move !== 0) world.setMove(t.id, 0);
  if (world.tick < brain.nextThink) return;
  if (!world.canFire(t)) return;
  const cfg = world.cfg;
  const rng = world.rng;
  brain.nextThink = world.tick + rng.int(cfg.botThinkMinTicks, cfg.botThinkMaxTicks);

  // Occasionally reposition once movement is unlocked.
  if (moveSpeed(cfg, t.level) > 0 && rng.chance(0.15)) {
    world.setMove(t.id, rng.chance(0.5) ? 1 : -1);
    brain.moveUntil = world.tick + rng.int(30, 90);
    return;
  }

  const target = chooseTarget(world, t, brain);
  if (!target) return;
  const aim = solveAim(world, t, target);
  if (!aim) return;
  const angle = aim.angle + gauss(rng) * brain.err * 18;
  const power = aim.power * (1 + gauss(rng) * brain.err);
  world.fire(t.id, angle, power);
  brain.err = Math.max(MIN_ERR, brain.err * 0.72);
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
    brain.err = START_ERR;
  }
  return pick;
}

interface Aim {
  angle: number;
  power: number;
}

/** Where a shot would first hit, ignoring other tanks except the target. */
export function simulateShot(world: World, shooter: Tank, angle: number, power: number, target: Tank | null, ignoreTerrain: boolean, stopBelowY?: number) {
  const cfg = world.cfg;
  const tip = barrelTip(cfg, shooter.x, shooter.y, angle);
  const v = launchVelocity(cfg, angle, power, shooter.level);
  const s = { x: tip.x, y: tip.y, vx: v.vx, vy: v.vy };
  const box = target ? tankHitbox(cfg, target) : null;
  let hit: 'target' | 'terrain' | 'out' | 'cross' | null = null;
  for (let tick = 0; tick < cfg.shellLifetimeTicks && !hit; tick++) {
    advanceShell(cfg, s, world.wind, (p) => {
      if (p.x < 0 || p.x >= cfg.worldWidth || p.y >= cfg.worldHeight) {
        hit = 'out';
        return true;
      }
      if (box && inBox(box, p.x, p.y)) {
        hit = 'target';
        return true;
      }
      if (stopBelowY !== undefined && p.vy > 0 && p.y >= stopBelowY) {
        hit = 'cross';
        return true;
      }
      if (!ignoreTerrain && p.y >= 0 && world.terrain.solidAt(p.x, p.y)) {
        hit = 'terrain';
        return true;
      }
      return false;
    });
  }
  return { x: s.x, y: s.y, hit: hit as 'target' | 'terrain' | 'out' | 'cross' | null };
}

export function solveAim(world: World, self: Tank, target: Tank): Aim | null {
  const cfg = world.cfg;
  const dir = target.x >= self.x ? 1 : -1;
  const baseAngles = [22, 32, 42, 52, 62, 72, 80];
  const targetY = target.y - cfg.tankBodyHeight / 2;
  let best: Aim | null = null;
  let bestMiss = Infinity;
  for (const a of baseAngles) {
    const angle = dir > 0 ? a : 180 - a;
    // Binary search power so the arc crosses the target height at the target's x.
    let lo = cfg.minPower;
    let hi = cfg.maxPower;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const r = simulateShot(world, self, angle, mid, null, true, targetY);
      const short = r.hit === 'cross' ? (r.x - target.x) * dir < 0 : r.hit !== 'out' || (r.x - target.x) * dir < 0;
      if (short) lo = mid;
      else hi = mid;
    }
    const power = (lo + hi) / 2;
    const check = simulateShot(world, self, angle, power, target, false);
    const miss = check.hit === 'target' ? 0 : Math.hypot(check.x - target.x, check.y - targetY);
    if (miss < bestMiss) {
      bestMiss = miss;
      best = { angle, power };
    }
    if (miss === 0) break;
  }
  return best;
}

function gauss(rng: Rng) {
  return (rng.next() + rng.next() + rng.next() - 1.5) / 0.5;
}
