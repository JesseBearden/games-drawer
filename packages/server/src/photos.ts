import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isPhotoId, isRoomCode, normalizeRoomCode, photoImageId, PHOTO_MAX_BYTES, PHOTO_MAX_SIDE, PHOTO_MIN_SIDE } from '@tank/shared';
import type { LogSink } from './eventlog';
import { WindowCounter } from './guard';
import type { PhotoChecker } from './photoCheck';
import { pseudonym, type Room } from './room';

/**
 * Your own photos for a jigsaw. The phone or computer shrinks the photo and sends it here as a
 * JPEG; this strips anything that isn't the picture itself (camera, location, comments), has it
 * checked (photoCheck.ts), and keeps it in the table's memory only: never on disk, never in the
 * logs, gone when the table closes (Room.close). Only people at the table can send one, and the
 * address it's shown at has 128 random bits in it, so nobody else can find it.
 *
 *   POST /api/photo?table=CODE   body: the JPEG; header x-gd-session: your session (and
 *                                x-gd-ready-ms: how long getting it ready took, for the logs)
 *   GET  /api/photo/CODE/ID.jpg  the photo
 *
 * Both also carry ?slot=, for the web server to route by (photoUrls.ts in shared).
 */

/** A photo in a table's memory. */
export interface TablePhoto {
  id: string;
  jpeg: Buffer;
  width: number;
  height: number;
  /** Who added it (alias and name at the time). */
  by: string;
  byName: string;
  at: number;
}

/** Uploads one address may send per hour, one table per hour, and the whole server per day. */
export const PHOTO_LIMITS = {
  perIpPerHour: 10,
  perTablePerHour: 12,
  perServerPerDay: 300,
  /** Uploads being read or checked at the same moment: each holds a few copies of the photo in memory. */
  atOnce: 6,
  atOncePerTable: 2,
};
/** Photos in memory across every table, at most (the server has 450 MB in all). */
export const PHOTO_MEMORY_BYTES = 48 * 1024 * 1024;

export type PhotoRefusal = 'off' | 'not-at-table' | 'busy' | 'not-image' | 'too-big' | 'too-small' | 'blocked' | 'unavailable' | 'full';

/**
 * A JPEG with only what's needed to show it: every APP segment that can carry camera details,
 * location or a thumbnail (APP1 EXIF and XMP, APP2 ICC, APP13 Photoshop, ...) and comments are
 * dropped, between a progressive JPEG's scans too, and so is anything after the end of the
 * picture (a phone's motion-photo video, a second picture, any file tacked on). JFIF (APP0) and
 * Adobe's colour marker (APP14) stay. Also its size. Null if it isn't a JPEG this can follow.
 * (The phone's own copy has already lost all this, but a server can't trust that.)
 */
export function cleanJpeg(buf: Buffer): { jpeg: Buffer; width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out: Buffer[] = [buf.subarray(0, 2)];
  const EOI = Buffer.from([0xff, 0xd9]);
  let width = 0;
  let height = 0;
  let scanned = false;
  let i = 2;
  for (;;) {
    if (i + 2 > buf.length || buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9 && scanned) {
      out.push(EOI); // the end of the picture: whatever follows is dropped
      break;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) return null; // nothing to show yet
    if (i + 4 > buf.length) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (marker === 0xda) {
      // A scan: its header, then the coded picture, up to the next marker. (In coded data 0xFF
      // is only ever followed by 0x00, a restart marker or more 0xFF.)
      if (!width || !height) return null;
      out.push(buf.subarray(i, i + 2 + len));
      const data = i + 2 + len;
      let j = data;
      for (;;) {
        j = buf.indexOf(0xff, j);
        if (j < 0 || j + 1 >= buf.length) break;
        const b = buf[j + 1];
        if (b !== 0x00 && b !== 0xff && !(b >= 0xd0 && b <= 0xd7)) break;
        j++;
      }
      if (j < 0 || j + 1 >= buf.length) {
        out.push(buf.subarray(data), EOI); // cut short: end it here
        break;
      }
      out.push(buf.subarray(data, j));
      scanned = true;
      i = j;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (len < 7 || width) return null; // one picture only
      height = buf.readUInt16BE(i + 5);
      width = buf.readUInt16BE(i + 7);
    }
    const metadata = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!metadata) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!width || !height) return null;
  return { jpeg: Buffer.concat(out), width, height };
}

