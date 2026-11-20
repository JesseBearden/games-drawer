import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { GAME_IDS, GAME_NAMES, type GameId } from '@tank/shared';

/**
 * The numbers on the admin page, added up from the JSONL logs (see eventlog.ts). Each game
 * logs one `game_session` line when it ends, so a game still going isn't counted until then.
 */
export interface GameStats {
  game: GameId;
  name: string;
  /** Games played (each start-to-finish, in any room). */
  sessions: number;
  /** Times someone picked it in a private room (counted since before session summaries). */
  picks: number;
  /** Hours with at least one person playing. */
  playHours: number;
  /** People × hours. */
  personHours: number;
  /** Share of play time with two or more people at once. */
  groupShare: number;
  /** Games that ever had two or more people at once. */
  groupSessions: number;
  avgPeak: number;
  maxPeak: number;
  players: number;
  avgMinutes: number;
  chats: number;
  chatsPerPersonHour: number;
}

export interface DayStats {
  day: string;
  players: number;
  rooms: number;
  sessions: number;
  personHours: number;
  chats: number;
}

export interface AdminStats {
  from: string;
  to: string;
  days: number;
  players: number;
  privateRooms: number;
  publicJoins: number;
  sessions: number;
  personHours: number;
  chat: { delivered: number; blocked: number; reported: number; perPersonHour: number; sessionsWithChat: number };
  /**
   * Voice links as each person saw them (a link between two people is counted from both ends):
   * straight to the other person, through our relay, or never connected. And how many people
   * ever needed the relay, or couldn't connect at all.
   */
  voice: { links: number; relayed: number; failed: number; people: number; peopleRelayed: number; peopleFailed: number };
  games: GameStats[];
  daily: DayStats[];
}

type Row = Record<string, unknown> & { type?: string; at?: string };

const HOUR = 3_600_000;
const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const dayOf = (at: unknown) => (typeof at === 'string' ? at.slice(0, 10) : '');

