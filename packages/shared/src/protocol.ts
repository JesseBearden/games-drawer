import type { GameConfig } from './config';
import type { TerrainData } from './terrain';
import type { ControllerKind, GameEvent, Point, Shell, Tank, TankPhase } from './types';
import type { World } from './world';
import { isCard, type HeartsView } from './hearts';

/**
 * WebSocket message contract. Bump PROTOCOL_VERSION on any breaking change; the server
 * rejects clients on a different version and the client asks the player to reload.
 * Fixtures in test/fixtures exercise every message type from both sides.
 */
export const PROTOCOL_VERSION = 2;

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

// ------------------------------------------------------------------ games

/** Games a room can play. Public rooms always play tanks; private rooms pick from the lobby. */
export type GameId = 'tanks' | 'hearts';
export const GAME_IDS: GameId[] = ['tanks', 'hearts'];
export const GAME_NAMES: Record<GameId, string> = { tanks: 'Tanks', hearts: 'Hearts' };

/** Input for the tank game. `resync` asks for a fresh snapshot without reconnecting. */
export type TankInput =
  | { t: 'aim'; angle: number; power: number }
  | { t: 'move'; dir: -1 | 0 | 1 }
  | { t: 'fire'; angle: number; power: number }
  | { t: 'drop' }
  | { t: 'resync' };

/** Input for Hearts. `again` starts a new game after one ends. */
export type HeartsInput = { t: 'pass'; cards: string[] } | { t: 'play'; card: string } | { t: 'again' };

export type GameInput = TankInput | HeartsInput;

// ------------------------------------------------------------------ client -> server

export type ClientMessage =
  | { t: 'hello'; v: number; session: string | null; name: string; room: RoomRequest; device: Device }
  | { t: 'chat'; text: string }
  | { t: 'name'; name: string }
  | { t: 'ping'; at: number }
  | { t: 'leave' }
  /** Report a chat message (by id) to moderators. */
  | { t: 'report'; msgId: string }
  /** Join or leave the room's voice chat (private rooms only). */
  | { t: 'voice'; join: boolean }
  /** WebRTC set-up for one other voice member, relayed by the server. */
  | { t: 'rtc'; to: string; data: RtcSignal }
  /** Start a game from the lobby (private rooms). */
  | { t: 'pick'; game: GameId }
  /** End the current game and take everyone back to the lobby (private rooms). */
  | { t: 'lobby' }
  /** Input for whatever game the room is playing. */
  | { t: 'g'; m: GameInput };

/** WebRTC negotiation payloads (peer-to-peer voice). */
export type RtcSignal =
  | { sdp: { type: 'offer' | 'answer'; sdp: string } }
  | { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } };

export interface VoicePeer {
  /** Player alias in this room. */
  id: string;
  name: string;
}

export interface VoiceSettings {
  /** Voice is offered in private rooms only. */
  enabled: boolean;
  /** STUN/TURN servers for WebRTC (RTCIceServer shape). */
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
}

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
  /** Alias of the player who owns this tank (for voice "speaking" markers), or null for bots. */
  ownerAlias: string | null;
}

/** Compact per-tick tank state: [id, x, y, angle, phase, tilt]. */
export type TankDyn = [number, number, number, number, number, number];
/** [id, tankId, x, y, dir, carrying] */
export type HeliDyn = [number, number, number, number, number, number];

export const PHASES: TankPhase[] = ['carried', 'chute', 'air', 'slide', 'ground', 'dead'];

export interface ChatMessage {
  id: string;
  from: string;
  /** Sender's alias within this room (stable while they stay; never their session). */
  speaker?: string;
  /** Tank colour index of the sender, or -1 for system messages. */
  color: number;
  text: string;
  /** Server time, ms since epoch. */
  at: number;
  system?: boolean;
}

/** Someone in the room (the "party"), whatever game is on. */
export interface MemberInfo {
  /** Alias: stable while they stay in the room; never their session. */
  id: string;
  name: string;
  /** Colour index (TANK_COLORS) used for their name in chat and in every game. */
  color: number;
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
}

export interface RoomInfo {
  code: string;
  kind: RoomKind;
}

/** Messages from the tank game. */
export type TankServerMessage =
  /** Everything needed to draw the battlefield: on joining, on a game start, or on resync. */
  | { t: 'init'; tankId: number; reclaimed: boolean; config: GameConfig; snapshot: Snapshot }
  | { t: 'state'; tick: number; dyn: TankDyn[]; helis: HeliDyn[] }
  | { t: 'events'; tick: number; events: GameEvent[] }
  | { t: 'info'; tanks: TankInfo[] }
  | { t: 'removed'; tanks: number[] };

/** Hearts sends each player their own view of the table (never anyone else's cards). */
export type HeartsServerMessage = { t: 'hearts'; view: HeartsView };

export type GameServerMessage = TankServerMessage | HeartsServerMessage;

