import fs from 'node:fs';
import path from 'node:path';
import { isPuzzleId, puzzleProgress, puzzleUntouched, type PuzzleState, type PuzzleSummary } from '@tank/shared';

/** Saves untouched this long are deleted. */
export const PUZZLE_KEEP_DAYS = 90;

/**
 * Jigsaw saves: one small JSON file per puzzle (about 20-60 KB even at 1,000 pieces), named by
 * its unguessable id. With no folder (tests) they live in memory only.
 */
export class PuzzleStore {
  private memory = new Map<string, PuzzleState>();

  constructor(private dir: string | null) {
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  private file(id: string) {
    return path.join(this.dir!, `${id}.json`);
  }

  save(state: PuzzleState) {
    if (!isPuzzleId(state.id)) return;
    if (!this.dir) {
      this.memory.set(state.id, structuredClone(state));
      return;
    }
    // Write then rename, so a crash mid-write never leaves half a file. On AWS the folder is
    // on the shared disk (EFS): if it ever can't be written, the puzzle plays on and the next
    // save tries again.
    try {
      const tmp = `${this.file(state.id)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.file(state.id));
    } catch (err) {
      console.error(`Couldn't save puzzle ${state.id}:`, err);
    }
  }

  /** Forget a puzzle (fine if it was never saved). */
  remove(id: string) {
    if (!isPuzzleId(id)) return;
    if (!this.dir) {
      this.memory.delete(id);
      return;
    }
    try {
      fs.unlinkSync(this.file(id));
    } catch {
      /* never saved */
    }
  }

  load(id: string): PuzzleState | null {
    if (!isPuzzleId(id)) return null;
    if (!this.dir) {
      const s = this.memory.get(id);
      return s ? structuredClone(s) : null;
    }
    try {
      const s = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as PuzzleState;
      return valid(s) ? s : null;
    } catch {
      return null;
    }
  }

  summary(id: string): PuzzleSummary | null {
    const s = this.load(id);
    if (!s) return null;
    return {
      id: s.id,
      image: s.image,
      imageFile: s.imageFile,
      title: s.title,
      pieces: s.pieces.length,
      progress: puzzleProgress(s.pieces, s.locked),
      updatedAt: s.updatedAt,
      done: s.doneAt !== null,
    };
  }

  /**
   * Delete saves nobody has touched in a long time, and any with nothing placed (those are no
   * longer saved; older ones may be lying around). Returns how many went.
   */
  sweep(nowMs: number, keepDays = PUZZLE_KEEP_DAYS): number {
    const cutoff = nowMs - keepDays * 86_400_000;
    let removed = 0;
    if (!this.dir) {
      for (const [id, s] of this.memory) if (s.updatedAt < cutoff && this.memory.delete(id)) removed++;
      return removed;
    }
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(this.dir, f);
      try {
        const old = fs.statSync(full).mtimeMs < cutoff;
        const s = old ? null : this.load(f.slice(0, -5));
        if (old || (s && puzzleUntouched(s))) {
          fs.unlinkSync(full);
          removed++;
        }
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
