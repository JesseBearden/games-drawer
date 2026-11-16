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
  /** While driving, the tracks grip slopes up to this steep (parked tanks use the settle slope). */
  maxClimbSlopeDeg: number;
  /** A tank can step up onto ledges this tall while moving or settling. */
  stepUp: number;
  slideSpeed: number;
  /** Gravity for falling tanks (shells use shellGravity). */
  gravity: number;
  maxFallSpeed: number;
  /** Lethal fall threshold, in tank body heights of vertical drop. */
  lethalFallBodyHeights: number;

  // Shooting. To change how fast shells travel without changing where shots land, scale
  // maxShellSpeed by k and both shellGravity and windAccelPerUnit by k squared.
  maxShellSpeed: number;
  shellGravity: number;
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
  /**
   * A ledge may stick out at most this many times its own thickness past where it is
   * supported; anything further crumbles. 0 = no limit (any attached overhang stays).
   */
  maxOverhangRatio: number;

  // Helicopter + spawning
  heliSpeed: number;
  heliAltitude: number;
  /** Each pass flies at heliAltitude plus or minus up to this much. */
  heliAltitudeJitter: number;
  /** Auto-drop when this fraction of the pass is done. */
  autoDropAt: number;
  parachuteSpeed: number;
  /** Parachutes drift apart until landing at least this far (horizontally) from other tanks. */
  dropSpacing: number;
  chuteDriftSpeed: number;
  respawnDelayTicks: number;
  spawnProtectionSeconds: number;
  heliHitWidth: number;
  heliHitHeight: number;

  // Movement (unlocked by perks)
  moveSpeedSlow: number;
  moveSpeedFast: number;

  // Progression. Perk levels live in progression.ts (PERK_LEVEL).
  bountyMode: boolean;
  /**
   * Bounty tiers as [kills over, levels]: killing a tank with more than that many kills in
   * its run awards that many levels. Without a matching tier a kill is worth 1.
   */
  bountyTiers: [number, number][];
  deathsPerRun: number;
  winLevel: number;
  winCelebrationTicks: number;
  deathBlastEnabled: boolean;
  deathBlastRadius: number;
  deathBlastDelayTicks: number;

  // Bots. Each shot aims at a point off the target by a random distance with standard
  // deviation err * max(distance to target, botAimNearDistance). err starts at Start for a
  // new target and shrinks by Decay each shot, down to Min. Close targets are treated as
  // botAimNearDistance away, so a bot that lands next to you does not hit first time.
  botMinTanks: number;
  botAimErrorStart: number;
  botAimErrorMin: number;
  botAimErrorDecay: number;
  botAimNearDistance: number;
  /** Pause after their shell lands (or after touching down) before they start aiming. */
  botReactionMinTicks: number;
  botReactionMaxTicks: number;
  /** Pause between finishing aiming and firing. */
  botFirePauseMinTicks: number;
  botFirePauseMaxTicks: number;

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
  maxClimbSlopeDeg: 45,
  stepUp: 6,
  slideSpeed: 70,
  gravity: 1000,
  maxFallSpeed: 900,
  lethalFallBodyHeights: 6,

  // Shell gravity and wind are a quarter of the original, so a shot to any given spot flies
  // half as fast (about 2s for a typical shot). 100% power reaches about 1.8x the world width
  // on flat ground, so steep lobs can still clear tall ridges.
  maxShellSpeed: 905,
  shellGravity: 250,
  minPower: 5,
  maxPower: 100,
  shellLifetimeTicks: 60 * 14,
  shellSubstep: 3,
  craterRadius: 26,
  craterGrowthPerKill: 0,
  craterGrowthMax: 10,
  spreadAngleDeg: 6,

  windMaxSpeed: 15,
  windAccelPerUnit: 2,
  windChangeSeconds: 0,

  minSliverThickness: 4,
  detachedDirtFalls: true,
  maxOverhangRatio: 0,

  heliSpeed: 170,
  heliAltitude: 75,
  heliAltitudeJitter: 30,
  autoDropAt: 0.9,
  parachuteSpeed: 160,
  dropSpacing: 200,
  chuteDriftSpeed: 120,
  respawnDelayTicks: 90,
  spawnProtectionSeconds: 15,
  heliHitWidth: 64,
  heliHitHeight: 30,

  moveSpeedSlow: 40,
  moveSpeedFast: 75,

  bountyMode: true,
  // "Over 3 kills" = 4 or more. Use [2, 2], [5, 3], [8, 4] for "3 or more" and so on.
  bountyTiers: [
    [3, 2],
    [6, 3],
    [9, 4],
  ],
  deathsPerRun: 3,
  winLevel: 10,
  winCelebrationTicks: 60 * 6,
  deathBlastEnabled: true,
  // Level-7 perk: a large blast (shell craters are 26).
  deathBlastRadius: 90,
  deathBlastDelayTicks: 60,

  botMinTanks: 4,
  // Tuned with scripts/bot-accuracy.ts.
  botAimErrorStart: 0.42,
  botAimErrorMin: 0.1,
  botAimErrorDecay: 0.87,
  botAimNearDistance: 500,
  botReactionMinTicks: 60,
  botReactionMaxTicks: 150,
  botFirePauseMinTicks: 8,
  botFirePauseMaxTicks: 25,

  maxTanksPerRoom: 4,
};

export function lethalFallDistance(cfg: GameConfig) {
  return cfg.lethalFallBodyHeights * cfg.tankBodyHeight;
}
