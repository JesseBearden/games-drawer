import type { GameConfig } from './config';
import { PERK_LEVEL } from './progression';
import type { Point, Tank } from './types';

const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Shell speed multiplier from perks (faster shells: 10% more launch speed). */
export function shellSpeedMultiplier(level: number) {
  return level >= PERK_LEVEL.fastShells ? 1.1 : 1;
}

export function turretPivot(cfg: GameConfig, x: number, y: number): Point {
  return { x, y: y - cfg.turretPivotHeight };
}

export function barrelTip(cfg: GameConfig, x: number, y: number, angleDeg: number): Point {
  const p = turretPivot(cfg, x, y);
  return {
    x: p.x + Math.cos(angleDeg * DEG) * cfg.barrelLength,
    y: p.y - Math.sin(angleDeg * DEG) * cfg.barrelLength,
  };
}

export function launchVelocity(cfg: GameConfig, angleDeg: number, power: number, level: number) {
  const speed = (power / 100) * cfg.maxShellSpeed * shellSpeedMultiplier(level);
  return { vx: Math.cos(angleDeg * DEG) * speed, vy: -Math.sin(angleDeg * DEG) * speed };
}

export function windAccel(cfg: GameConfig, windSpeed: number) {
  return windSpeed * cfg.windAccelPerUnit;
}

export interface MovingPoint {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Advance a shell by one tick using fixed sub-steps. `onSubstep` returns true to stop
 * (the shell hit something). Uses only + - * / and sqrt so client replays match the server.
 */
export function advanceShell(
  cfg: GameConfig,
  s: MovingPoint,
  wind: number,
  onSubstep?: (s: MovingPoint) => boolean,
): boolean {
  const dt = 1 / cfg.tickRate;
  const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
  const n = Math.max(1, Math.ceil((speed * dt) / cfg.shellSubstep));
  const h = dt / n;
  const ax = windAccel(cfg, wind);
  for (let i = 0; i < n; i++) {
    s.vx += ax * h;
    s.vy += cfg.shellGravity * h;
    s.x += s.vx * h;
    s.y += s.vy * h;
    if (onSubstep && onSubstep(s)) return true;
  }
  return false;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Direct-hit box: body plus turret dome, with a little forgiveness. */
export function tankHitbox(cfg: GameConfig, t: Pick<Tank, 'x' | 'y'>): Box {
  const hw = cfg.tankWidth / 2;
  return { x0: t.x - hw, x1: t.x + hw, y0: t.y - cfg.tankBodyHeight - 9, y1: t.y + 1 };
}

export function inBox(b: Box, x: number, y: number) {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

/** Offset from helicopter centre to the hanging tank's ground point (rope length plus tank height). */
export const HELI_TANK_OFFSET = 58;
