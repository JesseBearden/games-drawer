import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isPuzzleId, puzzleProgress, puzzleUntouched, type PuzzleState, type PuzzleSummary } from '@tank/shared';

/** Saves nobody has played this long are deleted (user, 2026-11-20; the privacy page says so). */
export const PUZZLE_KEEP_DAYS = 30;
/** Summaries remembered, so the "Continue a puzzle" list needn't read whole puzzles each time. */
const SUMMARIES_KEPT = 2000;

/**
 * Jigsaw saves: one small JSON file per puzzle (about 20-60 KB even at 1,000 pieces), named by
 * its unguessable id. With no folder (tests) they live in memory only.
 *
 * On AWS the folder is on the shared disk (EFS), over the network: a slow moment there, or a
 * stall, mustn't stop the games. So nothing here waits on the disk on the game thread: save and
 * remove return at once (the newest version of a puzzle wins, written one write at a time per
 * puzzle), and reads see what's still waiting to be written.
 */
export class PuzzleStore {
  private memory = new Map<string, PuzzleState>();
  /** What each puzzle's file should become: its JSON, or null to delete it. */
  private waiting = new Map<string, string | null>();
  private writing = new Map<string, Promise<void>>();
  /** Summaries by id, good while the file's `stamp` (time and size) stays the same. */
  private summaries = new Map<string, { stamp: string; summary: PuzzleSummary }>();

  constructor(private dir: string | null) {
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  private file(id: string) {
    return path.join(this.dir!, `${id}.json`);
  }

  save(state: PuzzleState) {
    if (!isPuzzleId(state.id)) return;
    if (!this.dir) this.memory.set(state.id, structuredClone(state));
    else this.queue(state.id, JSON.stringify(state)); // JSON now: the game carries on changing it
  }

  /** Forget a puzzle (fine if it was never saved). */
  remove(id: string) {
    if (!isPuzzleId(id)) return;
    if (!this.dir) this.memory.delete(id);
    else this.queue(id, null);
  }

  private queue(id: string, data: string | null) {
    this.waiting.set(id, data);
    this.summaries.delete(id);
    if (!this.writing.has(id)) this.writing.set(id, this.writeNewest(id));
  }

  private async writeNewest(id: string) {
    for (;;) {
      const data = this.waiting.get(id)!;
      await this.write(id, data);
      if (this.waiting.get(id) !== data) continue; // changed meanwhile: write that too
      // (No await from here to the return, so nothing can queue in between.)
      this.waiting.delete(id);
      this.writing.delete(id);
      this.summaries.delete(id);
      return;
    }
  }

  private async write(id: string, data: string | null) {
    const file = this.file(id);
    if (data === null) {
      await fs.promises.unlink(file).catch(() => {}); // (never saved)
      return;
    }
    // Write then rename, so a crash mid-write never leaves half a file. If the disk can't be
    // written, the puzzle plays on and the next save tries again.
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, file);
    } catch (err) {
      console.error(`Couldn't save puzzle ${id}:`, err);
      await fs.promises.unlink(tmp).catch(() => {});
    }
  }

  /** Resolves once everything saved or removed so far is on disk. */
  async flush(): Promise<void> {
    while (this.writing.size) await Promise.all(this.writing.values());
  }

  async load(id: string): Promise<PuzzleState | null> {
    if (!isPuzzleId(id)) return null;
    if (!this.dir) {
      const s = this.memory.get(id);
      return s ? structuredClone(s) : null;
    }
    try {
      const waiting = this.waiting.get(id);
      if (waiting === null) return null;
      const s = JSON.parse(waiting ?? (await fs.promises.readFile(this.file(id), 'utf8'))) as PuzzleState;
      return valid(s) ? s : null;
    } catch {
      return null;
    }
  }

  async summary(id: string): Promise<PuzzleSummary | null> {
    if (!isPuzzleId(id)) return null;
    let stamp: string | null = null;
    if (this.dir && !this.waiting.has(id)) {
      try {
        const st = await fs.promises.stat(this.file(id));
        stamp = `${st.mtimeMs}:${st.size}`;
      } catch {
        this.summaries.delete(id);
        return null;
      }
      const known = this.summaries.get(id);
      if (known?.stamp === stamp) return known.summary;
    }
    const s = await this.load(id);
    if (!s) return null;
    const summary: PuzzleSummary = {
      id: s.id,
      image: s.image,
      imageFile: s.imageFile,
      title: s.title,
      pieces: s.pieces.length,
      progress: puzzleProgress(s.pieces, s.locked),
      updatedAt: s.updatedAt,
      done: s.doneAt !== null,
    };
    if (stamp !== null && !this.waiting.has(id)) {
      if (this.summaries.size >= SUMMARIES_KEPT) this.summaries.clear();
      this.summaries.set(id, { stamp, summary });
    }
    return summary;
  }

  /**
   * Delete saves nobody has touched in a long time. With `which` 'all' (at start-up) it also
   * reads each one and deletes any with nothing placed or finished (those are no longer saved;
   * older ones may be lying around); 'old' goes by the files' dates alone. Returns how many went.
   */
  async sweep(nowMs: number, keepDays = PUZZLE_KEEP_DAYS, which: 'all' | 'old' = 'all'): Promise<number> {
    const cutoff = nowMs - keepDays * 86_400_000;
    let removed = 0;
    if (!this.dir) {
      for (const [id, s] of this.memory) if (s.updatedAt < cutoff && this.memory.delete(id)) removed++;
      return removed;
    }
    for (const name of await fs.promises.readdir(this.dir)) {
      // (.tmp: half a save, left by a box that stopped mid-write.)
      const saved = name.endsWith('.json');
      if (!saved && !name.endsWith('.tmp')) continue;
      const id = name.split('.')[0];
      const full = path.join(this.dir, name);
      try {
        let gone = (await fs.promises.stat(full)).mtimeMs < cutoff;
        if (!gone && saved && which === 'all') {
          const s = await this.load(id);
          gone = !!s && (puzzleUntouched(s) || s.doneAt !== null);
        }
        if (!gone || this.waiting.has(id)) continue; // being saved right now: leave it
        await fs.promises.unlink(full);
        this.summaries.delete(id);
        if (saved) removed++;
      } catch {
        /* already gone */
      }
    }
    return removed;
  }
}

/** Saves are written by us, but check the shape before trusting a file. */
function valid(s: PuzzleState): boolean {
  if (!s || !isPuzzleId(s.id) || typeof s.image !== 'string' || typeof s.imageFile !== 'string') return false;
  if (!Number.isInteger(s.cols) || !Number.isInteger(s.rows) || s.cols < 2 || s.rows < 2 || s.cols * s.rows > 1200) return false;
  if (!Array.isArray(s.pieces) || s.pieces.length !== s.cols * s.rows) return false;
  if (!s.pieces.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isInteger(p.g))) return false;
  return Array.isArray(s.locked) && Number.isFinite(s.width) && Number.isFinite(s.height) && Number.isInteger(s.seed);
}
