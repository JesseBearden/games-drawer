import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashAdminPassword, isAdminPasswordHash, issueAdminSession, verifyAdminPassword, verifyAdminSession, ADMIN_SESSION_MS } from '../src/adminAuth';
import { dayRange, logFolders, readLogs, summarize } from '../src/adminStats';
import { MemoryLog, pruneLogs } from '../src/eventlog';
import { startGameServer, type GameServer } from '../src/server';

// A made-up password for tests (the real one is never in the repo).
const PASSWORD = 'correct horse battery';
const HASH = hashAdminPassword(PASSWORD);

describe('the admin password', () => {
  it('checks the password against its hash, and the hash never contains it', async () => {
    expect(isAdminPasswordHash(HASH)).toBe(true);
    expect(HASH).not.toContain(PASSWORD);
    expect(await verifyAdminPassword(PASSWORD, HASH)).toBe(true);
    expect(await verifyAdminPassword('correct horse batter', HASH)).toBe(false);
    expect(await verifyAdminPassword('', HASH)).toBe(false);
    // Each hash is salted: the same password hashes differently every time.
    expect(hashAdminPassword(PASSWORD)).not.toBe(HASH);
    expect(isAdminPasswordHash('hunter2')).toBe(false);
    expect(await verifyAdminPassword(PASSWORD, 'hunter2')).toBe(false);
  });

  it('signs people in for a week; a tampered cookie or a new password signs them out', () => {
    const now = 1_800_000_000_000;
    const token = issueAdminSession(HASH, now);
    expect(verifyAdminSession(token, HASH, now + 1000)).toBe(true);
    expect(verifyAdminSession(token, HASH, now + ADMIN_SESSION_MS + 1)).toBe(false);
    const [until, mac] = token.split('.');
    expect(verifyAdminSession(`${Number(until) + 1}.${mac}`, HASH, now)).toBe(false);
    expect(verifyAdminSession(token, hashAdminPassword('a different password'), now)).toBe(false);
    expect(verifyAdminSession(undefined, HASH, now)).toBe(false);
  });
});

