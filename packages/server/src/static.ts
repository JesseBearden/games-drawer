import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
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
      // Inline style attributes colour player names; Google Fonts serves the CSS and fonts.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data:",
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
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  if (!stat || stat.isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Client not built. Run npm run build.');
    return;
  }
  const ext = path.extname(file);
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  // Sounds and sprites keep their names between builds; a day of caching saves re-downloading ~1 MB.
  const daily = file.includes(`${path.sep}sfx${path.sep}`) || file.includes(`${path.sep}sprites${path.sep}`);
  if (path.basename(file) === 'index.html') {
    // Link previews (iMessage and friends) need an absolute image URL; fill in our address.
    const host = req.headers.host && /^[A-Za-z0-9.:[\]-]{1,255}$/.test(req.headers.host) ? req.headers.host : null;
    let html = fs.readFileSync(file, 'utf8');
    if (host) {
      const local = /^(localhost|127\.|\[::1\])/.test(host);
      html = html.replace('content="/og.png"', `content="${local ? 'http' : 'https'}://${host}/og.png"`);
    }
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache', ...securityHeaders(req.headers.host) });
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : daily ? 'public, max-age=86400' : 'no-cache',
    ...securityHeaders(req.headers.host),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}