/** Days from `to` back, oldest first: ['2026-11-11', …, '2026-11-17']. */
export function dayRange(to: string, days: number): string[] {
  const end = Date.parse(`${to}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** Only the lines the admin page uses, to keep reading cheap. */
const WANTED = ['"game_session"', '"game_start"', '"join"', '"room_created"', '"voice_link"'];

async function readJsonl(file: string, keep: (line: string) => boolean, into: Row[]) {
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line || !keep(line)) continue;
    try {
      into.push(JSON.parse(line));
    } catch {
      /* a torn line from a crash: skip it */
    }
  }
}

/** Read the logs for these days from every folder (both copies of the server write their own). */
export async function readLogs(dirs: string[], days: string[]): Promise<{ events: Row[]; chats: Row[] }> {
  const events: Row[] = [];
  const chats: Row[] = [];
  const wanted = new Set(days);
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      const m = /^(events|chat)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m || !wanted.has(m[2])) continue;
      if (m[1] === 'events') await readJsonl(path.join(dir, f), (l) => WANTED.some((w) => l.includes(w)), events);
      else await readJsonl(path.join(dir, f), () => true, chats);
    }
  }
  return { events, chats };
}

export function summarize(events: Row[], chats: Row[], days: string[]): AdminStats {
  const inRange = new Set(days);
  const ev = events.filter((e) => inRange.has(dayOf(e.at)));
  const ch = chats.filter((c) => inRange.has(dayOf(c.at)));
  const sessions = ev.filter((e) => e.type === 'game_session' && GAME_IDS.includes(e.game as GameId));
  const joins = ev.filter((e) => e.type === 'join');

  const games: GameStats[] = GAME_IDS.map((game) => {
    const mine = sessions.filter((s) => s.game === game);
    const active = mine.reduce((t, s) => t + num(s.activeMs), 0);
    const group = mine.reduce((t, s) => t + num(s.groupMs), 0);
    const person = mine.reduce((t, s) => t + num(s.personMs), 0);
    const chatCount = mine.reduce((t, s) => t + num(s.chats), 0);
    const pids = new Set(mine.flatMap((s) => (Array.isArray(s.pids) ? (s.pids as unknown[]).filter((p): p is string => typeof p === 'string') : [])));
    const played = mine.filter((s) => num(s.activeMs) > 0);
    return {
      game,
      name: GAME_NAMES[game],
      sessions: played.length,
      picks: ev.filter((e) => e.type === 'game_start' && e.game === game).length,
      playHours: round(active / HOUR),
      personHours: round(person / HOUR),
      groupShare: active ? round(group / active, 2) : 0,
      groupSessions: played.filter((s) => num(s.peak) >= 2).length,
      avgPeak: played.length ? round(played.reduce((t, s) => t + num(s.peak), 0) / played.length) : 0,
      maxPeak: played.reduce((m, s) => Math.max(m, num(s.peak)), 0),
      players: pids.size,
      avgMinutes: played.length ? round(active / played.length / 60_000) : 0,
      chats: chatCount,
      chatsPerPersonHour: person ? round(chatCount / (person / HOUR)) : 0,
    };
  }).sort((a, b) => b.personHours - a.personHours || b.sessions - a.sessions || b.picks - a.picks);

  const links = ev.filter((e) => e.type === 'voice_link');
  const peopleWith = (route?: string) => new Set(links.filter((l) => !route || l.route === route).map((l) => l.pid)).size;
  const voice = {
    links: links.length,
    relayed: links.filter((l) => l.route === 'relayed').length,
    failed: links.filter((l) => l.route === 'failed').length,
    people: peopleWith(),
    peopleRelayed: peopleWith('relayed'),
    peopleFailed: peopleWith('failed'),
  };

  const personMs = sessions.reduce((t, s) => t + num(s.personMs), 0);
  const delivered = ch.filter((c) => c.outcome === 'delivered').length;
  const daily: DayStats[] = days.map((day) => {
    const dayEv = ev.filter((e) => dayOf(e.at) === day);
    const daySessions = dayEv.filter((e) => e.type === 'game_session');
    return {
      day,
      players: new Set(dayEv.filter((e) => e.type === 'join').map((j) => j.pid)).size,
      rooms: dayEv.filter((e) => e.type === 'room_created' && e.roomKind === 'private').length,
      sessions: daySessions.filter((s) => num(s.activeMs) > 0).length,
      personHours: round(daySessions.reduce((t, s) => t + num(s.personMs), 0) / HOUR),
      chats: ch.filter((c) => dayOf(c.at) === day && c.outcome === 'delivered').length,
    };
  });

  return {
    from: days[0],
    to: days.at(-1)!,
    days: days.length,
    players: new Set(joins.map((j) => j.pid)).size,
    privateRooms: ev.filter((e) => e.type === 'room_created' && e.roomKind === 'private').length,
    publicJoins: joins.filter((j) => j.roomKind === 'public').length,
    sessions: sessions.filter((s) => num(s.activeMs) > 0).length,
    personHours: round(personMs / HOUR),
    chat: {
      delivered,
      blocked: ch.filter((c) => c.outcome === 'blocked').length,
      reported: ch.filter((c) => c.outcome === 'reported').length,
      perPersonHour: personMs ? round(delivered / (personMs / HOUR)) : 0,
      sessionsWithChat: sessions.filter((s) => num(s.chats) > 0).length,
    },
    voice,
    games,
    daily,
  };
}

/** Read and add up, remembering the answer for a minute (the logs are read on the game server). */
export class AdminStatsCache {
  private cached = new Map<number, { at: number; stats: AdminStats }>();
  constructor(
    private dirs: string[],
    private now: () => number = Date.now,
  ) {}

  async get(days: number): Promise<AdminStats> {
    const now = this.now();
    const hit = this.cached.get(days);
    if (hit && now - hit.at < 60_000) return hit.stats;
    const range = dayRange(new Date(now).toISOString().slice(0, 10), days);
    const { events, chats } = await readLogs(this.dirs, range);
    const stats = summarize(events, chats, range);
    this.cached.set(days, { at: now, stats });
    return stats;
  }
}
