import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { ADMIN_COOKIE, ADMIN_SESSION_MS, issueAdminSession, verifyAdminPassword, verifyAdminSession } from './adminAuth';
import { AdminStatsCache, type AdminStats } from './adminStats';
import type { LogSink } from './eventlog';
import { clientIp, WindowCounter } from './guard';

/**
 * The admin page, gamesdrawer.com/admin: usage numbers now, moderation later. It's served by the
 * game server itself (nothing of it is in the client bundle) and only exists when
 * ADMIN_PASSWORD_HASH is set.
 */
export interface AdminOptions {
  /** scrypt hash of the admin password (see adminAuth.ts). Unset: there is no admin page. */
  passwordHash?: string;
  /** Log folders to read (both production copies of the server write their own). */
  logDirs: string[];
  trustProxy: boolean;
  /** Mark the cookie Secure (production is always HTTPS). */
  secureCookie: boolean;
  log: LogSink;
  now?: () => number;
}

/** Wrong passwords allowed per address, and in total, per 15 minutes. */
const TRIES_PER_IP = 5;
const TRIES_TOTAL = 30;
const TRY_WINDOW_MS = 15 * 60_000;
/** Logs are kept 30 days (LOG_KEEP_DAYS), so the page looks back at most that far. */
const DAY_CHOICES = [1, 7, 30];

export function createAdmin(o: AdminOptions) {
  const now = o.now ?? Date.now;
  const failsPerIp = new WindowCounter(TRY_WINDOW_MS);
  const failsTotal = new WindowCounter(TRY_WINDOW_MS);
  // Nobody’s address is held much past its window (the privacy page says so).
  setInterval(() => failsPerIp.sweep(now()), TRY_WINDOW_MS).unref();
  // Tries still being checked count as wrong until they're known to be right, so a burst of
  // tries sent all at once can't slip past the limits while the first ones are being checked.
  const checking = new Map<string, number>();
  let checkingTotal = 0;
  const stats = new AdminStatsCache(o.logDirs, now);

  /** Handles /admin and /admin/…; returns false for anything else. */
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;
    const hash = o.passwordHash;
    if (!hash) {
      res.writeHead(404).end();
      return true;
    }
    const t = now();
    const signedIn = verifyAdminSession(cookie(req, ADMIN_COOKIE), hash, t);

    if (url.pathname === '/admin/login' && req.method === 'POST') {
      const ip = clientIp(req, o.trustProxy);
      failsPerIp.sweep(t);
      if (failsPerIp.count(ip, t) + (checking.get(ip) ?? 0) >= TRIES_PER_IP || failsTotal.count('all', t) + checkingTotal >= TRIES_TOTAL) {
        page(res, 429, loginHtml('Too many wrong tries. Wait 15 minutes, then try again.'));
        return true;
      }
      checking.set(ip, (checking.get(ip) ?? 0) + 1);
      checkingTotal++;
      let ok = false;
      try {
        const body = await readBody(req);
        const password = body === null ? '' : (new URLSearchParams(body).get('password') ?? '');
        ok = await verifyAdminPassword(password, hash);
      } finally {
        const left = (checking.get(ip) ?? 1) - 1;
        if (left > 0) checking.set(ip, left);
        else checking.delete(ip);
        checkingTotal--;
      }
      if (!ok) {
        failsPerIp.add(ip, t);
        failsTotal.add('all', t);
        o.log.event('admin_login', { ok: false, ip: shortHash(ip) });
        page(res, 401, loginHtml('That’s not the password.'));
        return true;
      }
      o.log.event('admin_login', { ok: true, ip: shortHash(ip) });
      const attrs = `Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_MS / 1000}${o.secureCookie ? '; Secure' : ''}`;
      res.writeHead(303, { location: '/admin', 'set-cookie': `${ADMIN_COOKIE}=${issueAdminSession(hash, t)}; ${attrs}`, 'cache-control': 'no-store' }).end();
      return true;
    }
    if (url.pathname === '/admin/logout' && req.method === 'POST') {
      res.writeHead(303, { location: '/admin', 'set-cookie': `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`, 'cache-control': 'no-store' }).end();
      return true;
    }
    if (url.pathname !== '/admin' || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return true;
    }
    if (!signedIn) {
      page(res, 200, loginHtml());
      return true;
    }
    const asked = Number(url.searchParams.get('days'));
    const days = DAY_CHOICES.includes(asked) ? asked : 7;
    page(res, 200, statsHtml(await stats.get(days)));
    return true;
  };
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** A small form body, or null if it's too big or too slow. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 2048) {
        finish(null);
        req.destroy();
      }
    });
    req.on('end', () => finish(body));
    req.on('error', () => finish(null));
  });
}

function shortHash(s: string) {
  return createHash('sha256').update('games-drawer-admin-ip:').update(s).digest('hex').slice(0, 12);
}

function page(res: ServerResponse, status: number, html: string) {
  res
    .writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    })
    .end(html);
}

