/**
 * End-to-end attack tests against a real server on a random port, using real WebSockets
 * and HTTP requests.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, slotOfCode, type RoomRequest, type ServerMessage } from '@tank/shared';
import { MemoryLog } from '../src/eventlog';
import { startGameServer, type GameServer, type Limits, type ServerOptions } from '../src/server';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

function baseOptions(over: Partial<ServerOptions> = {}): ServerOptions {
  return {
    port: 0,
    host: '127.0.0.1',
    production: false,
    clientDist: '',
    log: new MemoryLog(),
    emptyRoomMs: 60_000,
    publicReclaimMs: 60_000,
    maxPublicRooms: 10,
    maxPrivateRooms: 10,
    sessionSecret: 'test-secret',
    allowedOrigins: null,
    trustProxy: false,
    ...over,
  };
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  opened: Promise<void>;
  closed: Promise<number>;
  send(m: unknown): void;
  waitFor<T extends ServerMessage['t']>(t: T, ms?: number): Promise<Extract<ServerMessage, { t: T }>>;
}

function connect(port: number, origin?: string): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: origin ? { origin } : {} });
  const messages: ServerMessage[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
  opened.catch(() => {});
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  return {
    ws,
    messages,
    opened,
    closed,
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    waitFor: async (t, ms = 3000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const found = messages.find((m) => m.t === t);
        if (found) return found as never;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${t}; got ${messages.map((m) => m.t).join(',')}`);
    },
  };
}

function hello(c: Client, room: RoomRequest = { kind: 'public' }, session: string | null = null, v = PROTOCOL_VERSION) {
  c.send({ t: 'hello', v, session, name: 'Tester', room, device: 'desktop' });
}

async function joined(port: number, room: RoomRequest = { kind: 'public' }, session: string | null = null) {
  const c = connect(port);
  await c.opened;
  hello(c, room, session);
  const w = (await c.waitFor('welcome')) as Welcome;
  // Public rooms play tanks straight away; the tank game's start-up message follows the welcome.
  let tankId = -1;
  if (w.game === 'tanks') {
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const init = c.messages.find((m) => m.t === 'g' && m.m.t === 'init');
      if (init && init.t === 'g' && init.m.t === 'init') {
        tankId = init.m.tankId;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return { c, w, tankId };
}

async function startWith(limits: Partial<Limits> = {}, over: Partial<ServerOptions> = {}) {
  return startGameServer(baseOptions({ limits, ...over }));
}

describe('live server: sessions and joining', () => {
  let s: GameServer;
  beforeAll(async () => {
    s = await startWith();
  });
  afterAll(() => s.close());

  it('replaces a client-invented session with a signed one', async () => {
    const { c, w } = await joined(s.port, { kind: 'public' }, 'session-i-made-up-1234');
    expect(w.session).not.toBe('session-i-made-up-1234');
    expect(w.session).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{32}$/);
    c.ws.close();
  });

  it('a signed session reclaims the same tank after reconnecting', async () => {
    const first = await joined(s.port);
    first.c.ws.close();
    await first.c.closed;
    await new Promise((r) => setTimeout(r, 50));
    const again = await joined(s.port, { kind: 'public' }, first.w.session);
    expect(again.tankId).toBeGreaterThanOrEqual(0);
    expect(again.tankId).toBe(first.tankId);
    expect(again.w.reclaimed).toBe(true);
    again.c.ws.close();
  });

  it('a tab replaced by a newer one can no longer act: its "leave" does not take the new tab off the table', async () => {
    const a = await joined(s.port, { kind: 'create-private' });
    const code = a.w.room.code;
    // What the old tab's page does the moment it's told: leave, before its socket has closed.
    a.c.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      if (m.t === 'error' && m.code === 'replaced') a.c.send({ t: 'leave' });
    });
    const b = await joined(s.port, { kind: 'private', code }, a.w.session);
    expect(b.w.session).toBe(a.w.session);
    expect((await a.c.waitFor('error')).code).toBe('replaced');
    await a.c.closed;
    await new Promise((r) => setTimeout(r, 100));
    // The new tab is still there and still answered.
    expect(b.c.ws.readyState).toBe(WebSocket.OPEN);
    b.c.messages.length = 0;
    b.c.send({ t: 'ping', at: 1 });
    expect((await b.c.waitFor('pong')).at).toBe(1);
    b.c.ws.close();
  });

  it('rejects an old protocol version', async () => {
    const c = connect(s.port);
    await c.opened;
    hello(c, { kind: 'public' }, null, PROTOCOL_VERSION + 99);
    const err = await c.waitFor('error');
    expect(err.code).toBe('version');
    await c.closed;
  });

  it('ignores game messages sent before hello', async () => {
    const c = connect(s.port);
    await c.opened;
    c.send({ t: 'g', m: { t: 'fire', angle: 45, power: 50 } });
    c.send({ t: 'chat', text: 'hi' });
    hello(c);
    const w = await c.waitFor('welcome');
    expect(w.game).toBe('tanks');
    expect(w.chat.some((m) => m.text === 'hi')).toBe(false);
    c.ws.close();
  });

  it('one shot at a time, even when fire is spammed over the wire', async () => {
    const { c, w, tankId } = await joined(s.port);
    const world = s.manager.rooms.get(w.room.code)!.tanks!.world;
    const tank = world.tanks.get(tankId)!;
    // Put the tank on the ground so it is allowed to fire.
    world.helis = world.helis.filter((h) => h.tankId !== tank.id);
    tank.phase = 'ground';
    tank.x = 300;
    tank.y = world.terrain.groundBelow(300, 0);
    tank.awaitingProtection = false;
    for (let i = 0; i < 50; i++) c.send({ t: 'g', m: { t: 'fire', angle: 80, power: 100 } });
    await new Promise((r) => setTimeout(r, 150));
    expect(world.shells.filter((sh) => sh.owner === tank.id).length).toBeLessThanOrEqual(1);
    expect(tank.shotsFired).toBe(1);
    c.ws.close();
  });

  it('shrugs off garbage, binary frames and unknown message types', async () => {
    const { c } = await joined(s.port);
    c.send('not json');
    c.send('{"t":"nuke"}');
    c.send('{"t":"fire","angle":"lots","power":{}}');
    c.ws.send(Buffer.from([0, 1, 2, 3, 255]));
    c.send({ t: 'ping', at: 1 });
    const pong = await c.waitFor('pong');
    expect(pong.at).toBe(1);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });
});

describe('live server: winding down after a deploy', () => {
  it('warns the tables still here before the cutoff, then closes them with a clear reason', async () => {
    const s = await startWith();
    try {
      const a = await joined(s.port, { kind: 'create-private' });
      const done = s.drain(1500);
      const chat = await a.c.waitFor('chat', 3000);
      expect(chat.msg.text).toMatch(/^Games Drawer was updated\. This table closes in 1 minute: start a new table/);
      await done;
      const err = await a.c.waitFor('error', 3000);
      expect(err.code).toBe('room-closed');
      expect(err.message).toMatch(/closed for an update/);
      expect(s.manager.rooms.size).toBe(0);
    } finally {
      await s.close();
    }
  });
});

describe('live server: abuse limits', () => {
  it('blocks sockets from other websites (cross-site WebSocket hijacking)', async () => {
    const s = await startWith();
    try {
      const evil = connect(s.port, 'https://evil.example');
      await expect(evil.opened).rejects.toThrow('HTTP 403');
      const same = connect(s.port, `http://127.0.0.1:${s.port}`);
      await same.opened;
      same.ws.close();
    } finally {
      await s.close();
    }
  });

  it('caps simultaneous connections per IP', async () => {
    const s = await startWith({ maxConnectionsPerIp: 3 });
    try {
      const clients = [connect(s.port), connect(s.port), connect(s.port)];
      await Promise.all(clients.map((c) => c.opened));
      const fourth = connect(s.port);
      await expect(fourth.opened).rejects.toThrow('HTTP 429');
      clients[0].ws.close();
      await clients[0].closed;
      await new Promise((r) => setTimeout(r, 30));
      const fifth = connect(s.port);
      await fifth.opened;
      for (const c of [...clients, fifth]) c.ws.close();
    } finally {
      await s.close();
    }
  });

  it('disconnects a client that floods messages', async () => {
    const s = await startWith({ messageRate: 10, messageBurst: 10, maxStrikes: 20 });
    try {
      const { c } = await joined(s.port);
      for (let i = 0; i < 300; i++) c.send({ t: 'ping', at: i });
      const err = await c.waitFor('error');
      expect(err.code).toBe('rate-limited');
      await c.closed;
      expect(s.counters.rateLimitedClosures).toBe(1);
      // Only the burst got answered.
      expect(c.messages.filter((m) => m.t === 'pong').length).toBeLessThanOrEqual(12);
    } finally {
      await s.close();
    }
  });

  it('closes on oversized frames', async () => {
    const s = await startWith();
    try {
      const { c } = await joined(s.port);
      c.send({ t: 'chat', text: 'x'.repeat(20_000) });
      expect(await c.closed).toBe(1009);
    } finally {
      await s.close();
    }
  });

  it('drops a connection that never says hello', async () => {
    const s = await startWith({ helloTimeoutMs: 150 });
    try {
      const c = connect(s.port);
      await c.opened;
      expect(await c.closed).toBe(4002);
    } finally {
      await s.close();
    }
  });

  it('throttles room-code guessing', async () => {
    const s = await startWith({ failedJoinsPer5Min: 3 });
    try {
      const host = await joined(s.port, { kind: 'create-private' });
      const realCode = host.w.room.code;
      for (const guess of ['BBBBB', 'CCCCC', 'DDDDD']) {
        const c = connect(s.port);
        await c.opened;
        hello(c, { kind: 'private', code: guess });
        expect((await c.waitFor('error')).code).toBe('not-found');
      }
      // Now even the right code is refused for a while from this IP.
      const c = connect(s.port);
      await c.opened;
      hello(c, { kind: 'private', code: realCode });
      expect((await c.waitFor('error')).code).toBe('rate-limited');
      host.c.ws.close();
    } finally {
      await s.close();
    }
  });

  it('the join page looks up a table: who started it, the game, who is there', async () => {
    const s = await startWith();
    try {
      const host = await joined(s.port, { kind: 'create-private', game: 'jigsaw' });
      const code = host.w.room.code;
      const info = await (await fetch(`http://127.0.0.1:${s.port}/api/table?code=${code}`)).json();
      expect(info).toEqual({ ok: true, from: 'Tester', for: null, game: 'jigsaw', people: ['Tester'], away: [], full: false });
      const gone = await (await fetch(`http://127.0.0.1:${s.port}/api/table?code=BBBBB`)).json();
      expect(gone).toEqual({ ok: false, reason: 'closed' });
      host.c.ws.close();
    } finally {
      await s.close();
    }
  });

  it('invite links name who sent them and who they are for, as the server knows them', async () => {
    const s = await startWith();
    try {
      const host = await joined(s.port, { kind: 'create-private' });
      const code = host.w.room.code;
      host.c.send({ t: 'invite', for: '  Liz  ' });
      const inv = await host.c.waitFor('invite');
      expect(inv.for).toBe('Liz');
      expect(inv.token).toMatch(/^[a-z2-9]{8}$/);
      const info = await (await fetch(`http://127.0.0.1:${s.port}/api/table?code=${code}&i=${inv.token}`)).json();
      expect(info).toMatchObject({ ok: true, from: 'Tester', for: 'Liz', game: null });
      // Asking again for the same person gives the same link.
      host.c.messages.length = 0;
      host.c.send({ t: 'invite', for: 'Liz' });
      expect((await host.c.waitFor('invite')).token).toBe(inv.token);
      // A made-up token is ignored: the page just names whoever started the table.
      const fake = await (await fetch(`http://127.0.0.1:${s.port}/api/table?code=${code}&i=zzzzzzzz`)).json();
      expect(fake).toMatchObject({ ok: true, from: 'Tester', for: null });
      host.c.ws.close();
    } finally {
      await s.close();
    }
  });

  it('table lookups with wrong codes count as code guessing', async () => {
    const s = await startWith({ failedJoinsPer5Min: 2 });
    try {
      const host = await joined(s.port, { kind: 'create-private' });
      for (const guess of ['BBBBB', 'CCCCC']) await fetch(`http://127.0.0.1:${s.port}/api/table?code=${guess}`);
      const info = await (await fetch(`http://127.0.0.1:${s.port}/api/table?code=${host.w.room.code}`)).json();
      expect(info).toEqual({ ok: false, reason: 'busy' });
      host.c.ws.close();
    } finally {
      await s.close();
    }
  });

  it('limits how many private rooms one IP can create', async () => {
    const s = await startWith({ privateRoomsPer10Min: 2 });
    try {
      const a = await joined(s.port, { kind: 'create-private' });
      const b = await joined(s.port, { kind: 'create-private' });
      const c = connect(s.port);
      await c.opened;
      hello(c, { kind: 'create-private' });
      expect((await c.waitFor('error')).code).toBe('rate-limited');
      expect(s.manager.count('private')).toBe(2);
      a.c.ws.close();
      b.c.ws.close();
    } finally {
      await s.close();
    }
  });

  it('private room codes are 5 random consonants', async () => {
    const s = await startWith();
    try {
      const codes = new Set<string>();
      for (let i = 0; i < 4; i++) {
        const r = s.manager.create('private');
        if (r.ok) codes.add(r.room.code);
      }
      for (const code of codes) expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{5}$/);
      expect(codes.size).toBe(4);
    } finally {
      await s.close();
    }
  });
});

describe('live server: HTTP in production mode', () => {
  let s: GameServer;
  let dist: string;
  let base: string;
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tank-http-'));
    dist = path.join(tmp, 'dist');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>game</title><meta property="og:image" content="/art/og.jpg" />');
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
    fs.mkdirSync(path.join(dist, 'sfx'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'sfx', 'boom.wav'), 'RIFF');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP SECRET');
    s = await startGameServer(baseOptions({ production: true, clientDist: dist, statsToken: 'stats-token' }));
    base = `http://127.0.0.1:${s.port}`;
  });
  afterAll(() => s.close());

  it('serves the game with security headers', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>game</title>');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers a missing build file with 404, but invite links with the page', async () => {
    const missing = await fetch(`${base}/assets/app-OLDHASH.js`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('<title>');
    expect((await fetch(`${base}/sfx/nope.wav`)).status).toBe(404);
    const invite = await fetch(`${base}/r/BCDFG`);
    expect(invite.status).toBe(200);
    expect(await invite.text()).toContain('<title>Join my table · Games Drawer</title>');
  });

  it('gives each game page its own title, so a shared link previews as that game', async () => {
    const hearts = await (await fetch(`${base}/hearts`)).text();
    expect(hearts).toContain('<title>Hearts · Games Drawer</title>');
    const alias = await (await fetch(`${base}/tankyouforbeingafriend`)).text();
    expect(alias).toContain('<title>Tank You For Being A Friend · Games Drawer</title>');
    expect(await (await fetch(`${base}/`)).text()).toContain('<title>game</title>');
    expect(await (await fetch(`${base}/no-such-game`)).text()).toContain('<title>game</title>');
  });

  it('serves sounds as audio, cached for a day', async () => {
    const res = await fetch(`${base}/sfx/boom.wav`);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('invite links fall back to the game page', async () => {
    const res = await fetch(`${base}/r/BCDFG`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('og:image');
  });

  it('fills in an absolute link-preview image address', async () => {
    const html = await (await fetch(`${base}/r/BCDFG`)).text();
    expect(html).toContain(`content="http://127.0.0.1:${s.port}/art/og.jpg"`);
  });

  it('never echoes a hostile Host header into the page', async () => {
    const html = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/', headers: { host: 'evil.example"><script>alert(1)</script>' } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('content="/art/og.jpg"');
  });

  it('never serves files outside the client folder', async () => {
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..\\secret.txt', '/%5c..%5csecret.txt']) {
      const res = await fetch(`${base}${p}`);
      const body = await res.text();
      expect(body, p).not.toContain('TOP SECRET');
    }
  });

  it('answers malformed URLs with 400 instead of crashing', async () => {
    const res = await fetch(`${base}/%E0%A4%A`);
    expect(res.status).toBe(400);
    const nul = await fetch(`${base}/index.html%00.png`);
    expect(nul.status).toBe(400);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('refuses non-GET methods', async () => {
    const res = await fetch(`${base}/`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(405);
  });

  it('hides /stats without the token', async () => {
    expect((await fetch(`${base}/stats`)).status).toBe(404);
    expect((await fetch(`${base}/stats?token=wrong`)).status).toBe(404);
    const ok = await fetch(`${base}/stats?token=stats-token`);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toHaveProperty('rooms');
    expect(JSON.stringify(body)).not.toMatch(/session|127\.0\.0\.1/);
  });
});

describe('live server: deploy slots and draining', () => {
  it('reports its release and slot on /healthz', async () => {
    const s = await startWith({}, { slot: 'b', release: 'abc123' });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, release: 'abc123', slot: 'b', draining: false });
    } finally {
      await s.close();
    }
  });

  it('only makes room codes for its own slot', async () => {
    const s = await startWith({ privateRoomsPer10Min: 100, maxConnectionsPerIp: 100, connectsPerMinute: 1000 }, { slot: 'a', maxPrivateRooms: 30 });
    try {
      for (let i = 0; i < 12; i++) {
        const { c, w } = await joined(s.port, { kind: 'create-private' });
        expect(slotOfCode(w.room.code)).toBe('a');
        c.ws.close();
      }
      const { c, w } = await joined(s.port);
      expect(slotOfCode(w.room.code)).toBe('a');
      c.ws.close();
    } finally {
      await s.close();
    }
  });

  it('while draining, keeps games going but starts no new ones, then finishes', async () => {
    const s = await startWith({}, { slot: 'a', emptyRoomMs: 300 });
    try {
      const host = await joined(s.port, { kind: 'create-private' });
      const code = host.w.room.code;
      const drained = s.drain(60_000);
      expect(((await (await fetch(`http://127.0.0.1:${s.port}/healthz`)).json()) as { draining: boolean }).draining).toBe(true);

      // A friend can still join the room in progress...
      const friend = await joined(s.port, { kind: 'private', code });
      expect(friend.w.room.code).toBe(code);
      // ...but nobody can start a new room or public game here.
      for (const room of [{ kind: 'create-private' }, { kind: 'public' }] as RoomRequest[]) {
        const c = connect(s.port);
        await c.opened;
        hello(c, room);
        const err = await c.waitFor('error');
        expect(err.code).toBe('capacity');
        c.ws.close();
      }

      // Once everyone leaves, the room closes and the drain finishes.
      host.c.ws.close();
      friend.c.ws.close();
      await drained;
      expect(s.manager.rooms.size).toBe(0);
    } finally {
      await s.close();
    }
  }, 15_000);
});

describe('deploy slots', () => {
  it('splits room codes evenly between the four box slots', () => {
    const counts = { a: 0, b: 0, c: 0, d: 0 };
    const alphabet = ROOM_CODE_ALPHABET;
    for (let i = 0; i < 4000; i++) {
      let code = '';
      for (let j = 0; j < ROOM_CODE_LENGTH; j++) code += alphabet[(i * 7 + j * 13 + ((i * j) % 17)) % alphabet.length];
      counts[slotOfCode(code)]++;
    }
    for (const n of Object.values(counts)) expect(n / 4000).toBeGreaterThan(0.2);
    expect(slotOfCode('BCDFG')).toBe(slotOfCode('BCDFG'));
  });
});
