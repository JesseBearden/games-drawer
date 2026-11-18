import { cloneLayout, place, type Layout, type Move, type Placed, type TileId } from '@tank/shared';

/**
 * Where every domino sits on the table, in "units" (a tile is 2 x 1). The first tile is at the
 * centre. The east and west lines both bend down at the edge, like the sides of a table (mirror
 * images, never all rotating one way: that pinwheel looks like a swastika). The spinner's north
 * and south lines run straight: south between the two bent lines, north up the open top. Doubles sit
 * crosswise, like on a real table.
 */
export interface TileSpot {
  tile: TileId;
  x: number;
  y: number;
  horizontal: boolean;
  /** Pips on the left/top half, then the right/bottom half. */
  first: number;
  second: number;
  seat: number;
}

type Dir = [number, number];
const DIRS: Record<string, Dir> = { e: [1, 0], w: [-1, 0], n: [0, -1], s: [0, 1] };
/** A clockwise quarter turn in screen coordinates (east -> south -> west -> north). */
const clockwise = (d: Dir): Dir => [-d[1], d[0]];
const counterClockwise = (d: Dir): Dir => [d[1], -d[0]];

/** Lines running sideways bend down at the edge (so east and west mirror each other); lines
 *  running up or down go straight. */
const DOWN: Dir = [0, 1];

/** A tile laid from the edge point (cx, cy) heading `dir`; doubles sit crosswise. */
function spotFor(t: Placed, cx: number, cy: number, dir: Dir, len: number, dbl: boolean): TileSpot {
  const alongX = dir[0] !== 0;
  // The inner pip faces back toward where the line came from.
  const towardStart = alongX ? dir[0] > 0 : dir[1] > 0;
  return {
    tile: t.tile,
    x: cx + (dir[0] * len) / 2,
    y: cy + (dir[1] * len) / 2,
    horizontal: dbl ? !alongX : alongX,
    first: towardStart ? t.inner : t.outer,
    second: towardStart ? t.outer : t.inner,
    seat: t.seat,
  };
}

/** Two tiles cover some of the same table (touching edges is fine). */
export function overlaps(a: TileSpot, b: TileSpot) {
  const [aw, ah] = a.horizontal ? [2, 1] : [1, 2];
  const [bw, bh] = b.horizontal ? [2, 1] : [1, 2];
  const eps = 0.01;
  return Math.abs(a.x - b.x) < (aw + bw) / 2 - eps && Math.abs(a.y - b.y) < (ah + bh) / 2 - eps;
}

/** How far lines run before turning, from the shape of the space they have. */
export function limitsFor(width: number, height: number) {
  const aspect = width / Math.max(1, height);
  return {
    across: Math.max(4, Math.min(12, Math.round(6 * aspect))),
    upDown: Math.max(3, Math.min(10, Math.round(6 / aspect))),
  };
}

