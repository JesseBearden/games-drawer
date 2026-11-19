import type { GameConfig } from './config';
import type { TerrainData } from './terrain';
import type { ControllerKind, GameEvent, Point, Shell, Tank, TankPhase } from './types';
import type { World } from './world';
import { isCard, type HeartsView } from './hearts';
import type { SpadesView } from './spades';
import { isTileId, type DominoesView } from './dominoes';
import { isPuzzleId, type PuzzleState, type PuzzleSummary } from './puzzle';

/**
 * WebSocket message contract. Bump PROTOCOL_VERSION on any breaking change; the server
 * rejects clients on a different version and the client asks the player to reload.
 * Fixtures in test/fixtures exercise every message type from both sides.
 */
import { isChatFilterMode, type ChatFilterMode } from './chatFilter';
import { isGameId, type GameId } from './games';

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

/**
 * During a deploy two copies of the server run side by side, in "slots" a and b: games in
 * progress finish on the old copy while new rooms start on the new one. A room's code says
 * which slot holds it, so the web server can send reconnects and invite links to the right
 * copy without asking either of them.
 */
export type Slot = 'a' | 'b';

export function isSlot(v: unknown): v is Slot {
  return v === 'a' || v === 'b';
}

export function slotOfCode(code: string): Slot {
  let sum = 0;
  for (const c of code) sum += ROOM_CODE_ALPHABET.indexOf(c);
  return sum % 2 === 0 ? 'a' : 'b';
}

export type RoomKind = 'public' | 'private';
export type Device = 'desktop' | 'phone';

/**
 * Which room a hello asks for. Public rooms play one game (tanks if none is named). A new
 * private room opens on the lobby, or straight into a game when one is named (a game page's
 * "Play with friends").
 */
export type RoomRequest =
  | { kind: 'public'; game?: GameId }
  | { kind: 'create-private'; game?: GameId }
  | { kind: 'private'; code: string };

// ------------------------------------------------------------------ games

// The games themselves (ids, names, pages, rollout) are listed in games.ts.

/** Input for the tank game. `resync` asks for a fresh snapshot without reconnecting. */
export type TankInput =
  | { t: 'aim'; angle: number; power: number }
  | { t: 'move'; dir: -1 | 0 | 1 }
  | { t: 'fire'; angle: number; power: number }
  | { t: 'drop' }
  | { t: 'resync' };

/** Input for Hearts. `again` starts a new game after one ends. */
export type HeartsInput = { t: 'pass'; cards: string[] } | { t: 'play'; card: string } | { t: 'again' };

/** Input for Spades: bid 0 (nil) to 13 tricks, play a card, or deal a new game after one ends. */
export type SpadesInput = { t: 'bid'; bid: number } | { t: 'play'; card: string } | { t: 'again' };

/**
 * Input for Dominoes: put a tile on a line, draw from the boneyard, say you're ready for the
 * next hand, or deal a new game.
 */
export type DominoesInput = { t: 'place'; tile: string; arm: string } | { t: 'draw' } | { t: 'ready' } | { t: 'again' };

/**
 * Input for the jigsaw: pick a picture and piece count (or continue a saved puzzle), pick up a
 * piece (its whole group comes with it), drag it, drop it, show where your pointer is, tidy the
 * loose pieces, go back to choosing, or look up saved puzzles. Positions are board coordinates.
 */
export type PuzzleInput =
  | { t: 'pz-new'; image: string; pieces: number }
  | { t: 'pz-resume'; id: string }
  | { t: 'pz-setup' }
  | { t: 'pz-grab'; piece: number }
  | { t: 'pz-drag'; x: number; y: number }
  | { t: 'pz-drop'; x: number; y: number }
  | { t: 'pz-cursor'; x: number; y: number }
  | { t: 'pz-tidy' }
  | { t: 'pz-saves'; ids: string[] };

export type GameInput = TankInput | HeartsInput | SpadesInput | DominoesInput | PuzzleInput;

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
  /** Private rooms: change how swearing in chat is handled (anyone in the room can). */
  | { t: 'filter'; mode: ChatFilterMode }
  /** Make an invite link from you, optionally for one person by name (their name is filled in for them). */
  | { t: 'invite'; for: string | null }
  /** Input for whatever game the room is playing. */
  | { t: 'g'; m: GameInput };

/** Invite tokens (the ?i= on an invite link): short, random, from this alphabet. */
export const INVITE_TOKEN_LENGTH = 8;
export const INVITE_TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const isInviteToken = (v: unknown): v is string =>
  typeof v === 'string' && v.length === INVITE_TOKEN_LENGTH && [...v].every((c) => INVITE_TOKEN_ALPHABET.includes(c));

/**
 * What the join page shows before you join (GET /api/table?code=…&i=…). Names come from the
 * server, never from the link, so a link can't claim to be from someone it isn't.
 */
