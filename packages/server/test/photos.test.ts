import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { photoIdOf, PHOTOS_PER_TABLE, photoUrl, Rng, type GameId, type ServerMessage } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import type { JigsawGame } from '../src/games/jigsaw';
import { RoomManager } from '../src/manager';
import { awsCredentials, judgeLabels, pretendChecker, RekognitionChecker, signV4, type ModerationLabel, type PhotoChecker } from '../src/photoCheck';
import { cleanJpeg, PHOTO_LIMITS, photoRoutes } from '../src/photos';
import { PuzzleStore } from '../src/puzzleStore';
import type { Conn, Room, RoomDeps } from '../src/room';

class FakeConn implements Conn {
  sent: ServerMessage[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}
type Pz = Extract<ServerMessage, { t: 'g' }>['m'];
const pz = <T extends Pz['t']>(c: FakeConn, t: T) => c.sent.flatMap((m) => (m.t === 'g' && m.m.t === t ? [m.m] : [])) as Extract<Pz, { t: T }>[];
const chats = (c: FakeConn) => c.sent.flatMap((m) => (m.t === 'chat' ? [m.msg.text] : []));

function play(room: Room, game: GameId) {
  const here = [...room.players.entries()].filter(([, p]) => p.conn);
  room.handle(here[0][0], { t: 'pick', game });
  for (const [s] of here) room.handle(s, { t: 'ready', ready: true });
}

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Two people at a jigsaw table, and the photo addresses on a real local web server. */
async function table(o: { checker?: PhotoChecker | null; deps?: Partial<RoomDeps> } = {}) {
  const clock = { now: 1_000_000 };
  const rng = new Rng(5);
  const log = new MemoryLog();
  const checker = o.checker === undefined ? pretendChecker : o.checker;
  const mgr = new RoomManager({
    now: () => clock.now,
    log,
    moderator: new ChatModerator(),
    emptyRoomMs: 60_000,
    publicReclaimMs: 60_000,
    maxPublicRooms: 10,
    maxPrivateRooms: 10,
    chatHistorySize: 10,
    randomInt: (n) => rng.int(0, n - 1),
    photoUploads: !!checker,
    ...o.deps,
  });
  const join = (session: string, code?: string) => {
    const lookup = mgr.resolve(code ? { kind: 'private', code } : { kind: 'create-private' }, session);
    if (!lookup.ok) throw new Error(lookup.code);
    const conn = new FakeConn();
    const r = lookup.room.join(conn, session, session.replace('session-', ''), 'desktop');
    if (!r.ok) throw new Error(r.code);
    lookup.room.sendWelcome(session, r);
    return { room: lookup.room, conn };
  };
  const a = join('session-aaaa');
  const b = join('session-bbbb', a.room.code);
  play(a.room, 'jigsaw');
  const routes = photoRoutes({ rooms: mgr.rooms, checker, log, now: () => clock.now });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!routes.handle(req, res, url, '203.0.113.9')) res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const upload = async (jpeg: Buffer, session = 'session-aaaa', type = 'image/jpeg') => {
    const res = await fetch(`${base}/api/photo?table=${a.room.code}`, { method: 'POST', headers: { 'content-type': type, 'x-gd-session': session }, body: new Uint8Array(jpeg) });
    return { status: res.status, body: (await res.json()) as { ok: boolean; image?: string; reason?: string } };
  };
  const send = (who: 'a' | 'b', m: object) => a.room.handle(`session-${who.repeat(4)}`, { t: 'g', m } as never);
  return { clock, log, mgr, room: a.room, a, b, base, upload, send, game: a.room.game as JigsawGame };
}

/** A photo as a phone would send it (a plain JPEG), optionally with camera and location details. */
const photo = (width: number, height: number, exif = false) => {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 60 } } }).jpeg({ quality: 80 });
  if (exif) img = img.withExif({ IFD0: { Make: 'PhoneCo', Model: 'Pocket 9' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '41/1 24/1 0/1' } });
  return img.toBuffer();
};

