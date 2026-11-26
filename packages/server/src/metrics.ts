import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { GAME_IDS, type GameId } from '@tank/shared';
import { awsCredentials, signV4, type AwsCredentials } from './aws';

/**
 * The site's counts for Amazon CloudWatch, taken once a minute: how many people are at a table
 * (overall and in each game), in voice, and going through our voice relay, and how many different
 * devices have been at a table today. Only the numbers leave the box: no names, addresses or
 * device numbers (the privacy page says so).
 *
 * A "person" is a device (the browser's random device number, which the server only ever holds
 * scrambled), so two tabs on one phone are one person and a family on one Wi-Fi is several.
 * Automated tests and the staging site are left out (Conn.test), and only the live site's boxes
 * send anything (startMinuteMetrics' `live`).
 *
 * Each box sends one value per minute, stamped with the start of that minute, and no box name:
 * CloudWatch's Sum over a minute is then the whole site, even while an old box finishes its games
 * after a deploy (the dashboard in infra/lib/stack.ts divides longer periods back down).
 */

/** Every metric goes in this CloudWatch namespace (the box's role may only write to it). */
export const METRICS_NAMESPACE = 'GamesDrawer';

/** A table between games (choosing one): its own value under the Game dimension. */
export const LOBBY = 'lobby';

/** One connected person at one table, as the counts see them. */
export interface CensusEntry {
  /** Their device's scrambled number (or their seat's, without one): the same person at two tables is one. */
  key: string;
  /** The game their table is playing, or LOBBY. */
  game: GameId | typeof LOBBY;
  inVoice: boolean;
  /** At least one of their voice links goes through our relay. */
  relayed: boolean;
}

export interface MetricDatum {
  name: string;
  value: number;
  dims?: Record<string, string>;
  /** Its own time, instead of the minute's (DevicesPerDay). */
  at?: Date;
}

/**
 * The minute's numbers from everyone at a table on this box, and today's devices so far. Zeros
 * are left out (the user's choice, 2026-11-26): CloudWatch charges by the hours a metric gets
 * data, and the dashboard reads a missing minute as nobody.
 */