export function layoutSpots(l: Layout, limits = { across: 8, upDown: 4 }): TileSpot[] {
  const spots: TileSpot[] = [];
  const r = l.root;
  if (!r) return spots;
  const rootDouble = r.inner === r.outer;
  spots.push({ tile: r.tile, x: 0, y: 0, horizontal: !rootDouble, first: r.inner, second: r.outer, seat: r.seat });
  // Where each line starts (the edge of the tile it grows from) and which way it heads.
  const starts = new Map<string, { at: [number, number]; dir: Dir }>();
  if (rootDouble) {
    starts.set('e', { at: [0.5, 0], dir: DIRS.e });
    starts.set('w', { at: [-0.5, 0], dir: DIRS.w });
    starts.set('n', { at: [0, -1], dir: DIRS.n });
    starts.set('s', { at: [0, 1], dir: DIRS.s });
  } else {
    starts.set('e', { at: [1, 0], dir: DIRS.e });
    starts.set('w', { at: [-1, 0], dir: DIRS.w });
  }
  // Lines that grow from a later spinner start once that line is drawn.
  const pending = l.arms.filter((a) => a.from !== 'root');
  const drawn = new Set<string>();
  const drawArm = (id: string, tiles: Placed[]) => {
    const start = starts.get(id);
    if (!start) return;
    drawn.add(id);
    let [cx, cy] = start.at;
    let dir = start.dir;
    let run = 0;
    let turned = false;
    let lastWasDouble = false;
    // Sideways lines bend down at the edge; up-and-down lines run straight and only turn to dodge.
    const limit = dir[0] !== 0 ? limits.across : Infinity;
    // A spinner partway along this line sprouts side lines; turning right after it would run
    // into one of them, so the line goes one tile further first.
    const sp = l.spinner;
    const spinnerAt = sp && sp !== 'root' && sp.arm === id ? sp.index : -2;
    tiles.forEach((t, i) => {
      const dbl = t.inner === t.outer;
      const len = dbl ? 1 : 2;
      // Where this tile could go: straight on, or round a corner either way. A corner starts
      // beside the outer half of the last tile, clear of its edge (a crosswise double reaches a
      // whole unit out to the side, not half).
      const side = lastWasDouble ? 1 : 0.5;
      const turnTo = (nd: Dir) => ({ cx: cx - dir[0] * 0.5 + nd[0] * side, cy: cy - dir[1] * 0.5 + nd[1] * side, dir: nd, corner: true });
      const straight = { cx, cy, dir, corner: false };
      const options = run > 0 ? [straight, turnTo(clockwise(dir)), turnTo(counterClockwise(dir))] : [straight];
      // At the edge, the line turns its own way (unless it just passed a spinner).
      if (!turned && run > 0 && run + len > limit && i !== spinnerAt + 1) {
        const k = options.findIndex((o) => o.corner && o.dir[0] === DOWN[0] && o.dir[1] === DOWN[1]);
        if (k > 0) options.unshift(options.splice(k, 1)[0]);
      }
      // Take the first that lands clear of every tile already on the table (if it's boxed in,
      // whichever touches the fewest).
      let pick = options[0];
      let spot = spotFor(t, pick.cx, pick.cy, pick.dir, len, dbl);
      let fewest = Infinity;
      for (const o of options) {
        const candidate = spotFor(t, o.cx, o.cy, o.dir, len, dbl);
        const hits = spots.filter((s) => overlaps(s, candidate)).length;
        if (hits < fewest) {
          fewest = hits;
          pick = o;
          spot = candidate;
        }
        if (hits === 0) break;
      }
      if (pick.corner) {
        turned = true;
        run = 0;
      }
      ({ cx, cy, dir } = pick);
      lastWasDouble = dbl;
      spots.push(spot);
      // A later spinner: its side lines start from its long sides.
      for (const branch of pending) {
        if (branch.from === 'root' || branch.from.arm !== id || branch.from.index !== i) continue;
        const out = branch.id.endsWith('+') ? clockwise(dir) : counterClockwise(dir);
        starts.set(branch.id, { at: [spot.x + out[0], spot.y + out[1]], dir: out });
      }
      cx += dir[0] * len;
      cy += dir[1] * len;
      run += len;
    });
  };
  for (const a of l.arms) if (a.from === 'root') drawArm(a.id, a.tiles);
  for (const a of pending) if (!drawn.has(a.id)) drawArm(a.id, a.tiles);
  return spots;
}

/** Where a move would put its tile (for the glowing "play here" spots). */
export function ghostSpot(l: Layout, move: Move, seat: number, limits?: { across: number; upDown: number }): TileSpot | null {
  const copy = cloneLayout(l);
  if (!place(copy, move.tile, move.arm, seat)) return null;
  const before = layoutSpots(l, limits).length;
  const after = layoutSpots(copy, limits);
  if (!l.root) return after[0] ?? null;
  // The new tile is the last one drawn on its line: find it by tile id.
  return after.find((s) => s.tile === move.tile) ?? after[before] ?? null;
}

/** Bounds of a set of spots, in units. */
export function bounds(spots: TileSpot[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of spots) {
    const hw = s.horizontal ? 1 : 0.5;
    const hh = s.horizontal ? 0.5 : 1;
    minX = Math.min(minX, s.x - hw);
    maxX = Math.max(maxX, s.x + hw);
    minY = Math.min(minY, s.y - hh);
    maxY = Math.max(maxY, s.y + hh);
  }
  if (!spots.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

const PIPS: Record<number, [number, number][]> = {
  0: [],
  1: [[50, 50]],
  2: [
    [27, 27],
    [73, 73],
  ],
  3: [
    [25, 25],
    [50, 50],
    [75, 75],
  ],
  4: [
    [27, 27],
    [73, 27],
    [27, 73],
    [73, 73],
  ],
  5: [
    [25, 25],
    [75, 25],
    [50, 50],
    [25, 75],
    [75, 75],
  ],
  6: [
    [27, 22],
    [73, 22],
    [27, 50],
    [73, 50],
    [27, 78],
    [73, 78],
  ],
};

/** A domino as SVG: two halves with pips. Horizontal is 2:1, vertical 1:2. */
export function tileSvg(first: number, second: number, horizontal: boolean): string {
  const w = horizontal ? 200 : 100;
  const h = horizontal ? 100 : 200;
  const half = (n: number, ox: number, oy: number) => PIPS[n].map(([x, y]) => `<circle cx="${ox + x}" cy="${oy + y}" r="9.5"/>`).join('');
  const divider = horizontal ? '<line x1="100" y1="12" x2="100" y2="88"/>' : '<line x1="12" y1="100" x2="88" y2="100"/>';
  return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><rect x="3" y="3" width="${w - 6}" height="${h - 6}" rx="14" class="dm-face"/>${divider}<g class="dm-pips">${half(first, 0, 0)}${horizontal ? half(second, 100, 0) : half(second, 0, 100)}</g></svg>`;
}
