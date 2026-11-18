import {
  gridFor,
  PIECE_COUNTS,
  puzzleImage,
  puzzleProgress,
  puzzleUntouched,
  tableBounds,
  type GameInput,
  type PieceSpot,
  type PuzzlePhase,
  type PuzzleServerMessage,
  type PuzzleState,
} from '@tank/shared';
import type { PuzzleStore } from '../puzzleStore';
import type { GameHost, Member, ServerGame } from './types';

/** Saves wait this long after a change, so a busy table writes a few times a minute at most. */
const SAVE_DELAY_MS = 4000;
/** How close (as a fraction of a piece's short side) two pieces must be to snap together. */
const SNAP = 0.22;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Slot positions along one axis: outside the frame's span (lo..hi), packed outwards from it to
 * the table's edge, and across the span itself (centred).
 */
function slotLines(lo: number, hi: number, size: number, min: number, max: number) {
  const outside: number[] = [];
  for (let v = lo - size; v >= min; v -= size) outside.push(v);
  for (let v = hi; v + size <= max; v += size) outside.push(v);
  const n = Math.max(1, Math.floor((hi - lo) / size));
  const start = (lo + hi - n * size) / 2;
  const across = Array.from({ length: n }, (_, i) => start + i * size);
  return { outside, across };
}

/**
 * A jigsaw everyone in the room builds together (no bots, no seats). Anyone picks the picture
 * and piece count; pieces you pick up are yours until you drop them (others see who has them);
 * pieces that fit snap into groups; a group dropped where it belongs locks into the frame. The
 * puzzle saves to disk as it changes, so it can be continued later by its id.
 */
export class JigsawGame implements ServerGame {
  readonly id = 'jigsaw' as const;
  readonly capacity = 4;
  phase: PuzzlePhase = 'setup';
  state: PuzzleState | null = null;
  /** group -> session holding it */
  private held = new Map<number, string>();
  /** session -> the group and piece they picked up */
  private holding = new Map<string, { g: number; piece: number }>();
  private saveAt: number | null = null;

  constructor(
    private host: GameHost,
    private store: PuzzleStore,
  ) {}

  // ------------------------------------------------------------------ people

  addPlayer(m: Member): boolean {
    this.sendInit(m);
    return true;
  }

  reconnect(m: Member): boolean {
    this.sendInit(m);
    return true;
  }

  disconnect(m: Member): string | null {
    this.letGo(m.session);
    return null;
  }

  removePlayer(m: Member) {
    this.letGo(m.session);
  }

  renamed() {}

  // ------------------------------------------------------------------ geometry

  private get pw() {
    return this.state!.width / this.state!.cols;
  }

  private get ph() {
    return this.state!.height / this.state!.rows;
  }

  private members(g: number) {
    const out: number[] = [];
    this.state!.pieces.forEach((p, i) => p.g === g && out.push(i));
    return out;
  }

  private moveGroup(g: number, dx: number, dy: number) {
    for (const p of this.state!.pieces) {
      if (p.g !== g) continue;
      p.x += dx;
      p.y += dy;
    }
  }

  /** Keep a dragged piece on the table. */
  private clamp(x: number, y: number) {
    const s = this.state!;
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    return { x: Math.min(b.maxX - this.pw, Math.max(b.minX, x)), y: Math.min(b.maxY - this.ph, Math.max(b.minY, y)) };
  }

