/** The minute counts that go to CloudWatch (metrics.ts): who counts, what's sent, and how. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { GAME_IDS, PROTOCOL_VERSION, parseClientMessage } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { RoomManager } from '../src/manager';
import {
  CloudWatchPublisher,
  devicesInLogs,
  DevicesToday,
  METRICS_NAMESPACE,
  minuteMetrics,
  putMetricDataBody,
  startMinuteMetrics,
  takesNewTables,
  type CensusEntry,
  type MetricDatum,
} from '../src/metrics';
import { devicePseudonym, type Conn } from '../src/room';
import { startGameServer } from '../src/server';

const DEV_A = 'a'.repeat(32);
const DEV_B = 'b'.repeat(32);

function table() {
  const clock = { now: Date.parse('2026-11-26T15:00:00Z') };
  const log = new MemoryLog();
  const seen: string[] = [];
  const mgr = new RoomManager({
    now: () => clock.now,
    log,
    moderator: new ChatModerator(),
    emptyRoomMs: 3_600_000,
    idleRoomMs: 3_600_000,
    maxPrivateRooms: 10,
    chatHistorySize: 10,
    seen: (key) => seen.push(key),
  });
  const open = () => {
    const made = mgr.resolve({ kind: 'create-private' }, 'starter');
    if (!made.ok) throw new Error(made.code);
    return made.room;
  };
  return { clock, log, seen, mgr, open };
}

const conn = (over: Partial<Conn> = {}): Conn => ({ send() {}, close() {}, ...over });

describe('who counts', () => {
  it('a device at a table once, however many tabs; someone away or automated not at all', () => {
    const t = table();
    const room = t.open();
    room.join(conn(), 's1', 'Mom', 'phone', DEV_A);
    room.join(conn(), 's2', 'Mom again', 'desktop', DEV_A); // a second tab on the same device
    room.join(conn(), 's3', 'Liz', 'phone'); // no device number (storage off): counted by seat
    room.join(conn({ test: true }), 's4', 'Robot', 'desktop', DEV_B);
    const away = conn();
    room.join(away, 's5', 'Dad', 'phone', 'c'.repeat(32));
    room.disconnect('s5', away, 'disconnect');

    const people = t.mgr.census();
    expect(people).toHaveLength(3);
    expect(new Set(people.map((p) => p.key)).size).toBe(2);
    expect(people.every((p) => p.game === 'lobby')).toBe(true);
    const sent = minuteMetrics(people, 2);
    expect(sent.find((d) => d.name === 'People' && !d.dims)?.value).toBe(2);
    expect(sent.find((d) => d.dims?.Game === 'lobby')?.value).toBe(2);
  });

  it('marks test joins in the log, and only counts the rest toward today', () => {
    const t = table();
    const room = t.open();
    room.join(conn(), 's1', 'Mom', 'phone', DEV_A);
    room.join(conn({ test: true }), 's2', 'Robot', 'desktop', DEV_B);
    const joins = t.log.events.filter((e) => e.type === 'join');
    expect(joins.map((e) => e.test ?? false)).toEqual([false, true]);
    expect(joins[0].did).toMatch(/^[0-9a-f]{16}$/);
    expect(t.seen).toEqual([joins[0].did]);
  });

  it('counts each person under the game their table is playing', () => {
    const t = table();
    const room = t.open();
    room.join(conn(), 's1', 'Mom', 'phone', DEV_A);
    room.handle('s1', { t: 'pick', game: 'tanks' });
    room.handle('s1', { t: 'ready', ready: true });
    expect(room.game?.id).toBe('tanks');
    expect(t.mgr.census().map((p) => p.game)).toEqual(['tanks']);
  });

  it('knows who is in voice, and who goes through the relay to someone still in it', () => {
    const t = table();
    const room = t.open();
    room.join(conn(), 's1', 'Mom', 'phone', DEV_A);
    room.join(conn(), 's2', 'Liz', 'phone', DEV_B);
    room.handle('s1', { t: 'voice', join: true });
    room.handle('s2', { t: 'voice', join: true });
    const liz = room.players.get('s2')!.alias;
    room.handle('s1', { t: 'voice-route', to: liz, route: 'relayed' });
    const mom = devicePseudonym(DEV_A);
    const byName = () => Object.fromEntries(t.mgr.census().map((p) => [p.key === mom ? 'mom' : 'liz', p]));
    expect(byName().mom).toMatchObject({ inVoice: true, relayed: true });
    expect(byName().liz).toMatchObject({ inVoice: true, relayed: false });

    // A new route replaces the old one (the link was restarted and went direct).
    room.handle('s1', { t: 'voice-route', to: liz, route: 'direct' });
    expect(byName().mom.relayed).toBe(false);
    room.handle('s1', { t: 'voice-route', to: liz, route: 'relayed' });
    // Liz leaving voice ends Mom's relayed link; Mom leaving forgets her routes.
    room.handle('s2', { t: 'voice', join: false });
    expect(byName().mom.relayed).toBe(false);
    room.handle('s2', { t: 'voice', join: true });
    expect(byName().mom.relayed).toBe(true);
    room.handle('s1', { t: 'voice', join: false });
    room.handle('s1', { t: 'voice', join: true });
    expect(byName().mom.relayed).toBe(false);
  });
});

describe('what a minute sends', () => {
  const entry = (key: string, game: CensusEntry['game'], inVoice = false, relayed = false): CensusEntry => ({ key, game, inVoice, relayed });

  it('leaves zeros out (the user, 2026-11-26), and sends nothing at all for nobody', () => {
    expect(minuteMetrics([], 0)).toEqual([]);
    const sent = minuteMetrics([entry('a', 'hearts', true), entry('b', 'hearts'), entry('a', 'tanks', true, true)], 4);
    expect(sent).toEqual([
      { name: 'People', value: 2 },
      { name: 'People', value: 1, dims: { Game: 'tanks' } },
      { name: 'People', value: 2, dims: { Game: 'hearts' } },
      { name: 'InVoice', value: 1 },
      { name: 'OnRelay', value: 1 },
      { name: 'DevicesToday', value: 4 },
    ]);
  });

  it('has a Game value for every game and the lobby', () => {
    const everyone = [...GAME_IDS, 'lobby' as const].map((g, i) => entry(String(i), g));
    expect(minuteMetrics(everyone, 0).filter((d) => d.dims?.Game)).toHaveLength(GAME_IDS.length + 1);
  });

  it('is CloudWatch’s PutMetricData, form-encoded', () => {
    const at = new Date('2026-11-26T15:04:00Z');
    const body = new URLSearchParams(
      putMetricDataBody(METRICS_NAMESPACE, [{ name: 'People', value: 3, dims: { Game: 'threethirteen' } }, { name: 'DevicesPerDay', value: 9, at: new Date('2026-11-25T12:00:00Z') }], at),
    );
    expect(Object.fromEntries(body)).toEqual({
      Action: 'PutMetricData',
      Version: '2010-08-01',
      Namespace: 'GamesDrawer',
      'MetricData.member.1.MetricName': 'People',
      'MetricData.member.1.Value': '3',
      'MetricData.member.1.Unit': 'Count',
      'MetricData.member.1.Timestamp': '2026-11-26T15:04:00.000Z',
      'MetricData.member.1.Dimensions.member.1.Name': 'Game',
      'MetricData.member.1.Dimensions.member.1.Value': 'threethirteen',
      'MetricData.member.2.MetricName': 'DevicesPerDay',
      'MetricData.member.2.Value': '9',
      'MetricData.member.2.Unit': 'Count',
      'MetricData.member.2.Timestamp': '2026-11-25T12:00:00.000Z',
    });
  });

  it('goes to the region’s CloudWatch, signed with the box’s role, and says why when refused', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 200 ? '<PutMetricDataResponse/>' : '<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>', { status });
    }) as unknown as typeof fetch;
    const cw = new CloudWatchPublisher({
      region: 'us-east-2',
      fetch: fetchFn,
      credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' }),
      now: () => new Date('2026-11-26T15:04:02Z'),
    });
    await cw.put([{ name: 'People', value: 1 }], new Date('2026-11-26T15:04:00Z'));
    expect(calls[0].url).toBe('https://monitoring.us-east-2.amazonaws.com/');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261126\/us-east-2\/monitoring\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(headers['x-amz-security-token']).toBe('token');
    expect(String(calls[0].init.body)).toContain('Namespace=GamesDrawer');
    status = 403;
    await expect(cw.put([{ name: 'People', value: 1 }], new Date())).rejects.toThrow('CloudWatch 403 AccessDenied');
  });

  it('uses the namespace the box’s role is allowed to write to', () => {
    const stack = fs.readFileSync(path.resolve(__dirname, '../../../infra/lib/stack.ts'), 'utf8');
    expect(stack).toContain(`export const METRICS_NAMESPACE = '${METRICS_NAMESPACE}';`);
  });
});

describe('different devices today', () => {
  it('starts again at midnight UTC, handing over the day that ended once', () => {
    const clock = { now: Date.parse('2026-11-26T23:58:00Z') };
    const d = new DevicesToday(() => clock.now);
    d.add('a');
    d.add('b');
    d.add('a');
    expect(d.count()).toBe(2);
    expect(d.takeFinishedDay()).toBeNull();
    clock.now = Date.parse('2026-11-27T00:00:02Z');
    expect(d.takeFinishedDay()).toEqual({ day: '2026-11-26', count: 2 });
    expect(d.takeFinishedDay()).toBeNull();
    expect(d.count()).toBe(0);
    // A seed read from yesterday's logs that finishes after midnight is dropped.
    d.addFromDay('2026-11-26', ['x', 'y']);
    expect(d.count()).toBe(0);
    d.addFromDay('2026-11-27', ['x', 'y']);
    expect(d.count()).toBe(2);
  });

  it('picks up the day so far from every box’s join lines, skipping tests and other days', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-metrics-'));
    try {
      fs.mkdirSync(path.join(dir, 'box1'));
      fs.mkdirSync(path.join(dir, 'box2'));
      const line = (o: object) => JSON.stringify({ id: 'x', at: '2026-11-26T10:00:00.000Z', ...o });
      fs.writeFileSync(
        path.join(dir, 'box1', 'events-2026-11-26.jsonl'),
        [line({ type: 'join', pid: 'p1', did: 'd1' }), line({ type: 'join', pid: 'p2' }), line({ type: 'join', pid: 'p3', did: 'd9', test: true }), line({ type: 'game_session', pid: 'p4' }), '{"type":"join","pi'].join('\n'),
      );
      fs.writeFileSync(path.join(dir, 'box2', 'events-2026-11-26.jsonl'), line({ type: 'join', pid: 'p5', did: 'd1' }) + '\n');
      fs.writeFileSync(path.join(dir, 'box2', 'events-2026-11-25.jsonl'), line({ type: 'join', pid: 'p6', did: 'd7' }) + '\n');
      expect([...(await devicesInLogs([dir], '2026-11-26'))].sort()).toEqual(['d1', 'p:p2']);
      expect(await devicesInLogs([path.join(dir, 'missing')], '2026-11-26')).toEqual(new Set());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('only the live site sends', () => {
  it('a box the fleet sends new tables to, even a canary’s share; not staging, nor a new box before the fleet says', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-fleet-'));
    try {
      const file = path.join(dir, 'fleet-map.json');
      expect(takesNewTables(file, 'b')).toBe(false); // no map yet
      const map = (newTables: [string, number][]) => fs.writeFileSync(file, JSON.stringify({ boxes: { a: '10.0.0.1', b: '10.0.0.2' }, newTables, staging: 'b' }));
      map([['a', 90], ['b', 10]]);
      expect(takesNewTables(file, 'b')).toBe(true);
      map([['a', 100]]);
      expect(takesNewTables(file, 'a')).toBe(true);
      expect(takesNewTables(file, 'b')).toBe(false); // staging shows b, but the site's tables go to a
      fs.writeFileSync(file, '{"newTa');
      expect(takesNewTables(file, 'a')).toBe(false);
      expect(takesNewTables(undefined, undefined)).toBe(true); // a server on its own
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the minute timer', () => {
  afterEach(() => vi.useRealTimers());

  const person = (key: string, game: CensusEntry['game'] = 'jigsaw'): CensusEntry => ({ key, game, inVoice: false, relayed: false });

  function run(start: string, census: () => CensusEntry[], live?: () => boolean) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(start));
    const sent: { data: readonly MetricDatum[]; at: Date }[] = [];
    let fail = false;
    const log = new MemoryLog();
    const devices = new DevicesToday();
    const stop = startMinuteMetrics({
      publisher: {
        put: async (data, at) => {
          sent.push({ data, at });
          if (fail) throw new Error('CloudWatch 403 AccessDenied');
        },
      },
      census,
      devices,
      log,
      live,
    });
    return { sent, log, devices, stop, failing: (f: boolean) => (fail = f) };
  }

  it('sends once a minute, stamped with the minute’s start, and nothing while nobody’s there', async () => {
    let people: CensusEntry[] = [];
    const r = run('2026-11-26T15:04:30Z', () => people);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.sent).toEqual([]);
    people = [person('a')];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].at.toISOString()).toBe('2026-11-26T15:06:00.000Z');
    expect(r.sent[0].data).toContainEqual({ name: 'People', value: 1, dims: { Game: 'jigsaw' } });
    expect(r.sent[0].data).toContainEqual({ name: 'DevicesToday', value: 1 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.sent.map((s) => s.at.getUTCMinutes())).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    r.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(r.sent).toHaveLength(11);
  });

  it('sends nothing at all from a box that isn’t live (staging), and starts once it is', async () => {
    let live = false;
    const r = run('2026-11-26T15:04:30Z', () => [person('a')], () => live);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(r.sent).toEqual([]);
    expect(r.devices.count()).toBe(0);
    live = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].at.toISOString()).toBe('2026-11-26T15:25:00.000Z');
    r.stop();
  });

  it('sends the day that ended just after midnight, stamped at its noon, even with nobody there', async () => {
    let people: CensusEntry[] = [person('a', 'hearts')];
    const r = run('2026-11-26T23:58:30Z', () => people);
    r.devices.add('b');
    await vi.advanceTimersByTimeAsync(60_000);
    people = [];
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    const perDay = r.sent.flatMap((s) => s.data.filter((d) => d.name === 'DevicesPerDay'));
    expect(perDay).toEqual([{ name: 'DevicesPerDay', value: 2, at: new Date('2026-11-26T12:00:00Z') }]);
    expect(r.sent.at(-1)!.data).toEqual(perDay);
    r.stop();
  });

  it('logs a failing send at most once an hour, and carries on', async () => {
    const r = run('2026-11-26T15:04:30Z', () => [person('a', 'lobby')]);
    r.failing(true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(r.sent).toHaveLength(30);
    expect(r.log.events.filter((e) => e.type === 'metrics_failed')).toHaveLength(1);
    spy.mockRestore();
    r.stop();
  });
});

describe('automated tests and the staging site', () => {
  it('a browser run by a program says so when it joins', () => {
    const hello = { t: 'hello', v: PROTOCOL_VERSION, session: null, name: 'x', room: { kind: 'create-private' }, device: 'desktop' };
    expect(parseClientMessage(JSON.stringify({ ...hello, auto: true }))).toMatchObject({ auto: true });
    expect(parseClientMessage(JSON.stringify({ ...hello, auto: 'yes' }))).not.toHaveProperty('auto');
  });

  it('are left out of the counts on a real server', async () => {
    const server = await startGameServer({
      port: 0,
      host: '127.0.0.1',
      production: false,
      clientDist: '',
      log: new MemoryLog(),
      emptyRoomMs: 60_000,
      maxPrivateRooms: 10,
      sessionSecret: 'test-secret',
      allowedOrigins: ['https://example.com', 'https://staging.example.com'],
      trustProxy: false,
      autoTick: false,
      metrics: { put: async () => {} },
    });
    const sockets: WebSocket[] = [];
    try {
      const join = async (origin: string, extra: object = {}) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { origin } });
        sockets.push(ws);
        await new Promise((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
        const welcomed = new Promise((resolve) => ws.on('message', (d) => JSON.parse(d.toString()).t === 'welcome' && resolve(null)));
        ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, session: null, name: 'Tester', room: { kind: 'create-private' }, device: 'desktop', ...extra }));
        await welcomed;
      };
      await join('https://example.com', { deviceId: DEV_A });
      await join('https://staging.example.com', { deviceId: DEV_B });
      await join('https://example.com', { deviceId: 'c'.repeat(32), auto: true });
      expect(server.manager.rooms.size).toBe(3);
      expect(server.manager.census()).toHaveLength(1);
    } finally {
      for (const ws of sockets) ws.close();
      await server.close();
    }
  });
});