describe('what the photo check refuses', () => {
  const judge = (labels: ModerationLabel[]) => judgeLabels(labels);
  it('lets family photos through: swimsuits, a bare-chested dad, a kiss, drinks, cigarettes', () => {
    expect(judge([]).blocked).toBe(false);
    expect(judge([{ Name: 'Swimwear or Underwear', ParentName: '' }, { Name: 'Female Swimwear or Underwear', ParentName: 'Swimwear or Underwear' }]).blocked).toBe(false);
    const nonExplicit = { Name: 'Non-Explicit Nudity of Intimate parts and Kissing', ParentName: '' };
    expect(judge([{ Name: 'Exposed Male Nipple', ParentName: 'Non-Explicit Nudity' }, { Name: 'Non-Explicit Nudity', ParentName: nonExplicit.Name }, nonExplicit]).blocked).toBe(false);
    expect(judge([{ Name: 'Kissing on the Lips', ParentName: nonExplicit.Name }, nonExplicit]).blocked).toBe(false);
    expect(judge([{ Name: 'Alcoholic Beverages', ParentName: 'Alcohol' }, { Name: 'Alcohol' }]).blocked).toBe(false);
    expect(judge([{ Name: 'Smoking', ParentName: 'Drugs & Tobacco' }, { Name: 'Drugs & Tobacco' }]).blocked).toBe(false);
    // The older label names too.
    expect(judge([{ Name: 'Male Swimwear Or Underwear', ParentName: 'Suggestive' }, { Name: 'Suggestive' }]).blocked).toBe(false);
  });

  it('refuses nudity, sexual content, violence, disturbing images, hate symbols and rude gestures', () => {
    const nonExplicit = 'Non-Explicit Nudity of Intimate parts and Kissing';
    const partial = judge([{ Name: 'Partially Exposed Female Breast', ParentName: 'Non-Explicit Nudity' }, { Name: 'Non-Explicit Nudity', ParentName: nonExplicit }, { Name: nonExplicit }]);
    expect(partial).toEqual({ blocked: true, categories: [nonExplicit.toLowerCase()] });
    expect(judge([{ Name: 'Explicit Nudity', ParentName: 'Explicit' }, { Name: 'Explicit' }]).categories).toEqual(['explicit']);
    expect(judge([{ Name: 'Graphic Violence', ParentName: 'Violence' }, { Name: 'Violence' }]).blocked).toBe(true);
    expect(judge([{ Name: 'Visually Disturbing' }]).blocked).toBe(true);
    expect(judge([{ Name: 'Middle Finger', ParentName: 'Rude Gestures' }]).blocked).toBe(true);
    expect(judge([{ Name: 'Nazi Party', ParentName: 'Hate Symbols' }, { Name: 'Hate Symbols' }]).blocked).toBe(true);
    expect(judge([{ Name: 'Partial Nudity', ParentName: 'Suggestive' }, { Name: 'Suggestive' }]).blocked).toBe(true);
    // One bad thing is enough, whatever else is in the picture.
    expect(judge([{ Name: 'Swimwear or Underwear' }, { Name: 'Middle Finger', ParentName: 'Rude Gestures' }, { Name: 'Rude Gestures' }]).categories).toEqual(['rude gestures']);
  });
});

