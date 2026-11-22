/**
 * The settings that come from the environment, checked before the server starts. A blank one
 * means the default (Number('') is 0: no tables allowed, or a table closed at the first blip), and
 * one that makes no sense stops the start, saying which.
 */
import type { VoiceSettings } from '@tank/shared';
import { IDLE_ROOM_MS } from './room';
import { DEFAULT_LIMITS, type Limits } from './server';

type Env = Record<string, string | undefined>;

/** The longest a timer can wait (about 24 days). */
const LONGEST_MS = 2 ** 31 - 1;

function whole(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, not "${raw}".`);
  return n;
}

function parsed(env: Env, name: string): unknown {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}

function limits(env: Env): Partial<Limits> {
  const given = parsed(env, 'LIMITS') ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('LIMITS must be like {"privateRoomsPer10Min":30}.');
  for (const [name, value] of Object.entries(given as object)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new Error(`LIMITS has no setting called "${name}".`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`LIMITS ${name} must be a number, 0 or more.`);
  }
  return given as Partial<Limits>;
}

function iceServers(env: Env): VoiceSettings['iceServers'] | undefined {
  const given = parsed(env, 'VOICE_ICE_SERVERS');
  if (given === undefined) return undefined;
  const urlsOk = (u: unknown) => typeof u === 'string' || (Array.isArray(u) && u.every((x) => typeof x === 'string'));
  if (!Array.isArray(given) || !given.every((s) => urlsOk(s?.urls))) throw new Error('VOICE_ICE_SERVERS must be a list like [{"urls":"stun:example.com:3478"}].');
  return given;
}

export function readSettings(env: Env) {
  return {
    port: whole(env, 'GAME_PORT', 8787, 0, 65_535),
    emptyRoomMs: whole(env, 'EMPTY_ROOM_MS', 60_000, 0, LONGEST_MS),
    idleRoomMs: whole(env, 'IDLE_ROOM_MS', IDLE_ROOM_MS, 1, LONGEST_MS),
    publicReclaimMs: whole(env, 'RECLAIM_MS', 60_000, 0, LONGEST_MS),
    maxPublicRooms: whole(env, 'MAX_PUBLIC_ROOMS', 10, 0, 10_000),
    maxPrivateRooms: whole(env, 'MAX_PRIVATE_ROOMS', 50, 0, 10_000),
    turnTtlSeconds: whole(env, 'TURN_TTL_SECONDS', 86_400, 60, 30 * 86_400),
    drainMaxMs: whole(env, 'DRAIN_MAX_MS', 3 * 60 * 60 * 1000, 0, LONGEST_MS),
    limits: limits(env),
    iceServers: iceServers(env),
  };
}
