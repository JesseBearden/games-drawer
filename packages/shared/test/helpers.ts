import { DEFAULT_CONFIG, type GameConfig } from '../src/config';
import { Terrain } from '../src/terrain';
import type { Tank } from '../src/types';
import { World } from '../src/world';

export const cfg: GameConfig = { ...DEFAULT_CONFIG };

/** Terrain whose surface height per column comes from `surfaceAt`. */
export function terrainFrom(surfaceAt: (x: number) => number, c: GameConfig = cfg): Terrain {
  const cols: number[][] = [];
  const surface: number[] = [];
  for (let x = 0; x < c.worldWidth; x++) {
    const s = surfaceAt(x);
    cols.push([s, c.worldHeight]);
    surface.push(s);
  }
  return new Terrain(c.worldWidth, c.worldHeight, c.bedrock, cols, surface);
}

export function flatWorld(y = 800, opts: Partial<GameConfig> = {}): World {
  const c = { ...cfg, ...opts };
  return new World({ cfg: c, seed: 42, wind: 0, terrain: terrainFrom(() => y, c) });
}

/** Put a tank straight onto the ground, settled and unprotected. */
export function placeTank(world: World, t: Tank, x: number) {
  t.phase = 'ground';
  t.x = x;
  t.y = world.terrain.groundBelow(x, 0);
  t.fallStartY = null;
  t.fallCause = null;
  t.awaitingProtection = false;
  t.protectedUntil = 0;
  world.helis = world.helis.filter((h) => h.tankId !== t.id);
}

export function addPlaced(world: World, name: string, x: number, controller: 'human' | 'bot' = 'human'): Tank {
  const t = world.addTank({ name, controller });
  placeTank(world, t, x);
  return t;
}

/** Drop a shell straight down onto (x, y) from just above it. */
export function dropShellAt(world: World, owner: number, x: number, y: number) {
  world.shells.push({
    id: 9000 + world.shells.length,
    owner,
    x,
    y: y - 4,
    vx: 0,
    vy: 120,
    bornTick: world.tick - 100,
    ownerController: 'human',
    volley: 999,
  });
  const o = world.tanks.get(owner);
  if (o) o.shellsInFlight++;
}

export function runTicks(world: World, n: number) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...world.step());
  return events;
}
