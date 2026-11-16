/**
 * Every tunable gameplay number lives here. The server sends its config to clients on join,
 * so clients always simulate shells and terrain with the server's values.
 *
 * World units: x grows right, y grows DOWN (canvas convention). One terrain cell = 1 unit.
 */
export interface GameConfig {
  // World
  worldWidth: number;
  worldHeight: number;
  /** Solid rows at the bottom of the world that can never be carved. */
  bedrock: number;
  tickRate: number;
  /** Server sends a state message every N ticks. */
  stateEvery: number;

  // Tank geometry (body height is the "tank height" reference unit)
  tankWidth: number;
  tankBodyHeight: number;
  /** Height of the turret pivot above the tank's ground point. */
  turretPivotHeight: number;
  barrelLength: number;
  maxSettleSlopeDeg: number;
  /** A tank can step up onto ledges this tall while moving or settling. */
  stepUp: number;
  slideSpeed: number;
  gravity: number;
  maxFallSpeed: number;
  /** Lethal fall threshold, in tank body heights of vertical drop. */
  lethalFallBodyHeights: number;

  // Shooting
  maxShellSpeed: number;
  minPower: number;
  maxPower: number;
  shellLifetimeTicks: number;
  shellSubstep: number;
  craterRadius: number;
  /** Crater radius grows by this per kill in the run, capped. 0 disables. */
  craterGrowthPerKill: number;
  craterGrowthMax: number;
  spreadAngleDeg: number;

  // Wind. Rooms roll an integer wind speed in [-windMaxSpeed, windMaxSpeed] (positive pushes
  // right); shells accelerate sideways by speed * windAccelPerUnit units/s^2.
  windMaxSpeed: number;
  windAccelPerUnit: number;
  /** 0 = steady for the whole match. Otherwise wind re-rolls every N seconds. */
  windChangeSeconds: number;

  // Terrain collapse
  /** Solid runs thinner than this (per column) crumble away. 0 disables. */
  minSliverThickness: number;
  /** Detached chunks of dirt fall. */
  detachedDirtFalls: boolean;

  // Helicopter + spawning
  heliSpeed: number;
  heliAltitude: number;
  /** Auto-drop when this fraction of the pass is done. */
  autoDropAt: number;
  parachuteSpeed: number;
  respawnDelayTicks: number;
  spawnProtectionSeconds: number;
  heliHitWidth: number;
  heliHitHeight: number;

  // Movement (unlocked by perks)
  moveSpeedSlow: number;
  moveSpeedFast: number;

  // Progression
  bountyMode: boolean;
  deathsPerRun: number;
  winLevel: number;
  winCelebrationTicks: number;
  deathBlastEnabled: boolean;
  deathBlastRadius: number;
  deathBlastDelayTicks: number;

  // Bots
  botMinTanks: number;
  botThinkMinTicks: number;
  botThinkMaxTicks: number;

  // Rooms
  maxTanksPerRoom: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  worldWidth: 1800,
  worldHeight: 1000,
  bedrock: 24,
  tickRate: 60,
  stateEvery: 3,

  tankWidth: 36,
  tankBodyHeight: 18,
  turretPivotHeight: 20,
  barrelLength: 27,
  maxSettleSlopeDeg: 30,
  stepUp: 6,
  slideSpeed: 70,
  gravity: 1000,
  maxFallSpeed: 900,
  lethalFallBodyHeights: 6,

  maxShellSpeed: 1340,
  minPower: 5,
  maxPower: 100,
  shellLifetimeTicks: 60 * 8,
  shellSubstep: 3,
  craterRadius: 26,
  craterGrowthPerKill: 0,
  craterGrowthMax: 10,
  spreadAngleDeg: 6,

  windMaxSpeed: 15,
  windAccelPerUnit: 8,
  windChangeSeconds: 0,

  minSliverThickness: 4,
  detachedDirtFalls: true,

  heliSpeed: 170,
  heliAltitude: 70,
  autoDropAt: 0.9,
  parachuteSpeed: 160,
  respawnDelayTicks: 90,
  spawnProtectionSeconds: 15,
  heliHitWidth: 64,
  heliHitHeight: 30,

  moveSpeedSlow: 30,
  moveSpeedFast: 60,

  bountyMode: false,
  deathsPerRun: 3,
  winLevel: 50,
  winCelebrationTicks: 60 * 6,
  deathBlastEnabled: true,
  deathBlastRadius: 70,
  deathBlastDelayTicks: 60,

  botMinTanks: 4,
  botThinkMinTicks: 90,
  botThinkMaxTicks: 200,

  maxTanksPerRoom: 10,
};

export function lethalFallDistance(cfg: GameConfig) {
  return cfg.lethalFallBodyHeights * cfg.tankBodyHeight;
}