  /**
   * Lay pieces out around the frame in a grid of slots (a little jitter each), starting right
   * next to the frame and going out to the table's edge, so they don't pile up. `which`
   * defaults to every piece.
   */
  private scatter(which?: number[]) {
    const s = this.state!;
    const { pw, ph } = this;
    const b = tableBounds(s.width, s.height, s.cols, s.rows);
    const cellW = pw * 1.3;
    const cellH = ph * 1.3;
    const pad = Math.min(pw, ph) * 0.6;
    const xs = slotLines(-pad, s.width + pad, cellW, b.minX, b.maxX);
    const ys = slotLines(-pad, s.height + pad, cellH, b.minY, b.maxY);
    // Beside the frame (any row), or above and below it.
    const slots: { x: number; y: number }[] = [];
    for (const x of xs.outside) for (const y of [...ys.outside, ...ys.across]) slots.push({ x, y });
    for (const x of xs.across) for (const y of ys.outside) slots.push({ x, y });
    for (let i = slots.length - 1; i > 0; i--) {
      const j = this.host.randomInt(i + 1);
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    const pieces = which ?? s.pieces.map((_, i) => i);
    pieces.forEach((idx, k) => {
      const slot = slots[k % Math.max(1, slots.length)] ?? { x: b.minX, y: b.minY };
      const jitter = (n: number) => (this.host.randomInt(1000) / 1000 - 0.5) * n;
      s.pieces[idx].x = slot.x + (cellW - pw) / 2 + jitter(pw * 0.2);
      s.pieces[idx].y = slot.y + (cellH - ph) / 2 + jitter(ph * 0.2);
    });
  }

  // ------------------------------------------------------------------ messages out

  private stateMessage(): PuzzleServerMessage {
    return {
      t: 'pz-state',
      phase: this.phase,
      state: this.state,
      held: [...this.held].map(([g, session]) => ({ g, by: this.host.member(session)?.alias ?? '' })),
    };
  }

  sendInit(m: Member, _reclaimed = false) {
    this.host.send(m, this.stateMessage());
  }

  private broadcastState() {
    this.host.broadcast(this.stateMessage());
  }

  private changed() {
    this.state!.updatedAt = this.host.now();
    this.saveAt ??= this.host.now() + SAVE_DELAY_MS;
  }

  private saveNow() {
    this.saveAt = null;
    const s = this.state;
    if (!s) return;
    // A puzzle nobody has placed anything in isn't kept (so trying one out leaves no clutter).
    if (puzzleUntouched(s)) this.store.remove(s.id);
    else this.store.save(s);
  }

  private letGo(session: string) {
    const h = this.holding.get(session);
    if (!h) return;
    this.holding.delete(session);
    this.held.delete(h.g);
    this.host.broadcast({ t: 'pz-held', g: h.g, by: null });
  }

  // ------------------------------------------------------------------ input

  handle(m: Member, input: GameInput) {
    switch (input.t) {
      case 'pz-new':
        return this.newPuzzle(m, input.image, input.pieces);
      case 'pz-resume':
        return this.resume(m, input.id);
      case 'pz-setup':
        return this.backToSetup(m);
      case 'pz-saves': {
        const saves = input.ids.flatMap((id) => this.store.summary(id) ?? []);
        const found = new Set(saves.map((s) => s.id));
        this.host.send(m, { t: 'pz-saves', saves, gone: input.ids.filter((id) => !found.has(id)) });
        return;
      }
      case 'pz-cursor':
        for (const o of this.host.members()) if (o.session !== m.session && o.conn) this.host.send(o, { t: 'pz-cursor', by: m.alias, x: input.x, y: input.y });
        return;
      case 'pz-grab':
        return this.grab(m, input.piece);
      case 'pz-drag':
        return this.drag(m, input.x, input.y, false);
      case 'pz-drop':
        return this.drag(m, input.x, input.y, true);
      case 'pz-tidy':
        return this.tidy(m);
    }
  }

  private newPuzzle(m: Member, imageId: string, count: number) {
    if (this.phase === 'playing') return;
    const image = puzzleImage(imageId);
    if (!image || !(PIECE_COUNTS as readonly number[]).includes(count)) return;
    if (this.state) this.saveNow();
    const { cols, rows } = gridFor(image.width, image.height, count);
    let id = '';
    for (let i = 0; i < 16; i++) id += ID_CHARS[this.host.randomInt(ID_CHARS.length)];
    const now = this.host.now();
    this.state = {
      id,
      image: image.id,
      imageFile: image.file,
      title: image.title,
      width: image.width,
      height: image.height,
      cols,
      rows,
      seed: this.host.randomInt(2 ** 31),
      pieces: Array.from({ length: cols * rows }, (_, i): PieceSpot => ({ x: 0, y: 0, g: i })),
      locked: [],
      createdAt: now,
      updatedAt: now,
      doneAt: null,
    };
    this.scatter();
    this.reset('playing');
    this.saveNow();
    this.host.systemChat(`${m.name} started a ${cols * rows}-piece puzzle: ${image.title}.`);
    this.host.log('jigsaw_new', { image: image.id, pieces: cols * rows, by: m.pid });
  }

  private resume(m: Member, id: string) {
    if (this.phase === 'playing' && this.state?.id === id) return;
    if (this.phase === 'playing') return;
    const s = this.store.load(id);
    if (!s) {
      this.host.send(m, { t: 'pz-saves', saves: [], gone: [id] });
      return;
    }
    if (this.state) this.saveNow();
    this.state = s;
    this.reset(s.doneAt !== null ? 'done' : 'playing');
    const pct = Math.round(puzzleProgress(s.pieces) * 100);
    this.host.systemChat(`${m.name} brought back a puzzle: ${s.title} (${pct}% done).`);
    this.host.log('jigsaw_resume', { id: s.id, by: m.pid });
  }

  private backToSetup(m: Member) {
    if (this.phase === 'setup') return;
    const kept = !!this.state && !puzzleUntouched(this.state);
    if (this.state) this.saveNow();
    this.state = null;
    this.reset('setup');
    this.host.systemChat(
      kept
        ? `${m.name} put the puzzle away (it's saved). Pick another, or continue one.`
        : `${m.name} put the puzzle away (nothing was placed, so it wasn't kept).`,
    );
  }

  private reset(phase: PuzzlePhase) {
    this.phase = phase;
    this.held.clear();
    this.holding.clear();
    this.broadcastState();
  }

  private grab(m: Member, piece: number) {
    const s = this.state;
    if (this.phase !== 'playing' || !s || piece >= s.pieces.length) return;
    const g = s.pieces[piece].g;
    const holder = this.held.get(g);
    if (s.locked.includes(g) || (holder && holder !== m.session)) {
      // Tell them who has it (or that it's locked in), so their screen puts it back.
      this.host.send(m, { t: 'pz-held', g, by: holder ? (this.host.member(holder)?.alias ?? '') : '' });
      return;
    }
    this.letGo(m.session);
    this.held.set(g, m.session);
    this.holding.set(m.session, { g, piece });
    this.host.broadcast({ t: 'pz-held', g, by: m.alias });
  }

  private drag(m: Member, x: number, y: number, drop: boolean) {
    const h = this.holding.get(m.session);
    const s = this.state;
    if (!h || !s || this.phase !== 'playing') return;
    const to = this.clamp(x, y);
    const anchor = s.pieces[h.piece];
    this.moveGroup(h.g, to.x - anchor.x, to.y - anchor.y);
    if (!drop) {
      for (const o of this.host.members()) if (o.session !== m.session && o.conn) this.host.send(o, { t: 'pz-drag', g: h.g, piece: h.piece, x: to.x, y: to.y, by: m.alias });
      return;
    }
    const { g, touched, snapped } = this.snap(h.g);
    this.holding.delete(m.session);
    this.held.delete(h.g);
    this.held.delete(g);
    this.changed();
    this.host.broadcast({
      t: 'pz-moved',
      pieces: touched.map((i) => [i, s.pieces[i].x, s.pieces[i].y, s.pieces[i].g]),
      locked: [...s.locked],
      by: m.alias,
      snapped,
    });
    this.host.broadcast({ t: 'pz-held', g: h.g, by: null });
    if (snapped) this.host.log('jigsaw_snap', { by: m.pid });
    this.checkDone();
  }

  /**
   * Join a dropped group to any neighbours lined up with it, then lock it into the frame if
   * it's where it belongs. The dropped group moves onto what it joins. Returns the group id
   * it ended up in and every piece that moved or changed group.
   */
  private snap(g0: number): { g: number; touched: number[]; snapped: boolean } {
    const s = this.state!;
    const { pw, ph } = this;
    const tol = SNAP * Math.min(pw, ph);
    let g = g0;
    const touched = new Set(this.members(g));
    let snapped = false;
    for (let joined = true; joined; ) {
      joined = false;
      for (const i of this.members(g)) {
        const r = Math.floor(i / s.cols);
        const c = i % s.cols;
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= s.rows || nc >= s.cols) continue;
          const n = nr * s.cols + nc;
          const other = s.pieces[n].g;
          if (other === g || (this.held.has(other) && other !== g0)) continue;
          const ex = s.pieces[i].x + dc * pw;
          const ey = s.pieces[i].y + dr * ph;
          if (Math.abs(s.pieces[n].x - ex) > tol || Math.abs(s.pieces[n].y - ey) > tol) continue;
          // Line the dropped group up exactly with its new neighbour, then merge.
          this.moveGroup(g, s.pieces[n].x - ex, s.pieces[n].y - ey);
          const wasLocked = s.locked.includes(g) || s.locked.includes(other);
          for (const p of s.pieces) if (p.g === g) p.g = other;
          s.locked = s.locked.filter((x) => x !== g);
          if (wasLocked && !s.locked.includes(other)) s.locked.push(other);
          g = other;
          for (const k of this.members(g)) touched.add(k);
          snapped = joined = true;
          break;
        }
        if (joined) break;
      }
    }
    // Into the frame: the group's pieces are within reach of where they belong.
    if (!s.locked.includes(g)) {
      const i = this.members(g)[0];
      const dx = (i % s.cols) * pw - s.pieces[i].x;
      const dy = Math.floor(i / s.cols) * ph - s.pieces[i].y;
      if (Math.abs(dx) <= tol && Math.abs(dy) <= tol) {
        this.moveGroup(g, dx, dy);
        s.locked.push(g);
        snapped = true;
      }
    }
    return { g, touched: [...touched], snapped };
  }

  private tidy(m: Member) {
    const s = this.state;
    if (!s || this.phase !== 'playing') return;
    const sizes = new Map<number, number>();
    for (const p of s.pieces) sizes.set(p.g, (sizes.get(p.g) ?? 0) + 1);
    // Loose single pieces nobody is holding go back around the edges.
    const loose = s.pieces.flatMap((p, i) => (sizes.get(p.g) === 1 && !this.held.has(p.g) && !s.locked.includes(p.g) ? [i] : []));
    if (!loose.length) return;
    this.scatter(loose);
    this.changed();
    this.host.broadcast({ t: 'pz-moved', pieces: loose.map((i) => [i, s.pieces[i].x, s.pieces[i].y, s.pieces[i].g]), locked: [...s.locked], by: m.alias, snapped: false });
    this.host.systemChat(`${m.name} tidied up the loose pieces.`);
  }

  private checkDone() {
    const s = this.state!;
    if (s.doneAt !== null || new Set(s.pieces.map((p) => p.g)).size > 1) return;
    s.doneAt = this.host.now();
    this.phase = 'done';
    this.saveNow();
    const minutes = Math.max(1, Math.round((s.doneAt - s.createdAt) / 60_000));
    this.host.systemChat(`Puzzle finished! ${s.pieces.length} pieces in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    this.host.log('jigsaw_done', { id: s.id, pieces: s.pieces.length, minutes });
    this.broadcastState();
  }

  // ------------------------------------------------------------------ time

  step() {
    if (this.saveAt !== null && this.host.now() >= this.saveAt) this.saveNow();
  }

  dispose() {
    if (this.state) this.saveNow();
  }

  stats() {
    return { phase: this.phase, pieces: this.state?.pieces.length ?? 0, progress: this.state ? Math.round(puzzleProgress(this.state.pieces) * 100) : 0 };
  }
}
