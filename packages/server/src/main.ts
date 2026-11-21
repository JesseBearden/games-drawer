import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdminPasswordHash } from './adminAuth';
import { FileLog, pruneLogs } from './eventlog';
import { pretendChecker, RekognitionChecker } from './photoCheck';
import { startGameServer, type Limits } from './server';
import { addLocalPuzzleImages, isSlot, parseLocalPuzzles, type GameConfig } from '@tank/shared';

/**
 * Environment:
 *   GAME_PORT          listen port (default 8787; not PORT, which dev tools often set for Vite)
 *   HOST               bind address (default 0.0.0.0)
 *   NODE_ENV           "production" serves the built client and locks down /stats
 *   SESSION_SECRET     signs reclaim credentials (random per boot if unset)
 *   ALLOWED_ORIGINS    comma-separated origins allowed to open sockets (default: same origin)
 *   TRUST_PROXY=1      read client IPs from CloudFront's CloudFront-Viewer-Address, else the
 *                      first X-Forwarded-For (only behind our own Caddy, which only CloudFront and
 *                      our other boxes can reach)
 *   STATS_TOKEN        required as ?token= for /stats in production
 *   EMPTY_ROOM_MS, RECLAIM_MS, MAX_PUBLIC_ROOMS, MAX_PRIVATE_ROOMS   timers/caps (shorten to test)
 *   IDLE_ROOM_MS       close a table after this long with nobody playing or talking (default 10 min)
 *   LOG_DIR            where JSONL logs go (default ./logs)
 *   GAME_CONFIG        JSON gameplay overrides for playtesting, e.g. {"winLevel":3}
 *   VOICE_ICE_SERVERS  JSON list of STUN/TURN servers for voice chat (default: a public STUN server)
 *   TURN_URLS          comma-separated URLs of our own TURN relay, e.g.
 *                      turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
 *   TURN_SECRET        shared secret (coturn static-auth-secret); players get expiring credentials
 *   TURN_TTL_SECONDS   how long each player's TURN credentials last (default 86400)
 *   LIMITS             JSON overrides for the abuse limits in server.ts, e.g. {"privateRoomsPer10Min":50}
 *   SLOT               this box's slot letter (a-d); its room codes all map to it (see deploy/README.md)
 *   RELEASE            the build's git commit, reported by /healthz
 *   DRAIN_MAX_MS       on SIGUSR2, finish games for at most this long, then exit (default 3 hours)
 *   CLIENT_DIST, BLOCKLIST_PATH   file locations (defaults work in the repo and in a release bundle)
 *   PUZZLE_DIR         where jigsaw puzzles are saved (default ./data/puzzles)
 *   PHOTO_CHECK        rekognition | pretend | off: how uploaded jigsaw photos are checked
 *                      (default: off in production, pretend elsewhere); PHOTO_CHECK_REGION (or
 *                      AWS_REGION, default us-east-2) is Rekognition's region
 *   ADMIN_PASSWORD_HASH  turns on /admin; make it with `npm run admin-password` (never the
 *                      password itself). In development it's read from .env.local (git ignores it).
 *   ADMIN_LOG_DIRS     comma-separated log folders /admin adds up, with the folders directly inside
 *                      them (on AWS, one per box on the shared disk; default: LOG_DIR)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
// A release bundle (npm run release) puts server.mjs next to client/ and blocklist.txt.
const bundled = fs.existsSync(path.join(here, 'client', 'index.html'));
const root = bundled ? here : path.resolve(here, '../../..');
const env = process.env;
// Local settings that must stay out of the repo (the admin password's hash). Production gets
// them from systemd's environment files instead.
if (env.NODE_ENV !== 'production' && fs.existsSync(path.join(root, '.env.local'))) process.loadEnvFile(path.join(root, '.env.local'));
const production = env.NODE_ENV === 'production';
// Puzzle pictures that live only on this computer (the git-ignored local-puzzles folder). Never
// in production, where the folder doesn't exist anyway: it's never committed or deployed.
if (!production) {
  const localList = path.join(root, 'local-puzzles', 'puzzles.json');
  const loadLocal = () => {
    try {
      addLocalPuzzleImages(parseLocalPuzzles(JSON.parse(fs.readFileSync(localList, 'utf8'))));
    } catch {
      /* no local pictures */
    }
  };
  loadLocal();
  // Pictures added with npm run local-puzzle show up without restarting the server.
  fs.watchFile(localList, { interval: 2000 }, loadLocal);
}
const logDir = env.LOG_DIR ?? path.join(root, 'logs');
const log = new FileLog(logDir);
const adminLogDirs = env.ADMIN_LOG_DIRS ? env.ADMIN_LOG_DIRS.split(',').map((s) => s.trim()).filter(Boolean) : [logDir];
// Logs are kept LOG_KEEP_DAYS (30) days: older ones go now and every 6 hours, from every box's
// folder (a replaced box's too). The privacy page promises this.
const pruneOldLogs = () => pruneLogs([...new Set([logDir, ...adminLogDirs])], { keepDir: logDir });
pruneOldLogs();
setInterval(pruneOldLogs, 6 * 3_600_000).unref();
const adminPasswordHash = env.ADMIN_PASSWORD_HASH?.trim() || undefined;
if (adminPasswordHash && !isAdminPasswordHash(adminPasswordHash)) {
  console.error('ADMIN_PASSWORD_HASH is not a hash from `npm run admin-password`.');
  process.exit(1);
}

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
let limits: Partial<Limits> = {};
try {
  limits = env.LIMITS ? JSON.parse(env.LIMITS) : {};
} catch {
  console.error('LIMITS is not valid JSON.');
  process.exit(1);
}
const slot = env.SLOT || undefined;
if (slot !== undefined && !isSlot(slot)) {
  console.error('SLOT must be one of a, b, c or d.');
  process.exit(1);
}
const turnUrls = (env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (turnUrls.length && !env.TURN_SECRET) {
  console.error('TURN_URLS is set but TURN_SECRET is not.');
  process.exit(1);
}
const turn = turnUrls.length ? { urls: turnUrls, secret: env.TURN_SECRET!, ttlSeconds: Number(env.TURN_TTL_SECONDS ?? 86_400) } : undefined;
if (turn) console.log(`Voice relay: ${turnUrls.join(', ')}`);
// Your own photos for a jigsaw are checked by Amazon Rekognition on AWS. Elsewhere there's no
// AWS, so on your own computer (and in tests) a pretend check lets them through; a production
// server without PHOTO_CHECK=rekognition doesn't offer uploads at all.
const photoCheckMode = env.PHOTO_CHECK ?? (production ? 'off' : 'pretend');
if (!['rekognition', 'pretend', 'off'].includes(photoCheckMode)) {
  console.error('PHOTO_CHECK must be rekognition, pretend or off.');
  process.exit(1);
}
const photoCheck =
  photoCheckMode === 'rekognition' ? new RekognitionChecker({ region: env.PHOTO_CHECK_REGION || env.AWS_REGION || 'us-east-2' }) : photoCheckMode === 'pretend' ? pretendChecker : null;
console.log(`Photo uploads: ${photoCheck ? `on (${photoCheck.name} check)` : 'off'}`);
const port = Number(env.GAME_PORT ?? 8787);
const server = await startGameServer({
  port,
  host: env.HOST ?? '0.0.0.0',
  production,
  clientDist: env.CLIENT_DIST ?? (bundled ? path.join(root, 'client') : path.join(root, 'packages/client/dist')),
  log,
  blocklistPath: env.BLOCKLIST_PATH ?? (bundled ? path.join(root, 'blocklist.txt') : path.join(root, 'packages/server/blocklist.txt')),
  emptyRoomMs: Number(env.EMPTY_ROOM_MS ?? 60_000),
  idleRoomMs: env.IDLE_ROOM_MS ? Number(env.IDLE_ROOM_MS) : undefined,
  publicReclaimMs: Number(env.RECLAIM_MS ?? 60_000),
  maxPublicRooms: Number(env.MAX_PUBLIC_ROOMS ?? 10),
  maxPrivateRooms: Number(env.MAX_PRIVATE_ROOMS ?? 50),
  sessionSecret: env.SESSION_SECRET,
  allowedOrigins: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : null,
  trustProxy: env.TRUST_PROXY === '1',
  statsToken: env.STATS_TOKEN,
  iceServers: env.VOICE_ICE_SERVERS ? JSON.parse(env.VOICE_ICE_SERVERS) : undefined,
  turn,
  gameConfig,
  slot,
  release: env.RELEASE,
  puzzleDir: env.PUZZLE_DIR ?? path.join(bundled ? process.cwd() : root, 'data', 'puzzles'),
  photoCheck,
  adminPasswordHash,
  adminLogDirs,
  // Local testing opens lots of tabs (and phones, which reach the server through Vite as the same
  // address) from one machine.
  limits: { ...(production ? {} : { maxConnectionsPerIp: 40, connectsPerMinute: 200, privateRoomsPer10Min: 100 }), ...limits },
}).catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Is another copy of the game server running? (Set GAME_PORT to use a different port.)`);
  } else {
    console.error('Game server failed to start:', err);
  }
  log.close();
  process.exit(1);
});

console.log(
  `Games Drawer server listening on port ${server.port} (${production ? 'production' : 'development'}${slot ? `, slot ${slot}` : ''}${env.RELEASE ? `, release ${env.RELEASE}` : ''})`,
);
console.log(adminPasswordHash ? 'Admin page: /admin' : 'Admin page off (no ADMIN_PASSWORD_HASH).');
log.event('server_start', { release: env.RELEASE ?? 'dev', slot: slot ?? null });

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await server.close();
  log.close();
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void stop());

// Deploys send SIGUSR2 to the old copy once the new one takes new rooms: games in progress play
// out, then it exits by itself. (Windows has no SIGUSR2; deploys only run on Linux.)
if (process.platform !== 'win32') {
  process.on('SIGUSR2', async () => {
    console.log('Draining: finishing games in progress, starting no new ones.');
    await server.drain(Number(env.DRAIN_MAX_MS ?? 3 * 60 * 60 * 1000));
    console.log('Drained.');
    await stop();
  });
}
