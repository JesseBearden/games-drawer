import type { GameConfig } from './config';
import type { Tank } from './types';

/** The level each perk unlocks at. The win level is GameConfig.winLevel (10). */
export const PERK_LEVEL = {
  fastShells: 3,
  move: 4,
  triple: 5,
  extraLife: 6,
  deathBlast: 7,
  fastMove: 8,
  quintuple: 9,
} as const;

export interface Perk {
  level: number;
  key: string;
  label: string;
}

export function perks(cfg: Pick<GameConfig, 'winLevel'>): Perk[] {
  return [
    { level: PERK_LEVEL.fastShells, key: 'fastShells', label: 'Faster shells' },
    { level: PERK_LEVEL.move, key: 'move', label: 'Tank movement unlocked' },
    { level: PERK_LEVEL.triple, key: 'triple', label: 'Every 3rd shot is a triple' },
    { level: PERK_LEVEL.extraLife, key: 'extraLife', label: 'Extra life!' },
    { level: PERK_LEVEL.deathBlast, key: 'deathBlast', label: 'You explode when destroyed' },
    { level: PERK_LEVEL.fastMove, key: 'fastMove', label: 'Faster tank movement' },
    { level: PERK_LEVEL.quintuple, key: 'quintuple', label: 'Every 3rd shot is a quintuple' },
    { level: cfg.winLevel, key: 'win', label: 'Nuke triggered!' },
  ];
}

/** Levels that count as milestones in analytics: every perk plus the win. */
export function milestoneLevels(cfg: Pick<GameConfig, 'winLevel'>): number[] {
  return perks(cfg).map((p) => p.level);
}

export function perksCrossed(cfg: Pick<GameConfig, 'winLevel'>, before: number, after: number): Perk[] {
  return perks(cfg).filter((p) => p.level > before && p.level <= after);
}

/** Every Nth shot is a spread; 0 = no spreads yet. */
export const SPREAD_CADENCE = 3;

export function spreadCadence(level: number) {
  return level >= PERK_LEVEL.triple ? SPREAD_CADENCE : 0;
}

/** Shells in a spread volley at this level (1 = no spread unlocked). */
export function spreadSize(level: number) {
  if (level >= PERK_LEVEL.quintuple) return 5;
  if (level >= PERK_LEVEL.triple) return 3;
  return 1;
}

export function spreadReady(t: Pick<Tank, 'level' | 'shotsUntilSpread'>) {
  return spreadCadence(t.level) > 0 && t.shotsUntilSpread <= 0;
}

export function moveSpeed(cfg: GameConfig, level: number) {
  if (level >= PERK_LEVEL.fastMove) return cfg.moveSpeedFast;
  if (level >= PERK_LEVEL.move) return cfg.moveSpeedSlow;
  return 0;
}

export function hasDeathBlast(level: number) {
  return level >= PERK_LEVEL.deathBlast;
}

export function deathsAllowed(cfg: GameConfig, t: Pick<Tank, 'extraLife'>) {
  return cfg.deathsPerRun + (t.extraLife ? 1 : 0);
}

/**
 * Levels for killing a tank with `victimKills` kills in its current run. Bounty tiers pay
 * more for dangerous tanks. Helicopter kills (victimKills null) are always worth 1.
 */
export function levelsForKill(cfg: GameConfig, victimKills: number | null) {
  if (!cfg.bountyMode || victimKills === null) return 1;
  let levels = 1;
  for (const [over, award] of cfg.bountyTiers) if (victimKills > over) levels = Math.max(levels, award);
  return levels;
}
