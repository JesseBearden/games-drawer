import fs from 'node:fs';
import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';

/**
 * Chat screening. The obscenity library normalises case, leetspeak, repeated letters and
 * spacing tricks before matching its English profanity/slur dataset. Operators can add
 * extra words to blocklist.txt (one per line, # comments); those are matched after the
 * same kind of normalisation.
 *
 * Blocked messages are "shadowed": the sender sees their message as normal, nobody else
 * does, and it never enters room history.
 */
export const MAX_CHAT_LENGTH = 200;
export const RULE_VERSION = 'obscenity-en+blocklist-v1';

export type ScreenResult = { ok: true } | { ok: false; reason: 'filtered' | 'blocklist' | 'too-long' | 'empty' };

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '|': 'l' };

export function normalizeForFilter(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c)
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1');
}

/**
 * Join runs of single characters ("f u c k", "s.h.i.t") into one word while leaving normal
 * words apart, so spaced-out spellings are caught without false hits across real words.
 */
export function joinSpacedLetters(text: string): string {
  const tokens = text.split(/[\s._\-*~+]+/).filter(Boolean);
  const out: string[] = [];
  let run = '';
  for (const tok of tokens) {
    if ([...tok].length === 1) {
      run += tok;
      continue;
    }
    if (run) out.push(run);
    run = '';
    out.push(tok);
  }
  if (run) out.push(run);
  return out.join(' ');
}

export class ChatModerator {
  private matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  private extra: string[] = [];

  constructor(blocklistPath?: string) {
    if (blocklistPath && fs.existsSync(blocklistPath)) {
      this.extra = fs
        .readFileSync(blocklistPath, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map(normalizeForFilter)
        .filter(Boolean);
    }
  }

  /** Throws only on an internal error; callers treat that as "rejected, please retry". */
  screen(text: string): ScreenResult {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    if ([...trimmed].length > MAX_CHAT_LENGTH) return { ok: false, reason: 'too-long' };
    if (this.matcher.hasMatch(trimmed) || this.matcher.hasMatch(joinSpacedLetters(trimmed))) {
      return { ok: false, reason: 'filtered' };
    }
    if (this.extra.length) {
      const norm = normalizeForFilter(trimmed);
      if (this.extra.some((w) => norm.includes(w))) return { ok: false, reason: 'blocklist' };
    }
    return { ok: true };
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