export function minuteMetrics(people: readonly CensusEntry[], devicesToday: number): MetricDatum[] {
  const distinct = (pick: (e: CensusEntry) => boolean) => new Set(people.filter(pick).map((e) => e.key)).size;
  const all: MetricDatum[] = [
    { name: 'People', value: distinct(() => true) },
    ...[...GAME_IDS, LOBBY].map((game) => ({ name: 'People', value: distinct((e) => e.game === game), dims: { Game: game } })),
    { name: 'InVoice', value: distinct((e) => e.inVoice) },
    { name: 'OnRelay', value: distinct((e) => e.inVoice && e.relayed) },
    { name: 'DevicesToday', value: devicesToday },
  ];
  return all.filter((d) => d.value > 0);
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The different devices that have been at a table since midnight (UTC), in memory only. A new box
 * starts from the day's join lines in the logs (devicesInLogs), so a deploy doesn't start the
 * day's count again. Those lines already hold the same scrambled numbers; nothing new is kept.
 */
export class DevicesToday {
  private day = '';
  private keys = new Set<string>();
  /** The day that just ended here, with its count, until it's taken (DevicesPerDay). */
  private finished: { day: string; count: number } | null = null;

  constructor(private now: () => number = Date.now) {}

  private roll() {
    const today = utcDay(this.now());
    if (today !== this.day) {
      if (this.day && this.keys.size) this.finished = { day: this.day, count: this.keys.size };
      this.day = today;
      this.keys.clear();
    }
  }

  /** The day that ended since last asked, and how many devices it had: once, then null. */
  takeFinishedDay() {
    this.roll();
    const f = this.finished;
    this.finished = null;
    return f;
  }

  add(key: string) {
    this.roll();
    this.keys.add(key);
  }

  /** Keys from the logs, for `day` only (a seed that finishes after midnight is dropped). */
  addFromDay(day: string, keys: Iterable<string>) {
    this.roll();
    if (day !== this.day) return;
    for (const k of keys) this.keys.add(k);
  }

  count() {
    this.roll();
    return this.keys.size;
  }
}

/** The count's key for someone who joined: their device's scrambled number, or their seat's. */
export const personKey = (did: string | null | undefined, pid: string) => did ?? `p:${pid}`;

/** Stop reading a day's log after this many lines (a busy day's file, read while games run). */
const SEED_LINES_MAX = 500_000;

/**
 * The devices in a day's join lines, from each log folder and the folders directly inside it (on
 * AWS, one per box on the shared disk). Lines marked `test` (automated tests, staging) are skipped.
 */
export async function devicesInLogs(dirs: readonly string[], day: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const folders = new Set<string>();
  for (const dir of dirs) {
    folders.add(path.resolve(dir));
    try {
      for (const d of await fs.promises.readdir(dir, { withFileTypes: true })) if (d.isDirectory()) folders.add(path.resolve(dir, d.name));
    } catch {
      /* no such folder yet */
    }
  }
  let lines = 0;
  for (const folder of folders) {
    const file = path.join(folder, `events-${day}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (++lines > SEED_LINES_MAX) break;
        if (!line.includes('"type":"join"')) continue;
        try {
          const row = JSON.parse(line) as { type?: unknown; pid?: unknown; did?: unknown; test?: unknown };
          if (row.type !== 'join' || row.test || typeof row.pid !== 'string') continue;
          keys.add(personKey(typeof row.did === 'string' ? row.did : null, row.pid));
        } catch {
          /* a half-written line */
        }
      }
    } catch {
      /* the file went away mid-read */
    } finally {
      rl.close();
    }
    if (lines > SEED_LINES_MAX) break;
  }
  return keys;
}

/**
 * Is this box part of the live site? Yes while the fleet map the deploy tool left (FLEET_MAP_FILE,
 * deploy/rollout.ts) sends it any share of new tables, a canary's included. No map file named:
 * yes (one server on its own). Named but not there yet: no (a new box, until the fleet says).
 */
export function takesNewTables(mapFile: string | undefined, slot: string | undefined): boolean {
  if (!mapFile) return true;
  try {
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as { newTables?: unknown };
    return Array.isArray(map.newTables) && map.newTables.some((t) => Array.isArray(t) && t[0] === slot && typeof t[1] === 'number' && t[1] > 0);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ CloudWatch

export interface MetricsPublisher {
  /** Send one minute's numbers, stamped `at` (the minute's start). Rejects if they didn't arrive. */
  put(data: readonly MetricDatum[], at: Date): Promise<void>;
}

/** The request body for CloudWatch's PutMetricData (its form-encoded "query" API). */
export function putMetricDataBody(namespace: string, data: readonly MetricDatum[], at: Date): string {
  const params: [string, string][] = [
    ['Action', 'PutMetricData'],
    ['Version', '2010-08-01'],
    ['Namespace', namespace],
  ];
  data.forEach((d, i) => {
    const m = `MetricData.member.${i + 1}`;
    params.push([`${m}.MetricName`, d.name], [`${m}.Value`, String(d.value)], [`${m}.Unit`, 'Count'], [`${m}.Timestamp`, (d.at ?? at).toISOString()]);
    Object.entries(d.dims ?? {}).forEach(([name, value], j) => {
      params.push([`${m}.Dimensions.member.${j + 1}.Name`, name], [`${m}.Dimensions.member.${j + 1}.Value`, value]);
    });
  });
  return params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** PutMetricData straight over HTTPS with the box's own role (no AWS library, like the photo check). */
export class CloudWatchPublisher implements MetricsPublisher {
  private credentials: () => Promise<AwsCredentials>;
  private fetchFn: typeof fetch;

  constructor(private o: { region: string; namespace?: string; credentials?: () => Promise<AwsCredentials>; fetch?: typeof fetch; now?: () => Date }) {
    this.fetchFn = o.fetch ?? fetch;
    this.credentials = o.credentials ?? awsCredentials(process.env, this.fetchFn);
  }

  async put(data: readonly MetricDatum[], at: Date): Promise<void> {
    const host = `monitoring.${this.o.region}.amazonaws.com`;
    const body = putMetricDataBody(this.o.namespace ?? METRICS_NAMESPACE, data, at);
    const headers = signV4({
      method: 'POST',
      host,
      path: '/',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      region: this.o.region,
      service: 'monitoring',
      credentials: await this.credentials(),
      now: this.o.now?.() ?? new Date(),
    });
    delete headers.host;
    const res = await this.fetchFn(`https://${host}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const text = await res.text();
      const code = /<Code>([^<]{1,80})<\/Code>/.exec(text)?.[1] ?? '';
      throw new Error(`CloudWatch ${res.status}${code ? ` ${code}` : ''}`);
    }
  }
}

// ------------------------------------------------------------------ the minute timer

/** After the minute starts, wait this long before counting (timers run a little late anyway). */
const MINUTE_OFFSET_MS = 2000;
/** A failure is written to the log at most this often (a missing permission fails every minute). */
const ERROR_LOG_EVERY_MS = 60 * 60_000;

/**
 * Count and send once a minute, each value stamped with its minute's start, never two for one
 * minute; nothing that's zero, and nothing at all from a box that isn't live (a staging box). Just
 * after midnight (UTC), the day that ended goes too, as DevicesPerDay stamped at that day's noon:
 * CloudWatch's day-long periods don't start at midnight, but each holds exactly one noon. A send
 * that fails is dropped, not retried: the next minute has its own numbers. Returns a function
 * that stops it.
 */
export function startMinuteMetrics(o: {
  publisher: MetricsPublisher;
  census: () => readonly CensusEntry[];
  devices: DevicesToday;
  log: { event(type: string, fields: Record<string, unknown>): void };
  now?: () => number;
  /** Is this box part of the live site? Asked each minute: one that isn't counts and sends nothing. */
  live?: () => boolean;
}): () => void {
  const now = o.now ?? Date.now;
  let lastMinute = -1;
  let lastErrorLog = -Infinity;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const minute = Math.floor(now() / 60_000) * 60_000;
    if (minute !== lastMinute) {
      lastMinute = minute;
      try {
        // The day that ended first: today's first count would start the new day.
        const ended = o.devices.takeFinishedDay();
        if (o.live?.() ?? true) {
          const people = o.census();
          for (const p of people) o.devices.add(p.key);
          const data = minuteMetrics(people, o.devices.count());
          if (ended) data.push({ name: 'DevicesPerDay', value: ended.count, at: new Date(`${ended.day}T12:00:00Z`) });
          if (data.length) {
            o.publisher.put(data, new Date(minute)).catch((err: unknown) => {
              if (now() - lastErrorLog < ERROR_LOG_EVERY_MS) return;
              lastErrorLog = now();
              o.log.event('metrics_failed', { error: String(err) });
              console.error('Sending the minute counts failed:', err);
            });
          }
        }
      } catch (err) {
        o.log.event('metrics_failed', { error: String(err) });
      }
    }
    timer = setTimeout(tick, minute + 60_000 + MINUTE_OFFSET_MS - now());
    timer.unref();
  };
  const first = Math.floor(now() / 60_000) * 60_000 + 60_000 + MINUTE_OFFSET_MS - now();
  timer = setTimeout(tick, first);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
