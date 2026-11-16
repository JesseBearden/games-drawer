import type { GameConfig } from './config';
import type { Tank } from './types';

export interface Perk {
  level: number;
  key: string;
  label: string;
}

/** The perk ladder. Levels 30 and 35 from the original design are noted but 35 is not built yet. */
export const PERKS: Perk[] = [
  { level: 5, key: 'fastShells', label: 'Shells launch 10% faster' },
  { level: 10, key: 'move', label: 'Movement unlocked (A/D)' },
  { level: 15, key: 'spread', label: 'Every 10th shot is a 3-shell spread' },
  { level: 20, key: 'marker', label: 'Your last shot is marked' },
  { level: 25, key: 'extraLife', label: 'Extra life' },
  { level: 30, key: 'deathBlast', label: 'You explode when destroyed' },
  { level: 40, key: 'fastMove', label: 'Faster movement' },
  { level: 45, key: 'spread5', label: 'Every 5th shot is a spread' },
  { level: 50, key: 'win', label: 'Victory! Nuke incoming' },
];

export const MILESTONE_LEVELS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

export function perksCrossed(before: number, after: number): Perk[] {
  return PERKS.filter((p) => p.level > before && p.level <= after);
}

/** 0 = no spreads; otherwise every Nth shot is a spread. */
export function spreadCadence(level: number) {
  if (level >= 45) return 5;
  if (level >= 15) return 10;
  return 0;
}

export function spreadReady(t: Pick<Tank, 'level' | 'shotsUntilSpread'>) {
  return spreadCadence(t.level) > 0 && t.shotsUntilSpread <= 0;
}

export function moveSpeed(cfg: GameConfig, level: number) {
  if (level >= 40) return cfg.moveSpeedFast;
  if (level >= 10) return cfg.moveSpeedSlow;
  return 0;
}

export function hasMarker(level: number) {
  return level >= 20;
}

export function deathsAllowed(cfg: GameConfig, t: Pick<Tank, 'extraLife'>) {
  return cfg.deathsPerRun + (t.extraLife ? 1 : 0);
}

/** Levels awarded for a credited kill. `victimLevel` is null for helicopter kills. */
export function levelsForKill(cfg: GameConfig, victimLevel: number | null) {
  if (!cfg.bountyMode || victimLevel === null) return 1;
  return Math.max(1, Math.floor(victimLevel / 5));
}
