import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gameForPath } from '@tank/shared';

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Title and description for a page address, so a shared link previews as what it is:
 * a game's page, or an invite to someone's room. Null keeps the home page's.
 */
export function pageMeta(pathname: string): { title: string; description: string } | null {
  const game = gameForPath(pathname);
  if (game) return { title: `${game.title} · Games Drawer`, description: game.tagline };
  if (/^\/r\/[A-Za-z]+\/?$/.test(pathname)) return { title: 'Join my table · Games Drawer', description: 'Come play a game with us. Tap to join.' };
  if (pathname === '/privacy') return { title: 'Privacy · Games Drawer', description: 'What Games Drawer keeps, and for how long.' };
  if (pathname === '/rules') return { title: 'House rules · Games Drawer', description: 'A few rules that keep every table friendly.' };
  return null;
}

/** Put a page's title and description into the HTML (the <title> and the link-preview tags). */
export function withPageMeta(html: string, meta: { title: string; description: string } | null): string {
  if (!meta) return html;
  const t = escapeAttr(meta.title);
  const d = escapeAttr(meta.description);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${d}$2`);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

/** Headers sent with every page and asset. */
export function securityHeaders(host: string | undefined): Record<string, string> {
  const h = host && /^[A-Za-z0-9.:[\]-]+$/.test(host) ? host : '';
  return {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      // Inline style attributes colour player names. The fonts are the site's own (no Google Fonts).
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      // blob: is your own jigsaw photo, read on your device before it's shrunk and sent.
      "img-src 'self' data: blob:",
      `connect-src 'self'${h ? ` wss://${h} ws://${h}` : ''}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Microphone stays available to this site for the planned voice chat.
    'permissions-policy': 'camera=(), geolocation=(), microphone=(self)',
    'cross-origin-opener-policy': 'same-origin',
  };
}

/**
 * Folders whose files keep their names between builds, and how many seconds a browser may use
 * its own copy without asking. After that it asks "still the same?" (see `fingerprints`) rather
 * than downloading the file again; without this the felt alone was about 3.6 MB on every single
 * page load. Sounds and sprites rarely change, so a day. The felt, the cards and the puzzle
 * pictures get ten minutes, so new art shows up soon after a deploy.
 */
const KEEP_SECONDS: Record<string, number> = { sfx: 86400, sprites: 86400, art: 600, puzzles: 600 };

/**
 * A fingerprint of each file's contents (its ETag). A browser that already has a file sends the
 * fingerprint back, and gets a one-line "still the same" (304) instead of the whole file. It is
 * worked out when the release is built (or, without that, while the file is first sent), and kept
 * until the file changes. It comes from the contents, not the date: every box and every release gives the same
 * answer for a picture that hasn't changed.
 */
const fingerprints = new Map<string, { size: number; mtimeMs: number; etag: string }>();

const tagOf = (hash: crypto.Hash) => `"${hash.digest('base64url')}"`;

type ReleaseFingerprints = Record<string, { size: number; etag: string }>;

/** Where a release keeps every client file's fingerprint: beside client/, so it isn't served. */
export const fingerprintsPath = (clientDir: string) => path.join(clientDir, '..', 'client-hashes.json');

/**
 * Work out every file's fingerprint when a release is built (scripts/release.ts), so the first
 * person after a deploy gets them too. Without one a browser downloads the file again when its
 * ten minutes are up.
 */
