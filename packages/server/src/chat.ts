import fs from 'node:fs';
import { checkChat, MAX_CHAT_LENGTH, type ChatCheck, type ChatFilterMode } from '@tank/shared';

/**
 * Chat screening on the server: the same filter the browser runs (packages/shared/src/
 * chatFilter.ts), which has the final say, plus extra words from blocklist.txt (one per line,
 * # comments) that are blocked in every room. The browser doesn't know the file's words, so a
 * message caught only by them gets the "only you can see this" treatment instead.
 */
export { joinSpacedLetters, normalizeForFilter } from '@tank/shared';
export { MAX_CHAT_LENGTH };
export const RULE_VERSION = 'obscenity-en+slurs+allowlist-v3';

export type ScreenResult = ChatCheck;

export class ChatModerator {
  private extra: string[] = [];

  constructor(blocklistPath?: string) {
    if (blocklistPath && fs.existsSync(blocklistPath)) {
      this.extra = fs
        .readFileSync(blocklistPath, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    }
  }

  /** What happens to a message at a table with this filter setting. */
  screen(text: string, mode: ChatFilterMode = 'block'): ScreenResult {
    return checkChat(text, mode, this.extra);
  }
}

/** Sliding-window limiter: at most `max` messages per `windowMs`, and no instant repeats. */
export class RateLimiter {
  private times: number[] = [];
  private lastText = '';
  private lastAt = 0;
  constructor(
    private max = 5,
    private windowMs = 8000,
    private repeatMs = 15000,
  ) {}

  check(now: number, text: string): 'ok' | 'rapid' | 'repeat' {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    const norm = text.trim().toLowerCase();
    if (norm === this.lastText && now - this.lastAt < this.repeatMs) return 'repeat';
    if (this.times.length >= this.max) return 'rapid';
    this.times.push(now);
    this.lastText = norm;
    this.lastAt = now;
    return 'ok';
  }
}
