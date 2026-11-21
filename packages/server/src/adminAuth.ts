import { createHash, createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * The admin page's password. The server never holds the password itself, only a one-way hash
 * of it (ADMIN_PASSWORD_HASH), made with `npm run admin-password`. The hash isn't in the repo
 * either: locally it lives in .env.local (git ignores it), on AWS in Parameter Store.
 *
 * Format: scrypt$<N>$<r>$<p>$<salt, base64>$<hash, base64>
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;

export function hashAdminPassword(password: string, salt = randomBytes(16)): string {
  const hash = scryptSync(password.normalize('NFC'), salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Is it a hash this module made (so a typo in the setting is caught at start-up)? */
export function isAdminPasswordHash(stored: string): boolean {
  return parse(stored) !== null;
}

function parse(stored: string) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored.trim());
  if (!m) return null;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Keep a bad setting from making each check absurdly slow or weak.
  if (n < 1024 || n > 1 << 20 || (n & (n - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 8) return null;
  const salt = Buffer.from(m[4], 'base64');
  const hash = Buffer.from(m[5], 'base64');
  if (salt.length < 8 || hash.length < 16) return null;
  return { n, r, p, salt, hash };
}

/**
 * Checks a password against the stored hash. Asynchronous: scrypt is slow on purpose (tens of
 * milliseconds), and done in Node's worker threads it can't stall the games while it runs.
 */
export async function verifyAdminPassword(password: string, stored: string): Promise<boolean> {
  const h = parse(stored);
  if (!h || typeof password !== 'string' || password.length > 200) return false;
  const opts: ScryptOptions = { N: h.n, r: h.r, p: h.p, maxmem: 256 * h.n * h.r * 2 };
  const got = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFC'), h.salt, h.hash.length, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
  return timingSafeEqual(got, h.hash);
}

/**
 * Signed-in admins carry a cookie: an expiry time and a signature. The signing key comes from
 * the password hash, so changing the password signs everyone out, and both copies of the server
 * (during a deploy) accept each other's cookies.
 */
export const ADMIN_COOKIE = 'gd_admin';
export const ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function sessionKey(stored: string) {
  return createHash('sha256').update('games-drawer-admin-session:').update(stored).digest();
}

export function issueAdminSession(stored: string, now: number): string {
  const until = String(now + ADMIN_SESSION_MS);
  return `${until}.${createHmac('sha256', sessionKey(stored)).update(until).digest('hex')}`;
}

export function verifyAdminSession(token: string | undefined, stored: string, now: number): boolean {
  if (!token || token.length > 100) return false;
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(token);
  if (!m || Number(m[1]) <= now) return false;
  const expected = createHmac('sha256', sessionKey(stored)).update(m[1]).digest();
  const given = Buffer.from(m[2], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
