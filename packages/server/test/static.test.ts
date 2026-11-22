import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serveStatic, writeFingerprints } from '../src/static';

let server: http.Server | undefined;
let release = '';
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  fs.rmSync(release, { recursive: true, force: true });
});

describe('fingerprints from the release', () => {
  it('are on the first response after a start, and only while they fit the file', async () => {
    release = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-static-'));
    const client = path.join(release, 'client');
    fs.mkdirSync(path.join(client, 'art', 'felt'), { recursive: true });
    fs.writeFileSync(path.join(client, 'art', 'felt', 'white.webp'), 'felt');
    fs.writeFileSync(path.join(client, 'art', 'swapped.webp'), 'old');
    writeFingerprints(client);
    fs.writeFileSync(path.join(client, 'art', 'swapped.webp'), 'a newer picture');

    server = http.createServer((req, res) => serveStatic(client, req.url!, req, res));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const first = await fetch(`${base}/art/felt/white.webp`);
    const etag = first.headers.get('etag');
    expect(await first.text()).toBe('felt');
    expect(etag).toMatch(/^"[\w-]{27}"$/);
    expect((await fetch(`${base}/art/felt/white.webp`, { headers: { 'if-none-match': etag! } })).status).toBe(304);

    const swapped = await fetch(`${base}/art/swapped.webp`);
    expect([swapped.headers.get('etag'), await swapped.text()]).toEqual([null, 'a newer picture']);
    // The list itself is never served.
    expect((await fetch(`${base}/client-hashes.json`)).status).toBe(404);
  });
});