/** The request body, or 'too-big' once it passes `max` bytes (the rest is ignored). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | 'too-big'> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) {
      req.resume();
      resolve('too-big');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.off('data', onData);
        req.resume();
        resolve('too-big');
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface PhotoRoutesOptions {
  rooms: ReadonlyMap<string, Room>;
  /** Null: uploading is off (the page doesn't offer it). */
  checker: PhotoChecker | null;
  log: LogSink;
  now?: () => number;
}

/** The two photo addresses. `handle` returns false for any other address. */
export function photoRoutes(o: PhotoRoutesOptions) {
  const now = o.now ?? (() => Date.now());
  const perIp = new WindowCounter(3_600_000);
  const perTable = new WindowCounter(3_600_000);
  const perServer = new WindowCounter(86_400_000);
  // Forget old counts, so memory stays bounded and nobody’s address is held much past the hour
  // (the privacy page says so).
  setInterval(() => {
    const t = now();
    for (const counts of [perIp, perTable, perServer]) counts.sweep(t);
  }, 600_000).unref();

  const json = (res: ServerResponse, status: number, body: object) =>
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(status === 413 && { connection: 'close' }) }).end(JSON.stringify(body));
  const refuse = (res: ServerResponse, status: number, reason: PhotoRefusal) => json(res, status, { ok: false, reason });

  /** Uploads being read or checked right now, in all and per table. */
  let inFlight = 0;
  const inFlightAt = new Map<string, number>();

  function memoryInUse() {
    let n = 0;
    for (const r of o.rooms.values()) for (const p of r.photos.values()) n += p.jpeg.length;
    return n;
  }

  function serve(req: IncomingMessage, res: ServerResponse, code: string, id: string) {
    const photo = o.rooms.get(code)?.photos.get(id);
    if (!photo) {
      res.writeHead(404, { 'cache-control': 'no-store' }).end();
      return;
    }
    // Not kept by the browser either: it's only for while the table is open.
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': photo.jpeg.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : photo.jpeg);
  }

  async function upload(req: IncomingMessage, res: ServerResponse, url: URL, ip: string) {
    if (!o.checker) return refuse(res, 404, 'off');
    const code = normalizeRoomCode(url.searchParams.get('table') ?? '');
    const session = String(req.headers['x-gd-session'] ?? '');
    const room = o.rooms.get(code);
    if (!room || room.closed || !session || !room.hasSession(session)) return refuse(res, 403, 'not-at-table');
    if (!/^image\/jpeg\b/.test(String(req.headers['content-type'] ?? ''))) return refuse(res, 415, 'not-image');
    const t = now();
    if (perIp.count(ip, t) >= PHOTO_LIMITS.perIpPerHour || perTable.count(code, t) >= PHOTO_LIMITS.perTablePerHour || perServer.count('all', t) >= PHOTO_LIMITS.perServerPerDay) {
      return refuse(res, 429, 'busy');
    }
    if (inFlight >= PHOTO_LIMITS.atOnce || (inFlightAt.get(code) ?? 0) >= PHOTO_LIMITS.atOncePerTable) return refuse(res, 429, 'busy');
    // Counted now, before anything is waited for. Counting only once the photo had arrived let a
    // burst sent together all pass the checks above before any of them was counted.
    perIp.add(ip, t);
    perTable.add(code, t);
    perServer.add('all', t);
    inFlight++;
    inFlightAt.set(code, (inFlightAt.get(code) ?? 0) + 1);
    try {
      await receive(req, res, room, code, session);
    } finally {
      inFlight--;
      const left = (inFlightAt.get(code) ?? 1) - 1;
      if (left <= 0) inFlightAt.delete(code);
      else inFlightAt.set(code, left);
    }
  }

  /** An upload that's been let in: read it, clean it, check it, and add it to the table. */
  async function receive(req: IncomingMessage, res: ServerResponse, room: Room, code: string, session: string) {
    const checker = o.checker!;
    // Someone who pressed Cancel (or lost their connection) before hearing back: their photo isn't
    // added, even if it was all here and passed.
    let gone = false;
    res.on('close', () => {
      if (!res.writableEnded) gone = true;
    });
    // How long the phone or computer took to get the photo ready (it says), and to send it, for
    // the logs: where the wait is when adding a photo feels slow.
    const ready = String(req.headers['x-gd-ready-ms'] ?? '');
    const times = { readyMs: /^\d{1,6}$/.test(ready) ? Number(ready) : undefined, sendMs: 0 };
    const sendStarted = now();
    let body: Buffer | 'too-big';
    try {
      body = await readBody(req, PHOTO_MAX_BYTES);
    } catch (err) {
      if (!gone) throw err;
      o.log.event('photo_stopped', { room: code, by: pseudonym(session), ...times, sendMs: now() - sendStarted, while: 'sending' });
      return;
    }
    times.sendMs = now() - sendStarted;
    if (body === 'too-big') return refuse(res, 413, 'too-big');
    const clean = cleanJpeg(body);
    if (!clean) return refuse(res, 400, 'not-image');
    const { width, height } = clean;
    if (Math.max(width, height) > PHOTO_MAX_SIDE) return refuse(res, 413, 'too-big');
    if (Math.min(width, height) < PHOTO_MIN_SIDE) return refuse(res, 400, 'too-small');
    if (memoryInUse() + clean.jpeg.length > PHOTO_MEMORY_BYTES) return refuse(res, 429, 'busy');
    const by = pseudonym(session);
    let verdict;
    const started = now();
    try {
      verdict = await checker.check(clean.jpeg, { width, height });
    } catch (err) {
      o.log.event('photo_check_failed', { room: code, checker: checker.name, error: String(err).slice(0, 300), ...times });
      return refuse(res, 503, 'unavailable');
    }
    // `ms` is how long the check took.
    const ms = now() - started;
    if (!verdict.ok) {
      // What kind of thing was found goes in the logs (so we can see if the check is too strict),
      // never the photo.
      o.log.event('photo_refused', { room: code, by, reason: verdict.reason, categories: verdict.reason === 'blocked' ? verdict.categories : undefined, ms, ...times });
      return refuse(res, verdict.reason === 'blocked' ? 422 : 400, verdict.reason === 'blocked' ? 'blocked' : 'not-image');
    }
    if (gone) {
      o.log.event('photo_stopped', { room: code, by, ms, ...times, while: 'checking' });
      return;
    }
    const id = randomBytes(16).toString('base64url');
    const added = room.addPhoto(session, { id, jpeg: clean.jpeg, width, height });
    if (added !== 'ok') return refuse(res, added === 'full' ? 409 : 410, added === 'full' ? 'full' : 'not-at-table');
    o.log.event('photo_added', { room: code, by, bytes: clean.jpeg.length, width, height, ms, ...times });
    json(res, 200, { ok: true, image: photoImageId(id) });
  }

  return {
    /** Handles the photo addresses (true), or leaves the request alone (false). */
    handle(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): boolean {
      if (url.pathname === '/api/photo') {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' }).end();
          return true;
        }
        upload(req, res, url, ip).catch((err) => {
          o.log.event('photo_upload_error', { error: String(err).slice(0, 300) });
          if (!res.headersSent) refuse(res, 500, 'unavailable');
          else res.destroy();
        });
        return true;
      }
      const m = /^\/api\/photo\/([A-Z]+)\/([A-Za-z0-9_-]+)\.jpg$/.exec(url.pathname);
      if (!m) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
        return true;
      }
      if (!isRoomCode(m[1]) || !isPhotoId(m[2])) {
        res.writeHead(404).end();
        return true;
      }
      serve(req, res, m[1], m[2]);
      return true;
    },
  };
}
