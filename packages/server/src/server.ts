import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_CONFIG,
  isRoomCode,
  normalizeRoomCode,
  parseClientMessage,
  PROTOCOL_VERSION,
  randomName,
  type ErrorCode,
  type ServerMessage,
} from '@tank/shared';
import { ChatModerator } from './chat';
import type { LogSink } from './eventlog';
import { clientIp, originAllowed, SessionSigner, TokenBucket, WindowCounter } from './guard';
import { RoomManager } from './manager';
import type { Conn, Room } from './room';
import { serveStatic } from './static';

export interface Limits {
  /** Open WebSockets per IP. */
  maxConnectionsPerIp: number;
  /** New WebSocket connections per IP per minute. */
  connectsPerMinute: number;
  /** Messages per second per connection (steady rate) and burst. */
  messageRate: number;
  messageBurst: number;
  /** Dropped messages tolerated in a row before the connection is closed. */
  maxStrikes: number;
  /** Private rooms an IP may create per 10 minutes. */
  privateRoomsPer10Min: number;
  /** Failed private-room lookups (wrong codes) per IP per 5 minutes. */
  failedJoinsPer5Min: number;
  /** Close a client whose unsent backlog grows past this many bytes (slow or stalled reader). */
  maxBufferedBytes: number;
  helloTimeoutMs: number;
  heartbeatMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxConnectionsPerIp: 8,
  connectsPerMinute: 30,
  messageRate: 30,
  messageBurst: 60,
  maxStrikes: 200,
  privateRoomsPer10Min: 5,
  failedJoinsPer5Min: 10,
  maxBufferedBytes: 1_000_000,
  helloTimeoutMs: 10_000,
  heartbeatMs: 15_000,
};

export interface ServerOptions {
  port: number;
  host: string;
  production: boolean;
  clientDist: string;
  log: LogSink;
  blocklistPath?: string;
  emptyRoomMs: number;
  publicReclaimMs: number;
  maxPublicRooms: number;
  maxPrivateRooms: number;
  /** Signs session credentials. Random per boot if unset (rooms reset on restart anyway). */
  sessionSecret?: string;
  /** Exact origins or hosts allowed to open sockets. Null means same-origin only. */
  allowedOrigins: string[] | null;
  /** Trust X-Forwarded-For (only behind our own reverse proxy, e.g. Caddy). */
  trustProxy: boolean;
  /** /stats requires ?token=<statsToken> in production; without a token it is disabled there. */
  statsToken?: string;
  limits?: Partial<Limits>;
  /** Run the tick loop (tests can drive ticks by hand). */
  autoTick?: boolean;
}

export interface GameServer {
  port: number;
  manager: RoomManager;
  counters: Record<string, number | string>;
  close(): Promise<void>;
}