describe('the admin numbers', () => {
  const at = (day: string, h = 12) => `${day}T${String(h).padStart(2, '0')}:00:00.000Z`;
  const H = 3_600_000;
  const session = (day: string, game: string, o: Record<string, unknown>) => ({ type: 'game_session', at: at(day), game, endedBy: 'lobby', ...o });

  it('ranks games by play, and shows which ones get people playing together', () => {
    const days = dayRange('2026-11-17', 7);
    expect(days[0]).toBe('2026-11-11');
    expect(days.at(-1)).toBe('2026-11-17');
    const events = [
      // Jigsaw: two long games, mostly with two or three people.
      session('2026-11-16', 'jigsaw', { activeMs: 2 * H, groupMs: 1.5 * H, personMs: 4 * H, peak: 3, pids: ['p1', 'p2', 'p3'], chats: 12 }),
      session('2026-11-17', 'jigsaw', { activeMs: 1 * H, groupMs: 1 * H, personMs: 2 * H, peak: 2, pids: ['p1', 'p2'], chats: 0 }),
      // Tanks: one game alone.
      session('2026-11-17', 'tanks', { activeMs: 0.5 * H, groupMs: 0, personMs: 0.5 * H, peak: 1, pids: ['p4'], chats: 0 }),
      // A room that opened Hearts but nobody played: not a game played.
      session('2026-11-17', 'hearts', { activeMs: 0, groupMs: 0, personMs: 0, peak: 0, pids: [], chats: 0 }),
      { type: 'game_start', at: at('2026-11-17'), game: 'hearts' },
      // Outside the 7 days: ignored.
      session('2026-11-01', 'tanks', { activeMs: 9 * H, personMs: 9 * H, peak: 1, pids: ['old'] }),
      { type: 'join', at: at('2026-11-16'), pid: 'p1', roomKind: 'private' },
      { type: 'join', at: at('2026-11-17'), pid: 'p1', roomKind: 'private' },
      { type: 'join', at: at('2026-11-17'), pid: 'p4', roomKind: 'public' },
      { type: 'room_created', at: at('2026-11-16'), roomKind: 'private' },
    ];
    const chats = [
      ...Array.from({ length: 12 }, () => ({ at: at('2026-11-16'), outcome: 'delivered' })),
      { at: at('2026-11-16'), outcome: 'blocked' },
      { at: at('2026-11-17'), outcome: 'reported' },
    ];
    const s = summarize(events, chats, days);
    expect(s.games.map((g) => g.game).slice(0, 2)).toEqual(['jigsaw', 'tanks']);
    const jigsaw = s.games[0];
    expect(jigsaw).toMatchObject({ sessions: 2, playHours: 3, personHours: 6, groupShare: 0.83, groupSessions: 2, avgPeak: 2.5, maxPeak: 3, players: 3, avgMinutes: 90, chats: 12, chatsPerPersonHour: 2 });
    expect(s.games.find((g) => g.game === 'tanks')).toMatchObject({ sessions: 1, groupShare: 0, groupSessions: 0 });
    expect(s.games.find((g) => g.game === 'hearts')).toMatchObject({ sessions: 0, picks: 1 });
    expect(s).toMatchObject({ players: 2, privateRooms: 1, publicJoins: 1, sessions: 3, personHours: 6.5 });
    expect(s.chat).toMatchObject({ delivered: 12, blocked: 1, reported: 1, sessionsWithChat: 1 });
    expect(s.daily.find((d) => d.day === '2026-11-16')).toMatchObject({ players: 1, rooms: 1, sessions: 1, personHours: 4, chats: 12 });
    expect(s.voice).toEqual({ links: 0, relayed: 0, failed: 0, people: 0, peopleRelayed: 0, peopleFailed: 0 });
  });

  it('counts people by device: several tabs on one computer are one person', () => {
    const days = dayRange('2026-11-17', 7);
    const join = (pid: string, did?: string) => ({ type: 'join', at: at('2026-11-17'), pid, roomKind: 'private', ...(did && { did }) });
    // You test in three tabs on the computer and one on the phone; a friend plays once; an old
    // tab from before device numbers counts on its own.
    const events = [
      join('tab1', 'computer'), join('tab2', 'computer'), join('tab3', 'computer'), join('tab4', 'phone'),
      join('friend', 'friends-ipad'),
      join('old-tab'),
      session('2026-11-17', 'jigsaw', { activeMs: H, groupMs: H, personMs: 3 * H, peak: 3, pids: ['tab1', 'tab2', 'friend'] }),
      { type: 'voice_link', at: at('2026-11-17'), pid: 'tab1', route: 'direct' },
      { type: 'voice_link', at: at('2026-11-17'), pid: 'tab2', route: 'direct' },
    ];
    const s = summarize(events, [], days);
    expect(s.players).toBe(4);
    expect(s.daily.at(-1)!.players).toBe(4);
    expect(s.games.find((g) => g.game === 'jigsaw')!.players).toBe(2);
    expect(s.voice.people).toBe(1);
  });

  it('counts how often voice needed the relay, or never connected', () => {
    const days = dayRange('2026-11-17', 7);
    const link = (pid: string, route: string) => ({ type: 'voice_link', at: at('2026-11-17'), pid, route });
    // Four people in voice: p1 is on phone data and needs the relay for all three links;
    // p4 can't reach p2 at all.
    const events = [
      link('p1', 'relayed'), link('p1', 'relayed'), link('p1', 'relayed'),
      link('p2', 'relayed'), link('p2', 'direct'), link('p2', 'failed'),
      link('p3', 'relayed'), link('p3', 'direct'), link('p3', 'direct'),
      link('p4', 'relayed'), link('p4', 'failed'), link('p4', 'direct'),
    ];
    const s = summarize(events, [], days);
    expect(s.voice).toEqual({ links: 12, relayed: 6, failed: 2, people: 4, peopleRelayed: 4, peopleFailed: 2 });
  });

  it('adds up every box’s logs: the folder given and the folders inside it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-logs-'));
    try {
      const line = (pid: string) => JSON.stringify({ type: 'join', at: '2026-11-17T12:00:00.000Z', pid, roomKind: 'private' }) + '\n';
      // On AWS each box writes to logs/<instance>; one box has shut down since.
      for (const [box, pid] of [['i-old', 'p1'], ['i-new', 'p2']]) {
        fs.mkdirSync(path.join(root, box));
        fs.writeFileSync(path.join(root, box, 'events-2026-11-17.jsonl'), line(pid));
      }
      fs.writeFileSync(path.join(root, 'events-2026-11-17.jsonl'), line('p3'));
      expect(logFolders([root]).sort()).toEqual([root, path.join(root, 'i-new'), path.join(root, 'i-old')].sort());
      const { events } = await readLogs([root], ['2026-11-17']);
      expect(events.map((e) => e.pid).sort()).toEqual(['p1', 'p2', 'p3']);
      // A folder that isn't there yet is fine.
      expect(logFolders([path.join(root, 'nope')])).toEqual([path.join(root, 'nope')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes logs more than 30 days old, from every box, and a shut-down box’s empty folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-logs-'));
    try {
      const now = Date.parse('2026-12-31T12:00:00Z');
      // Kept: 30 days back (Dec 1) and newer. Gone: Nov 30 and older.
      for (const box of ['i-old', 'i-new']) fs.mkdirSync(path.join(root, box));
      const files = {
        'i-old/events-2026-11-20.jsonl': false,
        'i-old/chat-2026-11-30.jsonl': false,
        'i-new/events-2026-11-30.jsonl': false,
        'i-new/events-2026-12-01.jsonl': true,
        'i-new/chat-2026-12-31.jsonl': true,
        'events-2026-10-01.jsonl': false,
        'notes.txt': true,
      };
      for (const f of Object.keys(files)) fs.writeFileSync(path.join(root, f), '{}\n');
      expect(pruneLogs([path.join(root, 'i-new'), root], { now, keepDir: path.join(root, 'i-new') })).toBe(4);
      for (const [f, kept] of Object.entries(files)) expect(fs.existsSync(path.join(root, f)), f).toBe(kept);
      // The old box's folder is empty now and goes; this box's own folder stays even if empty.
      expect(fs.existsSync(path.join(root, 'i-old'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'i-new'))).toBe(true);
      // Nothing there, or a folder that isn't there, is fine.
      expect(pruneLogs([path.join(root, 'nope')], { now })).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the admin page', () => {
  let server: GameServer | null = null;
  let logDir = '';
  afterEach(async () => {
    await server?.close();
    server = null;
    if (logDir) fs.rmSync(logDir, { recursive: true, force: true });
  });

  async function start(passwordHash?: string) {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-admin-'));
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(logDir, `events-${today}.jsonl`),
      JSON.stringify({ type: 'game_session', at: new Date().toISOString(), game: 'jigsaw', activeMs: 3_600_000, groupMs: 1_800_000, personMs: 5_400_000, peak: 2, pids: ['a', 'b'], chats: 3 }) + '\n',
    );
    server = await startGameServer({
      port: 0,
      host: '127.0.0.1',
      production: false,
      clientDist: '',
      log: new MemoryLog(),
      emptyRoomMs: 60_000,
      publicReclaimMs: 60_000,
      maxPublicRooms: 10,
      maxPrivateRooms: 10,
      allowedOrigins: null,
      trustProxy: false,
      adminPasswordHash: passwordHash,
      adminLogDirs: [logDir],
    });
    return `http://127.0.0.1:${server.port}`;
  }

  const login = (base: string, password: string) =>
    fetch(`${base}/admin/login`, { method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual' });

  it('doesn’t exist without a password hash set', async () => {
    const base = await start(undefined);
    expect((await fetch(`${base}/admin`)).status).toBe(404);
    expect((await login(base, PASSWORD)).status).toBe(404);
  });

  it('asks for the password, then shows the numbers', async () => {
    const base = await start(HASH);
    const first = await fetch(`${base}/admin`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const html = await first.text();
    expect(html).toContain('type="password"');
    expect(html).not.toContain('Person-hours');

    const wrong = await login(base, 'not it at all');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();

    const ok = await login(base, PASSWORD);
    expect(ok.status).toBe(303);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^gd_admin=\d+\.[0-9a-f]{64}; Path=\/admin; HttpOnly; SameSite=Strict/);
    const page = await fetch(`${base}/admin?days=30`, { headers: { cookie: cookie.split(';')[0] } });
    const stats = await page.text();
    expect(stats).toContain('Person-hours');
    expect(stats).toContain('<td>Jigsaw</td>');
    expect(stats).toContain('50%'); // half the jigsaw time had two people
    // Nothing about the password or its hash ever goes to the browser.
    for (const text of [html, stats]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(HASH.split('$').at(-1)!);
    }
  });

  it('stops guessing after a few wrong passwords', async () => {
    const base = await start(HASH);
    for (let i = 0; i < 5; i++) expect((await login(base, `guess number ${i}`)).status).toBe(401);
    // Even the right password waits now.
    expect((await login(base, PASSWORD)).status).toBe(429);
  });

  it('a burst of tries sent all at once gets no more than the usual few checked', async () => {
    const base = await start(HASH);
    const codes = (await Promise.all(Array.from({ length: 20 }, (_, i) => login(base, `burst guess ${i}`)))).map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(15);
    expect((await login(base, PASSWORD)).status).toBe(429);
  });
});
