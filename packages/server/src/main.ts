import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileLog } from './eventlog';
import { startGameServer } from './server';
import type { GameConfig } from '@tank/shared';

/**
 * Environment:
 *   GAME_PORT          listen port (default 8787; not PORT, which dev tools often set for Vite)
 *   HOST               bind address (default 0.0.0.0)
 *   NODE_ENV           "production" serves the built client and locks down /stats
 *   SESSION_SECRET     signs reclaim credentials (random per boot if unset)
 *   ALLOWED_ORIGINS    comma-separated origins allowed to open sockets (default: same origin)
 *   TRUST_PROXY=1      read client IPs from X-Forwarded-For (only behind our own Caddy)
 *   STATS_TOKEN        required as ?token= for /stats in production
 *   EMPTY_ROOM_MS, RECLAIM_MS, MAX_PUBLIC_ROOMS, MAX_PRIVATE_ROOMS   timers/caps (shorten to test)
 *   LOG_DIR            where JSONL logs go (default ./logs)
 *   GAME_CONFIG        JSON gameplay overrides for playtesting, e.g. {"winLevel":3}
 *   VOICE_ICE_SERVERS  JSON list of STUN/TURN servers for voice chat (default: a public STUN server)
 *   TURN_URLS          comma-separated URLs of our own TURN relay, e.g.
 *                      turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
 *   TURN_SECRET        shared secret (coturn static-auth-secret); players get expiring credentials
 *   TURN_TTL_SECONDS   how long each player's TURN credentials last (default 86400)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const env = process.env;
const production = env.NODE_ENV === 'production';
const log = new FileLog(env.LOG_DIR ?? path.join(root, 'logs'));

let gameConfig: Partial<GameConfig> | undefined;
if (env.GAME_CONFIG) {
  try {
    gameConfig = JSON.parse(env.GAME_CONFIG);
    console.log('Gameplay overrides:', gameConfig);
  } catch {
    console.error('GAME_CONFIG is not valid JSON.');
    process.exit(1);
  }
}
const turnUrls = (env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (turnUrls.length && !env.TURN_SECRET) {
  console.error('TURN_URLS is set but TURN_SECRET is not.');
  process.exit(1);
}
const turn = turnUrls.length ? { urls: turnUrls, secret: env.TURN_SECRET!, ttlSeconds: Number(env.TURN_TTL_SECONDS ?? 86_400) } : undefined;
if (turn) console.log(`Voice relay: ${turnUrls.join(', ')}`);
const port = Number(env.GAME_PORT ?? 8787);
const server = await startGameServer({
  port,
  host: env.HOST ?? '0.0.0.0',
  production,
  clientDist: path.join(root, 'packages/client/dist'),
  log,
  blocklistPath: path.join(root, 'packages/server/blocklist.txt'),
  emptyRoomMs: Number(env.EMPTY_ROOM_MS ?? 60_000),
  publicReclaimMs: Number(env.RECLAIM_MS ?? 60_000),
  maxPublicRooms: Number(env.MAX_PUBLIC_ROOMS ?? 10),
  maxPrivateRooms: Number(env.MAX_PRIVATE_ROOMS ?? 10),
  sessionSecret: env.SESSION_SECRET,
  allowedOrigins: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : null,
  trustProxy: env.TRUST_PROXY === '1',
  statsToken: env.STATS_TOKEN,
  iceServers: env.VOICE_ICE_SERVERS ? JSON.parse(env.VOICE_ICE_SERVERS) : undefined,
  turn,
  gameConfig,
  // Local testing opens lots of tabs from one machine.
  limits: production ? {} : { maxConnectionsPerIp: 40, connectsPerMinute: 200 },
}).catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Is another copy of the game server running? (Set GAME_PORT to use a different port.)`);
  } else {
    console.error('Game server failed to start:', err);
  }
  log.close();
  process.exit(1);
});

console.log(`Tank server listening on port ${server.port} (${production ? 'production' : 'development'})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await server.close();
    log.close();
    process.exit(0);
  });
}