export function writeFingerprints(clientDir: string) {
  const all: ReleaseFingerprints = {};
  for (const entry of fs.readdirSync(clientDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const body = fs.readFileSync(file);
    all[path.relative(clientDir, file).split(path.sep).join('/')] = { size: body.length, etag: tagOf(crypto.createHash('sha1').update(body)) };
  }
  fs.writeFileSync(fingerprintsPath(clientDir), JSON.stringify(all));
}

const fromRelease = new Map<string, ReleaseFingerprints>();

function releaseFingerprints(root: string): ReleaseFingerprints {
  let known = fromRelease.get(root);
  if (!known) {
    try {
      known = JSON.parse(fs.readFileSync(fingerprintsPath(root), 'utf8')) as ReleaseFingerprints;
    } catch {
      known = {}; // no release built it (development): worked out as each file is sent
    }
    fromRelease.set(root, known);
  }
  return known;
}

/** Does the browser's If-None-Match name this fingerprint? (A proxy may have marked it weak, W/.) */
function namesTag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** Serve the built client. Unknown paths (like /r/ABCDE invite links) get index.html. */
export function serveStatic(dir: string, pathname: string, req: IncomingMessage, res: ServerResponse) {
  const root = path.resolve(dir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400).end();
    return;
  }
  let file = path.resolve(root, '.' + path.posix.normalize('/' + decoded.replace(/\\/g, '/')));
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  const stat = statOrNull(file);
  // A missing file with an extension (a build asset or a sound) is a real 404. Answering with the
  // page instead would hand a browser HTML where it expects JavaScript, e.g. mid-deploy.
  if (!stat && path.extname(decoded) !== '') {
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Not found');
    return;
  }
  if (!stat || !stat.isFile() || path.basename(file) === 'index.html') {
    if (!stat || !stat.isFile()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Client not built. Run npm run build.');
      return;
    }
    // Link previews (iMessage and friends) need an absolute image URL; fill in our address.
    const host = req.headers.host && /^[A-Za-z0-9.:[\]-]{1,255}$/.test(req.headers.host) ? req.headers.host : null;
    let html = withPageMeta(fs.readFileSync(file, 'utf8'), pageMeta(decoded));
    if (host) {
      const local = /^(localhost|127\.|\[::1\])/.test(host);
      html = html.replace('content="/art/og.jpg"', `content="${local ? 'http' : 'https'}://${host}/art/og.jpg"`);
    }
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache', ...securityHeaders(req.headers.host) });
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }
  // The folder under the site's root says how long a browser may keep the file: the build's own
  // files have their contents in their names, so they never change.
  const top = path.relative(root, file).split(path.sep)[0];
  const keep = Object.hasOwn(KEEP_SECONDS, top) ? KEEP_SECONDS[top] : 0;
  if (!fingerprints.has(file)) {
    const built = releaseFingerprints(root)[path.relative(root, file).split(path.sep).join('/')];
    if (built?.size === stat.size) fingerprints.set(file, { ...built, mtimeMs: stat.mtimeMs });
  }
  const known = fingerprints.get(file);
  const etag = known && known.size === stat.size && known.mtimeMs === stat.mtimeMs ? known.etag : undefined;
  const headers = {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': top === 'assets' ? 'public, max-age=31536000, immutable' : keep ? `public, max-age=${keep}` : 'no-cache',
    ...(etag && { etag }),
    ...securityHeaders(req.headers.host),
  };
  if (etag && namesTag(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  if (!etag) {
    // Noted as the last bytes are read, before they're sent (this listener runs before
    // pipeline's): a browser that asks again the moment the file arrives gets its fingerprint.
    const hash = crypto.createHash('sha1');
    let read = 0;
    let done = false;
    stream.on('data', (chunk) => {
      if (done) return;
      read += chunk.length;
      // Longer than when it was looked at: it's changing, so no fingerprint this time.
      if (read > stat.size) {
        done = true;
        return;
      }
      hash.update(chunk);
      if (read === stat.size) {
        done = true;
        fingerprints.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, etag: tagOf(hash) });
      }
    });
    // An empty file has no bytes to read.
    stream.on('end', () => {
      if (!done && read === stat.size) fingerprints.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, etag: tagOf(hash) });
    });
  }
  // A file that can't be read after all ends this one response, not the server. And pipeline,
  // unlike a bare pipe(), closes the file when the browser goes away part-way through.
  pipeline(stream, res, () => {});
}
