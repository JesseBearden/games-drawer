import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Append-only JSONL logs, one file per stream per UTC day:
 *   logs/events-YYYY-MM-DD.jsonl  gameplay + room events (see scripts/stats.ts)
 *   logs/chat-YYYY-MM-DD.jsonl    one line per chat message (delivered, blocked, reported) for
 *                                 the counts; no words or names, except a reported message's
 *                                 (what was said lives only with the table, and goes with it)
 * Lines carry a stable event id and server timestamp. Later these can ship to CloudWatch
 * unchanged (the agent tails files). Files are deleted after LOG_KEEP_DAYS (pruneLogs).
 */

/** Log files are kept this many days, then deleted (user, 2026-11-20; the privacy page says so). */
export const LOG_KEEP_DAYS = 30;

const LOG_FILE = /^[a-z]+-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Delete log files whose day is more than `keepDays` days before `now`, in each folder and the
 * folders directly inside it (on AWS, one per box on the shared disk, so a replaced box's logs go
 * too). Folders left empty go as well, except `keepDir` (the one this server is writing to).
 * Returns how many files were deleted. Never throws: a file another box deleted first is fine.
 */
export function pruneLogs(dirs: string[], opts: { now?: number; keepDays?: number; keepDir?: string } = {}): number {
  const cutoff = new Date((opts.now ?? Date.now()) - (opts.keepDays ?? LOG_KEEP_DAYS) * 86_400_000).toISOString().slice(0, 10);
  const keep = opts.keepDir ? path.resolve(opts.keepDir) : null;
  const folders = new Set<string>();
  for (const dir of dirs) {
    folders.add(path.resolve(dir));
    try {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) folders.add(path.resolve(dir, d.name));
    } catch {
      /* no such folder yet */
    }
  }
  let deleted = 0;
  for (const folder of folders) {
    let names: string[];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const day = LOG_FILE.exec(name)?.[1];
      if (!day || day >= cutoff) continue;
      try {
        fs.rmSync(path.join(folder, name), { force: true });
        deleted++;
      } catch {
        /* gone already, or busy: next time */
      }
    }
    if (folder !== keep && !dirs.some((d) => path.resolve(d) === folder)) {
      try {
        if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
      } catch {
        /* not empty after all, or gone */
      }
    }
  }
  return deleted;
}
export interface LogSink {
  event(type: string, fields: Record<string, unknown>): void;
  chat(fields: Record<string, unknown>): void;
  close(): void;
}

export class FileLog implements LogSink {
  private streams = new Map<string, fs.WriteStream>();
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private stream(kind: string) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${kind}-${day}`;
    let s = this.streams.get(key);
    if (!s) {
      for (const [k, old] of this.streams) {
        if (k.startsWith(`${kind}-`)) {
          old.end();
          this.streams.delete(k);
        }
      }
      s = fs.createWriteStream(path.join(this.dir, `${key}.jsonl`), { flags: 'a' });
      this.streams.set(key, s);
    }
    return s;
  }

  event(type: string, fields: Record<string, unknown>) {
    this.stream('events').write(JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), type, ...fields }) + '\n');
  }

  chat(fields: Record<string, unknown>) {
    this.stream('chat').write(JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...fields }) + '\n');
  }

  close() {
    for (const s of this.streams.values()) s.end();
    this.streams.clear();
  }
}

/** In-memory sink for tests. */
export class MemoryLog implements LogSink {
  events: { type: string; [k: string]: unknown }[] = [];
  chats: Record<string, unknown>[] = [];
  event(type: string, fields: Record<string, unknown>) {
    this.events.push({ type, ...fields });
  }
  chat(fields: Record<string, unknown>) {
    this.chats.push(fields);
  }
  close() {}
}
