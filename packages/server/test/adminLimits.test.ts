import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin';
import { hashAdminPassword } from '../src/adminAuth';
import { readLogs } from '../src/adminStats';
import { MemoryLog } from '../src/eventlog';

const PASSWORD = 'correct horse battery';
const HASH = hashAdminPassword(PASSWORD);

let server: http.Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/** A request as a browser would send it. (fetch won't let a test set some of these headers.) */
async function admin(allowedOrigins: string[] | null = null) {
  const clock = { now: 1_000_000 };
  const handle = createAdmin({ passwordHash: HASH, logDirs: [], trustProxy: true, secureCookie: false, log: new MemoryLog(), allowedOrigins, now: () => clock.now });
  server = http.createServer((req, res) => void handle(req, res, new URL(req.url!, 'http://x')));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const ask = (method: string, at: string, headers: Record<string, string> = {}, body = '') =>
    new Promise<{ status: number; policy: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: at, headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode!, policy: String(res.headers['referrer-policy']) });
      });
      req.on('error', reject);
      req.end(body);
    });
  const login = async (password: string, headers: Record<string, string> = {}) => (await ask('POST', '/admin/login', headers, new URLSearchParams({ password }).toString())).status;
  return { clock, ask, login, here: `http://127.0.0.1:${port}` };
}

describe('signing in to the admin page', () => {
  it('takes the form only from our own page', async () => {
    const { login, here } = await admin();
    const elsewhere: Record<string, string>[] = [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://elsewhere.example' }, { origin: 'null' }];
    // More of them than an address's tries, and none of them uses one up.
    for (let i = 0; i < 2; i++) for (const headers of elsewhere) expect(await login('nope', headers)).toBe(403);
    expect(await login(PASSWORD, { origin: here })).toBe(303);
    expect(await login(PASSWORD, { 'sec-fetch-site': 'same-origin', origin: here })).toBe(303);
  });

  it('knows the site’s own addresses behind the web server', async () => {
    const { login } = await admin(['https://games.example']);
    expect(await login(PASSWORD, { origin: 'https://games.example' })).toBe(303);
  });

  it('lets a browser say where the form came from', async () => {
    const { ask } = await admin();
    expect((await ask('GET', '/admin')).policy).toBe('same-origin');
  });

  it('wrong tries from many addresses only slow the right password down', async () => {
    const { login, clock } = await admin();
    const from = (n: number) => ({ 'x-forwarded-for': `203.0.113.${n}` });
    for (let n = 0; n < 30; n++) expect(await login('nope', from(Math.floor(n / 5)))).toBe(401);
    // Past the total: one check every 10 seconds, right or wrong.
    expect(await login('nope', from(50))).toBe(401);
    expect(await login(PASSWORD, from(60))).toBe(429);
    clock.now += 10_000;
    expect(await login(PASSWORD, from(60))).toBe(303);
  });
});

describe('the admin page’s logs', () => {
  it('stops at a ceiling, keeping the newest days', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-admin-'));
    try {
      for (const day of ['2026-11-20', '2026-11-21']) {
        const line = JSON.stringify({ type: 'game_start', at: `${day}T10:00:00Z`, game: 'hearts' }) + '\n';
        fs.writeFileSync(path.join(dir, `events-${day}.jsonl`), line.repeat(6));
        fs.writeFileSync(path.join(dir, `chat-${day}.jsonl`), JSON.stringify({ outcome: 'delivered', at: `${day}T10:00:00Z` }) + '\n');
      }
      const days = ['2026-11-20', '2026-11-21'];
      const some = await readLogs([dir], days, 8);
      expect([some.events.length, some.chats.length, some.capped]).toEqual([8, 2, true]);
      expect(some.events.filter((e) => e.at!.startsWith('2026-11-21'))).toHaveLength(6);
      const all = await readLogs([dir], days);
      expect([all.events.length, all.capped]).toEqual([12, false]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
