import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Token bucket: `rate` tokens per second, holding at most `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private rate: number,
    private burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number, cost = 1): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Counts events per key inside a sliding window (e.g. failed room joins per IP). */
export class WindowCounter {
  private hits = new Map<string, number[]>();
  constructor(private windowMs: number) {}

  count(key: string, now: number): number {
    const list = this.hits.get(key);
    if (!list) return 0;
    const fresh = list.filter((t) => now - t < this.windowMs);
    if (fresh.length) this.hits.set(key, fresh);
    else this.hits.delete(key);
    return fresh.length;
  }

  add(key: string, now: number) {
    const list = this.hits.get(key) ?? [];
    list.push(now);
    this.hits.set(key, list);
  }

  /** Drop stale keys so memory stays bounded. */
  sweep(now: number) {
    for (const key of [...this.hits.keys()]) this.count(key, now);
  }
}

/**
 * Session credentials are issued by the server and signed, so a client cannot invent one
 * (or try guessing) to take over somebody else's reserved tank. Format: `<uuid>.<mac>`.
 */
export class SessionSigner {
  private key: Buffer;
  constructor(secret?: string) {
    this.key = secret ? Buffer.from(secret, 'utf8') : randomBytes(32);
  }

  issue(): string {
    const id = randomUUID();
    return `${id}.${this.mac(id)}`;
  }

  verify(token: unknown): boolean {
    if (typeof token !== 'string' || token.length > 80) return false;
    const m = /^([0-9a-f-]{36})\.([0-9a-f]{32})$/.exec(token);
    if (!m) return false;
    const expected = Buffer.from(this.mac(m[1]), 'hex');
    const given = Buffer.from(m[2], 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private mac(id: string) {
    return createHmac('sha256', this.key).update(id).digest('hex').slice(0, 32);
  }
}

/**
 * Client IP. Only trust forwarded addresses when a reverse proxy we control sets them. On AWS
 * the player's address comes from CloudFront (CloudFront-Viewer-Address: "ip:port", the IP
 * unbracketed even for IPv6); our boxes only take traffic from CloudFront and each other.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const viewer = req.headers['cloudfront-viewer-address'];
    const v = (Array.isArray(viewer) ? viewer[0] : viewer)?.trim();
    const cut = v ? v.lastIndexOf(':') : -1;
    if (v && cut > 0) return v.slice(0, cut);
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Blocks cross-site WebSocket use (another site opening a socket from a visitor's browser).
 * Browsers always send Origin; scripts and tests may omit it, which is allowed because
 * they could forge it anyway.
 */
export function originAllowed(req: IncomingMessage, allowed: string[] | null): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (allowed && allowed.length) return allowed.some((a) => a === origin || a === originHost);
  return originHost === req.headers.host;
}