describe('asking Amazon Rekognition', () => {
  const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const at = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));

  it('signs requests the way AWS does (its own published examples)', () => {
    const sign = (method: string) => signV4({ method, host: 'example.amazonaws.com', path: '/', headers: {}, body: '', region: 'us-east-1', service: 'service', credentials: creds, now: at });
    expect(sign('GET').authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(sign('POST').authorization).toContain('Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');
    // Temporary credentials (a box's role) sign their token too.
    const withToken = signV4({ method: 'POST', host: 'h', path: '/', headers: {}, body: '', region: 'r', service: 's', credentials: { ...creds, sessionToken: 'tok' }, now: at });
    expect(withToken['x-amz-security-token']).toBe('tok');
    expect(withToken.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
  });

  function fakeFetch(status: number, body: object | string) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it('sends the photo itself in the request, signed, and reads the labels back', async () => {
    const f = fakeFetch(200, { ModerationLabels: [{ Name: 'Violence', ParentName: '', Confidence: 91 }], ModerationModelVersion: '7.0' });
    const check = new RekognitionChecker({ region: 'us-east-2', credentials: async () => ({ ...creds, sessionToken: 'tok' }), fetch: f.fn });
    const jpeg = Buffer.from('not really a jpeg');
    expect(await check.check(jpeg)).toEqual({ ok: false, reason: 'blocked', categories: ['violence'] });
    const { url, init } = f.calls[0];
    expect(url).toBe('https://rekognition.us-east-2.amazonaws.com/');
    const h = init.headers as Record<string, string>;
    expect(h['x-amz-target']).toBe('RekognitionService.DetectModerationLabels');
    expect(h['content-type']).toBe('application/x-amz-json-1.1');
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-2\/rekognition\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/);
    expect(h.host).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ Image: { Bytes: jpeg.toString('base64') }, MinConfidence: 60 });

    const fine = new RekognitionChecker({ region: 'us-east-2', credentials: async () => creds, fetch: fakeFetch(200, { ModerationLabels: [] }).fn });
    expect(await fine.check(jpeg)).toEqual({ ok: true });
  });

  it('a picture it cannot read is the photo’s fault; any other error is ours (and the photo is refused)', async () => {
    const bad = new RekognitionChecker({ region: 'us-east-2', credentials: async () => creds, fetch: fakeFetch(400, { __type: 'InvalidImageFormatException' }).fn });
    expect(await bad.check(Buffer.from('x'))).toEqual({ ok: false, reason: 'bad-image' });
    const denied = new RekognitionChecker({ region: 'us-east-2', credentials: async () => creds, fetch: fakeFetch(400, { __type: 'AccessDeniedException' }).fn });
    await expect(denied.check(Buffer.from('x'))).rejects.toThrow(/Rekognition 400/);
  });

  it('uses the box’s own role from the EC2 metadata service, and keeps it until near expiry', async () => {
    const asked: string[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      asked.push(`${init.method ?? 'GET'} ${url.replace('http://169.254.169.254/latest', '')}`);
      if (url.endsWith('/api/token')) return new Response('TOKEN');
      expect((init.headers as Record<string, string>)['x-aws-ec2-metadata-token']).toBe('TOKEN');
      if (url.endsWith('/security-credentials/')) return new Response('GamesDrawerServerRole\n');
      return new Response(JSON.stringify({ AccessKeyId: 'ASIA1', SecretAccessKey: 'sec', Token: 'tok', Expiration: new Date(Date.now() + 3_600_000).toISOString() }));
    }) as unknown as typeof fetch;
    const get = awsCredentials({}, fn);
    expect(await get()).toMatchObject({ accessKeyId: 'ASIA1', secretAccessKey: 'sec', sessionToken: 'tok' });
    await get();
    expect(asked).toEqual(['PUT /api/token', 'GET /meta-data/iam/security-credentials/', 'GET /meta-data/iam/security-credentials/GamesDrawerServerRole']);
    // Keys in the environment win (for trying it from a computer).
    expect(await awsCredentials({ AWS_ACCESS_KEY_ID: 'AKIA2', AWS_SECRET_ACCESS_KEY: 's2' }, fn)()).toEqual({ accessKeyId: 'AKIA2', secretAccessKey: 's2', sessionToken: undefined });
  });
});

describe('cleaning a JPEG', () => {
  it('drops camera and location details, keeps the picture and reads its size', async () => {
    const raw = await photo(640, 480, true);
    expect((await sharp(raw).metadata()).exif).toBeDefined();
    expect(raw.includes(Buffer.from('PhoneCo'))).toBe(true);
    const clean = cleanJpeg(raw)!;
    expect(clean).toMatchObject({ width: 640, height: 480 });
    expect(clean.jpeg.includes(Buffer.from('PhoneCo'))).toBe(false);
    expect(clean.jpeg.includes(Buffer.from('Exif'))).toBe(false);
    const meta = await sharp(clean.jpeg).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 640, height: 480 });
    expect(meta.exif).toBeUndefined();
  });

  it('refuses what isn’t a JPEG it can follow', async () => {
    expect(cleanJpeg(Buffer.from('hello'))).toBeNull();
    expect(cleanJpeg(await sharp({ create: { width: 400, height: 400, channels: 3, background: '#fff' } }).png().toBuffer())).toBeNull();
    const cut = await photo(400, 400);
    expect(cleanJpeg(cut.subarray(0, 20))).toBeNull();
  });
});

