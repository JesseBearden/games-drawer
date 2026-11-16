import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Append-only JSONL logs, one file per stream per UTC day:
 *   logs/events-YYYY-MM-DD.jsonl  gameplay + room events (see scripts/stats.ts)
 *   logs/chat-YYYY-MM-DD.jsonl    every chat submission, delivered or blocked
 * Lines carry a stable event id and server timestamp. Later these can ship to CloudWatch
 * unchanged (the agent tails files).
 */
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