// ---------------------------------------------------------------- pages

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function shell(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>
:root{color-scheme:dark;--bg:#141a4a;--panel:#1d2563;--line:#2f3a85;--text:#f4f5ff;--muted:#a9b0e0;--accent:#ffcc33}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1160px;margin:0 auto;padding:20px 16px 40px}h1{font-size:24px;margin:0}h2{font-size:18px;margin:28px 0 8px}
header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px}
.tile b{display:block;font-size:26px}.tile span{color:var(--muted);font-size:13px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:560px}th,td{padding:7px 8px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600;font-size:13px}
.note{color:var(--muted);font-size:13px;margin:6px 0 0}.days a{color:var(--text);margin-right:10px}.days a.on{color:var(--accent);font-weight:700}
button,input{font:inherit}input{width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:#0e1338;color:var(--text);margin:8px 0 12px}
button{background:var(--accent);color:#1b1b28;border:0;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer}
.link{background:none;color:var(--muted);padding:0;text-decoration:underline}.err{color:#ff8b98;font-weight:600}
.bar{display:inline-block;height:8px;border-radius:4px;background:var(--accent);vertical-align:middle;margin-right:6px}
</style></head><body><main>${body}</main></body></html>`;
}

function loginHtml(error?: string) {
  return shell(
    'Admin · Games Drawer',
    `<div class="card" style="max-width:360px;margin:60px auto 0"><h1>Games Drawer admin</h1>
<form method="post" action="/admin/login"><label for="pw" class="note">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required maxlength="200">
${error ? `<p class="err">${esc(error)}</p>` : ''}<button type="submit">Sign in</button></form></div>`,
  );
}

function statsHtml(s: AdminStats) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const tile = (value: unknown, label: string) => `<div class="card tile"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const maxPerson = Math.max(1, ...s.games.map((g) => g.personHours));
  const gameRows = s.games
    .map(
      (g) => `<tr><td>${esc(g.name)}</td><td><span class="bar" style="width:${Math.round((g.personHours / maxPerson) * 60)}px"></span>${g.personHours}</td><td>${g.sessions}</td><td>${g.picks}</td><td>${g.players}</td><td>${g.avgMinutes}</td><td>${pct(g.groupShare)}</td><td>${g.groupSessions}</td><td>${g.avgPeak}</td><td>${g.maxPeak}</td><td>${g.chatsPerPersonHour}</td></tr>`,
    )
    .join('');
  const dayRows = [...s.daily]
    .reverse()
    .map((d) => `<tr><td>${esc(d.day)}</td><td>${d.players}</td><td>${d.rooms}</td><td>${d.sessions}</td><td>${d.personHours}</td><td>${d.chats}</td></tr>`)
    .join('');
  const days = DAY_CHOICES.map((n) => `<a href="/admin?days=${n}" class="${n === s.days ? 'on' : ''}">${n === 1 ? 'Today' : `${n} days`}</a>`).join('');
  return shell(
    'Admin · Games Drawer',
    `<header><h1>Games Drawer admin</h1><form method="post" action="/admin/logout"><button class="link" type="submit">Sign out</button></form></header>
<p class="days">${days}</p><p class="note">${esc(s.from)} to ${esc(s.to)} (UTC). A game counts once it ends. Numbers refresh every minute.</p>
<div class="tiles">${tile(s.players, 'people who played')}${tile(s.sessions, 'games played')}${tile(s.personHours, 'person-hours')}${tile(s.privateRooms, 'private rooms opened')}${tile(s.publicJoins, 'joins in public games')}${tile(s.chat.delivered, 'chat messages')}</div>
<h2>Games, most played first</h2><div class="card scroll"><table><thead><tr><th>Game</th><th>Person-hours</th><th>Games</th><th>Picked</th><th>People</th><th>Avg minutes</th><th>Time with 2+</th><th>Games with 2+</th><th>Avg most at once</th><th>Most at once</th><th>Chat per person-hour</th></tr></thead><tbody>${gameRows}</tbody></table></div>
<p class="note">Person-hours: two people for an hour is two. “Time with 2+” is the share of play time with at least two people at once. “Picked” counts private-room picks. People are counted by device: someone on a phone and a computer counts twice. Days logged before this counted every browser tab, so they read high.</p>
<h2>Chat</h2><div class="tiles">${tile(s.chat.delivered, 'messages sent')}${tile(s.chat.perPersonHour, 'messages per person-hour')}${tile(s.sessions ? pct(s.chat.sessionsWithChat / s.sessions) : '0%', 'games with any chat')}${tile(s.chat.blocked, 'messages blocked by the filter')}${tile(s.chat.reported, 'messages reported')}</div>
<h2>Voice</h2><div class="tiles">${tile(s.voice.people, 'people who talked')}${tile(s.voice.links ? pct(s.voice.relayed / s.voice.links) : '0%', 'voice links through the relay')}${tile(s.voice.peopleRelayed, 'people who needed the relay')}${tile(s.voice.links ? pct(s.voice.failed / s.voice.links) : '0%', 'voice links that never connected')}${tile(s.voice.peopleFailed, 'people who couldn’t connect to someone')}</div>
<p class="note">Voice normally goes straight between players. Some networks (phone data, offices, schools) need our relay, which costs bandwidth; a link that never connected usually means a network that blocks voice.</p>
<h2>By day</h2><div class="card scroll"><table><thead><tr><th>Day</th><th>People</th><th>Private rooms</th><th>Games</th><th>Person-hours</th><th>Chat messages</th></tr></thead><tbody>${dayRows}</tbody></table></div>`,
  );
}
