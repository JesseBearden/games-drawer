/** Simulation state shapes shared by the server simulation and the client renderer. */

export type TankPhase =
  /** Hanging under a helicopter. Invulnerable. */
  | 'carried'
  /** Parachute descent. Invulnerable. */
  | 'chute'
  /** Free fall. */
  | 'air'
  /** Sliding on ground steeper than the settle slope, or tipping off an edge. */
  | 'slide'
  /** Settled on the ground. */
  | 'ground'
  /** Destroyed, waiting for the respawn helicopter. */
  | 'dead';

export type ControllerKind = 'human' | 'bot';

export type DeathCause = 'direct' | 'fall' | 'blast' | 'environment';

export interface Point {
  x: number;
  y: number;
}

export interface Tank {
  id: number;
  color: number;
  name: string;
  controller: ControllerKind;
  /** Bottom-centre of the tank, world units. */
  x: number;
  y: number;
  vy: number;
  phase: TankPhase;
  /** Turret angle in degrees: 0 = right, 90 = straight up, 180 = left. */
  angle: number;
  /** 0..100 */
  power: number;
  /** Movement input: -1 left, 0 none, 1 right. */
  move: -1 | 0 | 1;
  /** Cosmetic body tilt in radians, follows the ground. */
  tilt: number;

  // Fall tracking
  /** y where the current fall/slide started, null while settled. */
  fallStartY: number | null;
  /** Tank credited if the current fall is lethal. */
  fallCause: number | null;

  // Protection
  /** Spawn protection lasts until this tick (exclusive). */
  protectedUntil: number;
  /** True after a drop until the tank first settles; protection starts on settle. */
  awaitingProtection: boolean;

  // Shooting
  /** Shells from the current firing action still in flight. */
  shellsInFlight: number;
  shotsFired: number;
  /** Regular shots left before the next spread volley (only meaningful at spread levels). */
  shotsUntilSpread: number;
  lastImpact: Point | null;

  // Run / progression
  runId: number;
  runStartTick: number;
  kills: number;
  level: number;
  deaths: number;
  extraLife: boolean;

  // Lifecycle
  respawnAt: number;
  /** Pending death blast detonation tick, or 0. */
  blastAt: number;
  blastPos: Point | null;
  /** Set whenever slow-changing fields change; the server broadcasts and clears it. */
  infoDirty: boolean;
}

export interface Shell {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornTick: number;
  /** Controller of the shooter when fired, for analytics. */
  ownerController: ControllerKind;
  /** Spread volleys share a volley id; the volley is one shot. */
  volley: number;
}

export interface Helicopter {
  id: number;
  tankId: number;
  x: number;
  y: number;
  dir: 1 | -1;
  carrying: boolean;
  /** Bots release here; humans release on input. */
  dropX: number | null;
}

/** Initial state needed to replay a shell locally. */
export interface ShellLaunch {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type GameEvent =
  | { type: 'fire'; tick: number; tank: number; shells: ShellLaunch[]; spread: boolean; controller: ControllerKind; level: number }
  | {
      type: 'explode';
      tick: number;
      shell: number;
      owner: number;
      x: number;
      y: number;
      /** Crater radius; 0 if no terrain was carved. */
      r: number;
      /** Terrain revision after this crater; clients apply craters in revision order. */
      rev: number;
      hitTank: number | null;
      shielded: boolean;
      hitHeli: number | null;
    }
  | { type: 'shellGone'; tick: number; shell: number }
  | {
      type: 'death';
      tick: number;
      tank: number;
      cause: DeathCause;
      killer: number | null;
      x: number;
      y: number;
      levelBefore: number;
      deathNumber: number;
      reset: boolean;
      victimController: ControllerKind;
      killerController: ControllerKind | null;
      fallDistance: number | null;
    }
  | {
      type: 'kill';
      tick: number;
      killer: number;
      victim: number | null;
      heli: boolean;
      cause: DeathCause | 'heli';
      levelsAwarded: number;
      levelBefore: number;
      levelAfter: number;
      killerController: ControllerKind;
    }
  | { type: 'milestone'; tick: number; tank: number; level: number; runId: number; elapsedTicks: number; controller: ControllerKind }
  | { type: 'heliSpawn'; tick: number; heli: number; tank: number }
  | { type: 'heliDown'; tick: number; heli: number; tank: number; by: number; x: number; y: number }
  | { type: 'drop'; tick: number; tank: number; x: number; y: number; forced: boolean }
  | { type: 'settled'; tick: number; tank: number }
  | { type: 'blastWarn'; tick: number; tank: number; x: number; y: number; at: number }
  | { type: 'blast'; tick: number; tank: number; x: number; y: number; r: number; rev: number }
  | { type: 'runStart'; tick: number; tank: number; runId: number; controller: ControllerKind }
  | {
      type: 'runReset';
      tick: number;
      tank: number;
      runId: number;
      levelBefore: number;
      deathNumber: number;
      reason: 'deaths' | 'nuke';
      controller: ControllerKind;
    }
  | { type: 'win'; tick: number; tank: number; name: string; controller: ControllerKind; nukeAt: number }
  | { type: 'nuke'; tick: number; seed: number; wind: number; rev: number };

export type GameEventType = GameEvent['type'];
