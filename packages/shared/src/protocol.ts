import type { GameConfig } from './config';
import type { TerrainData } from './terrain';
import type { ControllerKind, GameEvent, Point, Shell, Tank, TankPhase } from './types';
import type { World } from './world';

/**
 * WebSocket message contract. Bump PROTOCOL_VERSION on any breaking change; the server
 * rejects clients on a different version and the client asks the player to reload.
 * Fixtures in test/fixtures exercise every message type from both sides.
 */
export const PROTOCOL_VERSION = 1;

/** Private room codes: consonants only (they never spell words), this many letters. */
export const ROOM_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const ROOM_CODE_LENGTH = 5;

export function normalizeRoomCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isRoomCode(code: string) {
  return code.length === ROOM_CODE_LENGTH && [...code].every((c) => ROOM_CODE_ALPHABET.includes(c));
}

export type RoomKind = 'public' | 'private';
export type Device = 'desktop' | 'phone';

export type RoomRequest =
  | { kind: 'public' }
  | { kind: 'create-private' }
  | { kind: 'private'; code: string };

// ------------------------------------------------------------------ client -> server

export type ClientMessage =
  | { t: 'hello'; v: number; session: string | null; name: string; room: RoomRequest; device: Device }
  | { t: 'aim'; angle: number; power: number }
  | { t: 'move'; dir: -1 | 0 | 1 }
  | { t: 'fire'; angle: number; power: number }
  | { t: 'drop' }
  | { t: 'chat'; text: string }
  | { t: 'name'; name: string }
  | { t: 'ping'; at: number }
  | { t: 'leave' };

// ------------------------------------------------------------------ server -> client

export interface TankInfo {
  id: number;
  color: number;
  name: string;
  controller: ControllerKind;
  /** Human currently controlling the tank, or that holds its reservation. */
  owner: string | null;
  kills: number;
  level: number;
  deaths: number;
  extraLife: boolean;
  protectedUntil: number;
  awaitingProtection: boolean;
  shotsUntilSpread: number;
  shellsInFlight: number;
  lastImpact: Point | null;
  blastAt: number;
  runId: number;
  /** A bot is holding this tank for a disconnected player. */
  away: boolean;
}

/** Compact per-tick tank state: [id, x, y, angle, phase, tilt]. */
export type TankDyn = [number, number, number, number, number, number];
/** [id, tankId, x, y, dir, carrying] */
export type HeliDyn = [number, number, number, number, number, number];

export const PHASES: TankPhase[] = ['carried', 'chute', 'air', 'slide', 'ground', 'dead'];

export interface ChatMessage {
  id: string;
  from: string;
  /** Tank colour index of the sender, or -1 for system messages. */
  color: number;
  text: string;
  /** Server time, ms since epoch. */
  at: number;
  system?: boolean;
}

export interface PlayerSummary {
  name: string;
  tankId: number | null;
  connected: boolean;
}

export interface Snapshot {
  tick: number;
  terrain: TerrainData;
  terrainSeed: number;
  terrainRev: number;
  wind: number;
  tanks: TankInfo[];
  dyn: TankDyn[];
  helis: HeliDyn[];
  shells: Pick<Shell, 'id' | 'owner' | 'x' | 'y' | 'vx' | 'vy'>[];
  match: { state: 'playing' } | { state: 'won'; winner: number; nukeAt: number };
  chat: ChatMessage[];
}

export interface RoomInfo {
  code: string;
  kind: RoomKind;
}

export type ServerMessage =
  | {
      t: 'welcome';
      v: number;
      session: string;
      name: string;
      tankId: number;
      reclaimed: boolean;
      room: RoomInfo;
      config: GameConfig;
      snapshot: Snapshot;
    }
  | { t: 'state'; tick: number; dyn: TankDyn[]; helis: HeliDyn[] }
  | { t: 'events'; tick: number; events: GameEvent[] }
  | { t: 'info'; tanks: TankInfo[] }
  | { t: 'removed'; tanks: number[] }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'name'; name: string }
  | { t: 'pong'; at: number; tick: number }
  | { t: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'version'
  | 'capacity'
  | 'room-full'
  | 'not-found'
  | 'bad-request'
  | 'replaced'
  | 'room-closed'
  | 'rate-limited';

// ------------------------------------------------------------------ encoders

const r1 = (v: number) => Math.round(v * 10) / 10;

export function tankDyn(t: Tank): TankDyn {
  return [t.id, r1(t.x), r1(t.y), r1(t.angle), PHASES.indexOf(t.phase), Math.round(t.tilt * 100) / 100];
}

export function heliDyns(world: World): HeliDyn[] {
  return world.helis.map((h) => [h.id, h.tankId, r1(h.x), r1(h.y), h.dir, h.carrying ? 1 : 0]);
}

export function tankInfo(t: Tank, owner: string | null, away: boolean): TankInfo {
  return {
    id: t.id,
    color: t.color,
    name: t.name,
    controller: t.controller,
    owner,
    kills: t.kills,
    level: t.level,
    deaths: t.deaths,
    extraLife: t.extraLife,
    protectedUntil: t.protectedUntil,
    awaitingProtection: t.awaitingProtection,
    shotsUntilSpread: t.shotsUntilSpread,
    shellsInFlight: t.shellsInFlight,
    lastImpact: t.lastImpact,
    blastAt: t.blastAt,
    runId: t.runId,
    away,
  };
}

/** Minimal runtime validation for messages from untrusted clients. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 4096) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
  // Always build a fresh object from known fields, never pass the client's object through.
  switch (o.t) {
    case 'hello': {
      const room = o.room as Record<string, unknown> | undefined;
      if (!num(o.v) || !(o.session === null || str(o.session, 80)) || !str(o.name, 64)) return null;
      if (o.device !== 'desktop' && o.device !== 'phone') return null;
      if (!room || typeof room !== 'object') return null;
      let req: RoomRequest;
      if (room.kind === 'public') req = { kind: 'public' };
      else if (room.kind === 'create-private') req = { kind: 'create-private' };
      else if (room.kind === 'private' && str(room.code, 12)) req = { kind: 'private', code: room.code };
      else return null;
      return { t: 'hello', v: o.v, session: o.session as string | null, name: o.name, room: req, device: o.device };
    }
    case 'aim':
    case 'fire':
      return num(o.angle) && num(o.power) ? { t: o.t, angle: o.angle, power: o.power } : null;
    case 'move':
      return o.dir === -1 || o.dir === 0 || o.dir === 1 ? { t: 'move', dir: o.dir } : null;
    case 'drop':
      return { t: 'drop' };
    case 'leave':
      return { t: 'leave' };
    case 'chat':
      return str(o.text, 1000) ? { t: 'chat', text: o.text } : null;
    case 'name':
      return str(o.name, 64) ? { t: 'name', name: o.name } : null;
    case 'ping':
      return num(o.at) ? { t: 'ping', at: o.at } : null;
    default:
      return null;
  }
}
