import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileLog } from './eventlog';
import { startGameServer } from './server';

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
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const env = process.env;
const production = env.NODE_ENV === 'production';
const log = new FileLog(env.LOG_DIR ?? path.join(root, 'logs'));

const server = await startGameServer({
  port: Number(env.GAME_PORT ?? 8787),
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
  // Local testing opens lots of tabs from one machine.
  limits: production ? {} : { maxConnectionsPerIp: 40, connectsPerMinute: 200 },
});

console.log(`Tank server listening on port ${server.port} (${production ? 'production' : 'development'})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await server.close();
    log.close();
    process.exit(0);
  });
}