export async function startGameServer(o: ServerOptions): Promise<GameServer> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...o.limits };
  const signer = new SessionSigner(o.sessionSecret);
  const manager = new RoomManager({
    now: () => Date.now(),
    log: o.log,
    moderator: new ChatModerator(o.blocklistPath),
    emptyRoomMs: o.emptyRoomMs,
    publicReclaimMs: o.publicReclaimMs,
    maxPublicRooms: o.maxPublicRooms,
    maxPrivateRooms: o.maxPrivateRooms,
    chatHistorySize: 10,
  });
  const counters = {
    connections: 0,
    rejectedOrigin: 0,
    rejectedIpLimit: 0,
    rateLimitedClosures: 0,
    slowClientClosures: 0,
    badMessages: 0,
    handlerErrors: 0,
    wsErrors: 0,
    tickOverruns: 0,
    maxTickMs: 0,
    started: new Date().toISOString(),
  };
  const openPerIp = new Map<string, number>();
  const connects = new WindowCounter(60_000);
  const privateCreates = new WindowCounter(10 * 60_000);
  const failedJoins = new WindowCounter(5 * 60_000);

  // ---------------------------------------------------------------- HTTP

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      if (url.pathname === '/stats') {
        if (o.production && (!o.statsToken || url.searchParams.get('token') !== o.statsToken)) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(stats(), null, 2));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
        return;
      }
      if (o.production) {
        serveStatic(o.clientDist, url.pathname, req, res);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('Game server running. In development, open the Vite URL (http://localhost:5173).');
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
      else res.destroy();
    }
  });
  // Slow-request protection.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  function stats() {
    return {
      ...counters,
      rejectedAtCapacity: manager.rejectedAtCapacity,
      roomErrors: manager.roomErrors,
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
      rooms: [...manager.rooms.values()].map((r) => ({
        kind: r.kind,
        humans: r.humansConnected(),
        tanks: r.world.tanks.size,
        bots: [...r.world.tanks.values()].filter((t) => t.controller === 'bot').length,
        emptyForS: r.emptySince ? Math.round((Date.now() - r.emptySince) / 1000) : null,
      })),
    };
  }

  // ---------------------------------------------------------------- WebSocket

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024,
    perMessageDeflate: false,
  });

  server.on('upgrade', (req, socket, head) => {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let path = '';
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      /* fall through */
    }
    if (path !== '/ws') return reject(404, 'Not Found');
    if (!originAllowed(req, o.allowedOrigins)) {
      counters.rejectedOrigin++;
      return reject(403, 'Forbidden');
    }
    const ip = clientIp(req, o.trustProxy);
    const now = Date.now();
    if ((openPerIp.get(ip) ?? 0) >= limits.maxConnectionsPerIp || connects.count(ip, now) >= limits.connectsPerMinute) {
      counters.rejectedIpLimit++;
      return reject(429, 'Too Many Requests');
    }
    connects.add(ip, now);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  });

  function onConnection(ws: WebSocket, ip: string) {
    counters.connections++;
    openPerIp.set(ip, (openPerIp.get(ip) ?? 0) + 1);
    let room: Room | null = null;
    let session: string | null = null;
    let alive = true;
    let strikes = 0;
    /** Once we decide to close, ignore everything else this socket sends. */
    let closing = false;
    const bucket = new TokenBucket(limits.messageRate, limits.messageBurst, Date.now());

    const conn: Conn = {
      send: (data) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > limits.maxBufferedBytes) {
          // The client isn't reading (stalled or malicious); don't let its backlog eat memory.
          counters.slowClientClosures++;
          ws.terminate();
          return;
        }
        ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const fail = (code: ErrorCode, message: string) => {
      if (closing) return;
      closing = true;
      conn.send(JSON.stringify({ t: 'error', code, message } satisfies ServerMessage));
      ws.close(4004, code);
    };
    const helloTimer = setTimeout(() => {
      if (!room) ws.close(4002, 'no hello');
    }, limits.helloTimeoutMs);
    ws.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, limits.heartbeatMs);

    ws.on('message', (data, isBinary) => {
      if (closing) return;
      try {
        if (!bucket.take(Date.now())) {
          if (++strikes > limits.maxStrikes) {
            counters.rateLimitedClosures++;
            o.log.event('flood_disconnect', { ip: hashIp(ip) });
            fail('rate-limited', 'Too many messages.');
          }
          return;
        }
        strikes = 0;
        const msg = isBinary ? null : parseClientMessage(data.toString());
        if (!msg) {
          counters.badMessages++;
          return;
        }
        if (!room) {
          if (msg.t !== 'hello' || session !== null) return;
          if (msg.v !== PROTOCOL_VERSION) return fail('version', 'The game was updated. Please reload.');
          const now = Date.now();
          // Only server-issued, signed sessions are honoured; anything else gets a new one.
          session = signer.verify(msg.session) ? msg.session! : signer.issue();
          const req = msg.room;
          if (req.kind === 'private') {
            if (failedJoins.count(ip, now) >= limits.failedJoinsPer5Min) {
              return fail('rate-limited', 'Too many wrong room codes. Wait a few minutes and try again.');
            }
            const code = normalizeRoomCode(req.code);
            if (!isRoomCode(code) || !manager.rooms.has(code)) {
              failedJoins.add(ip, now);
              return fail('not-found', 'That room has closed or the code is wrong.');
            }
          }
          if (req.kind === 'create-private') {
            if (privateCreates.count(ip, now) >= limits.privateRoomsPer10Min) {
              return fail('rate-limited', "You've made a lot of rooms. Try again in a few minutes.");
            }
          }
          const lookup = manager.resolve(req, session);
          if (!lookup.ok) return fail(lookup.code, lookup.message);
          if (req.kind === 'create-private') privateCreates.add(ip, now);
          const result = lookup.room.join(conn, session, msg.name || randomName(), msg.device);
          if (!result.ok) return fail(result.code, result.message);
          room = lookup.room;
          clearTimeout(helloTimer);
          conn.send(JSON.stringify(room.welcome(session, result)));
          return;
        }
        if (room.closed) return;
        room.handle(session!, msg);
      } catch (err) {
        counters.handlerErrors++;
        o.log.event('handler_error', { error: String(err) });
        console.error('Message handler error:', err);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(heartbeat);
      const n = (openPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) openPerIp.delete(ip);
      else openPerIp.set(ip, n);
      try {
        if (room && session && !room.closed) room.disconnect(session, conn, 'disconnect');
      } catch (err) {
        counters.handlerErrors++;
        console.error('Disconnect error:', err);
      }
    });
    ws.on('error', () => {
      counters.wsErrors++;
    });
  }

  // ---------------------------------------------------------------- tick loop

  const timers: NodeJS.Timeout[] = [];
  if (o.autoTick !== false) {
    // Fixed timestep. Windows timers fire every ~15ms, so step as many ticks as are due.
    const tickMs = 1000 / DEFAULT_CONFIG.tickRate;
    let last = performance.now();
    let acc = 0;
    let lastHousekeeping = Date.now();
    timers.push(
      setInterval(() => {
        const now = performance.now();
        acc += now - last;
        last = now;
        if (acc > tickMs * 10) acc = tickMs * 10; // don't spiral after a stall
        while (acc >= tickMs) {
          acc -= tickMs;
          const { maxMs } = manager.stepAll();
          if (maxMs > counters.maxTickMs) counters.maxTickMs = Math.round(maxMs * 100) / 100;
          if (maxMs > tickMs) counters.tickOverruns++;
        }
        if (Date.now() - lastHousekeeping >= 1000) {
          lastHousekeeping = Date.now();
          manager.housekeeping();
          const t = Date.now();
          connects.sweep(t);
          privateCreates.sweep(t);
          failedJoins.sweep(t);
        }
      }, 4),
    );
  }

  await new Promise<void>((resolve) => server.listen(o.port, o.host, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    manager,
    counters,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearInterval(t);
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** IPs are personal data: logs get a salted one-way hash that changes every boot. */
const IP_SALT = randomBytes(16);
function hashIp(ip: string) {
  return createHash('sha256').update(IP_SALT).update(ip).digest('hex').slice(0, 12);
}