export type TableInfo =
  | {
      ok: true;
      /** Who invited you (the invite link's sender), or who started the table for a bare code. */
      from: string | null;
      /** The name the invite was made for, filled in on the join page. */
      for: string | null;
      /** The game being played, or null while they pick one. */
      game: GameId | null;
      /** Names of the people there now. */
      people: string[];
      /** People who dropped out but still hold their seat (they may come back). */
      away: string[];
      full: boolean;
    }
  | { ok: false; reason: 'closed' | 'busy' };

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
  /** Caught by the chat filter: only the sender sees it (shown dimmed, marked as not sent). */
  hidden?: boolean;
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

export type SpadesServerMessage = { t: 'spades'; view: SpadesView };

export type DominoesServerMessage = { t: 'dominoes'; view: DominoesView };

export type PuzzlePhase = 'setup' | 'playing' | 'done';

export type PuzzleServerMessage =
  /** The whole puzzle (on joining, starting, continuing or going back to choosing). */
  | { t: 'pz-state'; phase: PuzzlePhase; state: PuzzleState | null; held: { g: number; by: string }[] }
  /** Pieces that moved for good (a drop, a snap, a tidy): [index, x, y, group]. */
  | { t: 'pz-moved'; pieces: [number, number, number, number][]; locked: number[]; by: string | null; snapped: boolean }
  /** Someone is dragging a group: where the piece they grabbed is now. */
  | { t: 'pz-drag'; g: number; piece: number; x: number; y: number; by: string }
  /** A group was picked up (by someone's alias) or let go (null). */
  | { t: 'pz-held'; g: number; by: string | null }
  | { t: 'pz-cursor'; by: string; x: number; y: number }
  /** Saved puzzles you asked about; `gone` are ones that no longer exist (forget them). */
  | { t: 'pz-saves'; saves: PuzzleSummary[]; gone: string[] };

export type GameServerMessage = TankServerMessage | HeartsServerMessage | SpadesServerMessage | DominoesServerMessage | PuzzleServerMessage;

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
      /** How swearing in chat is handled here (public rooms: always 'block'). */
      chatFilter: ChatFilterMode;
    }
  /** The room switched games (null: back to the lobby). */
  | { t: 'game'; game: GameId | null }
  | { t: 'members'; members: MemberInfo[] }
  /** A message from the current game. */
  | { t: 'g'; m: GameServerMessage }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'name'; name: string }
  | { t: 'pong'; at: number }
  /** The room's chat filter changed. */
  | { t: 'filter'; mode: ChatFilterMode }
  /** Too many caught messages: your chat is paused this long. */
  | { t: 'chatPaused'; ms: number }
  /** Who is in voice chat right now. */
  | { t: 'voice'; peers: VoicePeer[] }
  | { t: 'rtc'; from: string; data: RtcSignal }
  /** Your invite link's token (and the name it's for, as the server cleaned it). */
  | { t: 'invite'; token: string; for: string | null }
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
      if (room.game !== undefined && !isGameId(room.game)) return null;
      const game = room.game as GameId | undefined;
      if (room.kind === 'public') req = game ? { kind: 'public', game } : { kind: 'public' };
      else if (room.kind === 'create-private') req = game ? { kind: 'create-private', game } : { kind: 'create-private' };
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
      return isGameId(o.game) ? { t: 'pick', game: o.game } : null;
    case 'lobby':
      return { t: 'lobby' };
    case 'filter':
      return isChatFilterMode(o.mode) ? { t: 'filter', mode: o.mode } : null;
    case 'invite':
      return o.for === null || str(o.for, 64) ? { t: 'invite', for: o.for as string | null } : null;
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
    case 'pz-new':
      return typeof o.image === 'string' && o.image.length <= 40 && num(o.pieces) ? { t: 'pz-new', image: o.image, pieces: o.pieces } : null;
    case 'pz-resume':
      return isPuzzleId(o.id) ? { t: 'pz-resume', id: o.id } : null;
    case 'pz-setup':
      return { t: 'pz-setup' };
    case 'pz-grab':
      return Number.isInteger(o.piece) && (o.piece as number) >= 0 && (o.piece as number) < 5000 ? { t: 'pz-grab', piece: o.piece as number } : null;
    case 'pz-drag':
    case 'pz-drop':
    case 'pz-cursor':
      return num(o.x) && num(o.y) && Math.abs(o.x) < 1e6 && Math.abs(o.y) < 1e6 ? { t: o.t, x: o.x, y: o.y } : null;
    case 'pz-tidy':
      return { t: 'pz-tidy' };
    case 'pz-saves':
      return Array.isArray(o.ids) && o.ids.length <= 40 && o.ids.every(isPuzzleId) ? { t: 'pz-saves', ids: [...(o.ids as string[])] } : null;
    case 'place':
      return isTileId(o.tile) && typeof o.arm === 'string' && /^[ewns][+-]?$/.test(o.arm) ? { t: 'place', tile: o.tile, arm: o.arm } : null;
    case 'draw':
      return { t: 'draw' };
    case 'ready':
      return { t: 'ready' };
    case 'bid':
      return Number.isInteger(o.bid) && (o.bid as number) >= 0 && (o.bid as number) <= 13 ? { t: 'bid', bid: o.bid as number } : null;
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