export type ServerMessage =
  | {
      t: 'welcome';
      v: number;
      session: string;
      name: string;
      /** You were already in this room (reconnect or reload). */
      reclaimed: boolean;
      /** Your alias in this room (chat sender id, voice peer id). */
      alias: string;
      voice: VoiceSettings;
      room: RoomInfo;
      /** Game being played, or null for the lobby. Its own start-up message follows. */
      game: GameId | null;
      members: MemberInfo[];
      /** Recent chat, oldest first. */
      chat: ChatMessage[];
    }
  /** The room switched games (null: back to the lobby). */
  | { t: 'game'; game: GameId | null }
  | { t: 'members'; members: MemberInfo[] }
  /** A message from the current game. */
  | { t: 'g'; m: GameServerMessage }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'name'; name: string }
  | { t: 'pong'; at: number }
  /** Who is in voice chat right now. */
  | { t: 'voice'; peers: VoicePeer[] }
  | { t: 'rtc'; from: string; data: RtcSignal }
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

export function tankInfo(t: Tank, owner: { name: string; alias: string } | null, away: boolean): TankInfo {
  return {
    id: t.id,
    color: t.color,
    name: t.name,
    controller: t.controller,
    owner: owner?.name ?? null,
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
    ownerAlias: owner?.alias ?? null,
  };
}

/** Minimal runtime validation for messages from untrusted clients. */
export function parseClientMessage(raw: string): ClientMessage | null {
  // WebRTC session descriptions run a few KB; everything else is far smaller.
  if (raw.length > 16_000) return null;
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
    case 'leave':
      return { t: 'leave' };
    case 'chat':
      return str(o.text, 1000) ? { t: 'chat', text: o.text } : null;
    case 'name':
      return str(o.name, 64) ? { t: 'name', name: o.name } : null;
    case 'ping':
      return num(o.at) ? { t: 'ping', at: o.at } : null;
    case 'report':
      return str(o.msgId, 64) ? { t: 'report', msgId: o.msgId } : null;
    case 'voice':
      return typeof o.join === 'boolean' ? { t: 'voice', join: o.join } : null;
    case 'rtc': {
      const data = parseRtcSignal(o.data);
      return str(o.to, 32) && data ? { t: 'rtc', to: o.to, data } : null;
    }
    case 'pick':
      return GAME_IDS.includes(o.game as GameId) ? { t: 'pick', game: o.game as GameId } : null;
    case 'lobby':
      return { t: 'lobby' };
    case 'g': {
      const input = parseGameInput(o.m);
      return input ? { t: 'g', m: input } : null;
    }
    default:
      return null;
  }
}

/** Validate game input from an untrusted client, rebuilding it from known fields. */
export function parseGameInput(v: unknown): GameInput | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  switch (o.t) {
    case 'aim':
    case 'fire':
      return num(o.angle) && num(o.power) ? { t: o.t, angle: o.angle, power: o.power } : null;
    case 'move':
      return o.dir === -1 || o.dir === 0 || o.dir === 1 ? { t: 'move', dir: o.dir } : null;
    case 'drop':
      return { t: 'drop' };
    case 'resync':
      return { t: 'resync' };
    case 'pass': {
      if (!Array.isArray(o.cards) || o.cards.length !== 3 || !o.cards.every(isCard)) return null;
      return { t: 'pass', cards: [...(o.cards as string[])] };
    }
    case 'play':
      return isCard(o.card) ? { t: 'play', card: o.card } : null;
    case 'again':
      return { t: 'again' };
    default:
      return null;
  }
}

/** Validate a WebRTC signal from an untrusted client, rebuilding it from known fields. */
export function parseRtcSignal(v: unknown): RtcSignal | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.sdp && typeof o.sdp === 'object') {
    const s = o.sdp as Record<string, unknown>;
    if ((s.type === 'offer' || s.type === 'answer') && typeof s.sdp === 'string' && s.sdp.length <= 12_000) {
      return { sdp: { type: s.type, sdp: s.sdp } };
    }
    return null;
  }
  if (o.candidate && typeof o.candidate === 'object') {
    const c = o.candidate as Record<string, unknown>;
    if (typeof c.candidate !== 'string' || c.candidate.length > 1000) return null;
    const mid = c.sdpMid === null || c.sdpMid === undefined ? null : typeof c.sdpMid === 'string' && c.sdpMid.length <= 64 ? c.sdpMid : undefined;
    const idx = c.sdpMLineIndex === null || c.sdpMLineIndex === undefined ? null : Number.isInteger(c.sdpMLineIndex) && (c.sdpMLineIndex as number) >= 0 && (c.sdpMLineIndex as number) < 64 ? (c.sdpMLineIndex as number) : undefined;
    if (mid === undefined || idx === undefined) return null;
    return { candidate: { candidate: c.candidate, sdpMid: mid, sdpMLineIndex: idx } };
  }
  return null;
}