describe('your own photos at a table', () => {
  it('someone at the table adds one: it’s checked, kept in memory, and everyone at the table gets it', async () => {
    const t = await table();
    expect(pz(t.b.conn, 'pz-photos').at(-1)).toEqual({ t: 'pz-photos', on: true, photos: [] });
    const r = await t.upload(await photo(900, 600, true));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const id = photoIdOf(r.body.image!)!;
    const listed = pz(t.b.conn, 'pz-photos').at(-1)!.photos;
    expect(listed).toEqual([{ image: r.body.image, url: photoUrl(t.room.code, id), title: 'aaaa’s photo', width: 900, height: 600 }]);
    expect(chats(t.b.conn).at(-1)).toBe('aaaa added a photo for a puzzle.');
    const got = await fetch(t.base + listed[0].url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(got.headers.get('cache-control')).toBe('no-store');
    const bytes = Buffer.from(await got.arrayBuffer());
    expect(bytes.includes(Buffer.from('PhoneCo'))).toBe(false);
    expect(t.log.events.find((e) => e.type === 'photo_added')).toMatchObject({ room: t.room.code, width: 900, height: 600 });
    // The log never holds the photo, or the session.
    expect(JSON.stringify(t.log.events)).not.toContain('session-aaaa');
    // A made-up id finds nothing.
    expect((await fetch(`${t.base}/api/photo/${t.room.code}/AAAAAAAAAAAAAAAAAAAAAA.jpg`)).status).toBe(404);
  });

  it('only people at the table can add one, and only a real photo of a sensible size', async () => {
    const t = await table();
    const ok = await photo(600, 400);
    expect((await t.upload(ok, 'session-zzzz')).body).toEqual({ ok: false, reason: 'not-at-table' });
    expect((await t.upload(ok, '')).status).toBe(403);
    expect((await t.upload(ok, 'session-aaaa', 'image/png')).body.reason).toBe('not-image');
    expect((await t.upload(Buffer.from('not a photo at all'))).body.reason).toBe('not-image');
    expect((await t.upload(await photo(250, 250))).body.reason).toBe('too-small');
    expect((await t.upload(await photo(3000, 400))).body.reason).toBe('too-big');
    expect(t.room.photos.size).toBe(0);
  });

  it('a photo that doesn’t pass is thrown away, and the log says what kind of thing was found', async () => {
    const t = await table();
    const r = await t.upload(await photo(404, 300));
    expect(r).toEqual({ status: 422, body: { ok: false, reason: 'blocked' } });
    expect(t.room.photos.size).toBe(0);
    expect(t.log.events.find((e) => e.type === 'photo_refused')).toMatchObject({ reason: 'blocked', categories: ['pretend'] });
  });

  it('if the check can’t be done, the photo is refused, never let through', async () => {
    const t = await table({ checker: { name: 'down', check: async () => Promise.reject(new Error('no route')) } });
    expect((await t.upload(await photo(600, 400))).body).toEqual({ ok: false, reason: 'unavailable' });
    expect(t.room.photos.size).toBe(0);
    expect(t.log.events.find((e) => e.type === 'photo_check_failed')).toMatchObject({ checker: 'down' });
  });

  it('is off without a check: the picker isn’t told it’s on, and uploads are refused', async () => {
    const t = await table({ checker: null });
    expect(pz(t.a.conn, 'pz-photos').at(-1)).toMatchObject({ on: false });
    expect((await t.upload(await photo(600, 400))).body.reason).toBe('off');
  });

  it('a puzzle of a photo is never saved, and says so when put away', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-photos-'));
    try {
      const store = new PuzzleStore(dir);
      const t = await table({ deps: { puzzles: store } });
      const { image } = (await t.upload(await photo(900, 600))).body;
      t.send('b', { t: 'pz-new', image, pieces: 20 });
      const s = t.game.state!;
      expect(s).toMatchObject({ image, imageFile: photoUrl(t.room.code, photoIdOf(image!)!), title: 'aaaa’s photo', width: 900, height: 600 });
      // Place a piece, wait past the save delay: nothing on disk.
      const pw = s.width / s.cols;
      t.send('b', { t: 'pz-grab', piece: 1 });
      t.send('b', { t: 'pz-drop', x: s.pieces[0].x + pw, y: s.pieces[0].y });
      for (let i = 0; i < 120; i++) {
        t.clock.now += 50;
        t.mgr.stepAll();
      }
      await store.flush();
      expect(fs.readdirSync(dir)).toEqual([]);
      t.send('b', { t: 'pz-setup' });
      expect(chats(t.a.conn).at(-1)).toBe("bbbb put the puzzle away. Puzzles of your own photos aren't saved.");
      await store.flush();
      expect(fs.readdirSync(dir)).toEqual([]);
      // A photo the table doesn't have can't be puzzled.
      t.send('b', { t: 'pz-new', image: 'photo-AAAAAAAAAAAAAAAAAAAAAA', pieces: 20 });
      expect(t.game.phase).toBe('setup');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`keeps ${PHOTOS_PER_TABLE} photos a table: a new one lets go of the oldest not being puzzled`, async () => {
    const t = await table();
    const images: string[] = [];
    for (let i = 0; i < PHOTOS_PER_TABLE; i++) images.push((await t.upload(await photo(600 + i, 400))).body.image!);
    t.send('a', { t: 'pz-new', image: images[0], pieces: 20 });
    const fifth = (await t.upload(await photo(700, 400))).body.image!;
    const kept = [...t.room.photos.keys()].map((id) => `photo-${id}`);
    expect(kept).toHaveLength(PHOTOS_PER_TABLE);
    expect(kept).toContain(images[0]); // the one being puzzled stays
    expect(kept).not.toContain(images[1]); // the oldest of the rest goes
    expect(kept).toContain(fifth);
  });

  it('is deleted when the table closes', async () => {
    const t = await table();
    const { image } = (await t.upload(await photo(600, 400))).body;
    const url = photoUrl(t.room.code, photoIdOf(image!)!);
    expect((await fetch(t.base + url)).status).toBe(200);
    t.room.close('empty');
    expect(t.room.photos.size).toBe(0);
    expect((await fetch(t.base + url)).status).toBe(404);
  });

  it(`takes ${PHOTO_LIMITS.perIpPerHour} photos an hour from one address`, async () => {
    const t = await table();
    const p = await photo(600, 400);
    for (let i = 0; i < PHOTO_LIMITS.perIpPerHour; i++) expect((await t.upload(p)).status).toBe(200);
    expect((await t.upload(p)).body).toEqual({ ok: false, reason: 'busy' });
    t.clock.now += 3_600_000;
    expect((await t.upload(p)).status).toBe(200);
  });
});

describe('piece counts follow the picture’s size', () => {
  it('asking for more pieces than a small picture offers gets its most', async () => {
    const t = await table();
    t.send('a', { t: 'pz-new', image: 'noodle', pieces: 500 }); // 763 x 521: up to 100
    const s = t.game.state!;
    expect(s.cols * s.rows).toBeLessThanOrEqual(110);
    expect(Math.min(s.width / s.cols, s.height / s.rows)).toBeGreaterThanOrEqual(60);
    t.send('a', { t: 'pz-setup' });
    // A small photo of your own, too.
    const { image } = (await t.upload(await photo(640, 480))).body;
    t.send('a', { t: 'pz-new', image, pieces: 250 });
    expect(t.game.state!.cols * t.game.state!.rows).toBeLessThanOrEqual(55);
  });
});

describe('finished puzzles', () => {
  it('are deleted from disk once the table finishes one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-done-'));
    try {
      const store = new PuzzleStore(dir);
      const t = await table({ deps: { puzzles: store } });
      t.send('a', { t: 'pz-new', image: 'dog', pieces: 6 });
      const s = t.game.state!;
      const pw = s.width / s.cols;
      const ph = s.height / s.rows;
      const place = (i: number) => {
        t.send('a', { t: 'pz-grab', piece: i });
        t.send('a', { t: 'pz-drop', x: (i % s.cols) * pw + 2, y: Math.floor(i / s.cols) * ph + 2 });
      };
      place(0);
      for (let i = 0; i < 120; i++) {
        t.clock.now += 50;
        t.mgr.stepAll();
      }
      await store.flush();
      expect(fs.readdirSync(dir)).toEqual([`${s.id}.json`]);
      for (let i = 1; i < s.pieces.length; i++) place(i);
      expect(t.game.phase).toBe('done');
      await store.flush();
      expect(fs.readdirSync(dir)).toEqual([]);
      t.send('a', { t: 'pz-setup' });
      expect(chats(t.a.conn).at(-1)).toBe('aaaa put the finished puzzle away.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('old finished saves are swept away', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-done-'));
    try {
      const store = new PuzzleStore(dir);
      const s = {
        id: 'abcdefghijklmnop',
        image: 'dog',
        imageFile: '/puzzles/dog.jpg',
        title: 'Penny Pickles',
        width: 1600,
        height: 1067,
        cols: 3,
        rows: 2,
        seed: 1,
        pieces: Array.from({ length: 6 }, () => ({ x: 0, y: 0, g: 0 })),
        locked: [0],
        createdAt: 1,
        updatedAt: Date.now(),
        doneAt: Date.now(),
      };
      store.save(s);
      await store.flush();
      expect(fs.readdirSync(dir)).toHaveLength(1);
      await store.sweep(Date.now());
      expect(fs.readdirSync(dir)).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
