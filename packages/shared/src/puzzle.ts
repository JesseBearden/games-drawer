/**
 * Jigsaw puzzles: the picture catalog, how a picture is cut into pieces, and what the shared
 * table looks like. Board coordinates are the picture's own pixels: the finished puzzle covers
 * (0, 0) to (width, height), and loose pieces lie around it on a bigger table.
 *
 * Everyone in the room works on one puzzle together (no bots). Pieces that fit together snap
 * into a group and move as one; a group dropped where it belongs in the frame locks in place.
 */
import { Rng } from './rng';

/** 6 and 20 are for little kids (big pieces that snap easily). */
export const PIECE_COUNTS = [6, 20, 50, 100, 250, 500, 1000] as const;
export type PieceCount = (typeof PIECE_COUNTS)[number];

export interface PuzzleImage {
  id: string;
  /** Served from the client's public folder. */
  file: string;
  /** A small preview for the picker. */
  thumb: string;
  title: string;
  width: number;
  height: number;
  credit: string;
}

const pic = (id: string, title: string, width: number, height: number, credit: string): PuzzleImage => ({
  id,
  file: `/puzzles/${id}.jpg`,
  thumb: `/puzzles/thumbs/${id}.webp`,
  title,
  width,
  height,
  credit,
});

/**
 * Pictures anyone can pick: ours, shared with us by the photographer, or public domain or CC0
 * only (sources in CREDITS.md). Each is
 * 2400 px wide (the user's own photos are smaller), so even 1000-piece pieces have detail. A
 * picture's id is saved with each puzzle, so don't change an id or remove a picture people may
 * be in the middle of (titles can change).
 */
export const PUZZLE_IMAGES: PuzzleImage[] = [
  pic('dog', 'Penny Pickles', 1600, 1067, 'Photo by Jesse Bearden'),
  pic('sailboat', 'Sailboat', 1073, 1430, 'Photo by Jesse Bearden'),
  pic('judy', 'Judy Jalapeño', 2016, 1512, 'Photo by Jesse Bearden'),
  pic('milli', 'Milli', 1024, 1536, 'Photo by James Montemagno'),
  pic('sucia', 'Sucia', 2400, 1800, 'Photo by Samantha DeLuna'),
  pic('fruit-market', 'Fruit market', 2400, 1840, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('spice-stall', 'Spice stall', 2400, 1600, 'Photo: Wilfredor (CC0)'),
  pic('tulips', 'Tulip garden', 2400, 1601, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('wildflowers', 'Mountain wildflowers', 2400, 1600, 'Photo: National Park Service'),
  pic('lupines', 'Lupine meadow', 2400, 1600, 'Photo: National Park Service'),
  pic('autumn', 'Autumn treetops', 2400, 1600, 'Photo: National Park Service'),
  pic('reef-fish', 'Reef fish', 2400, 1800, 'Photo: NOAA'),
  pic('balloons', 'Balloon festival', 2400, 1600, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('great-hall', 'Great Hall ceiling', 2400, 1507, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('library', 'Peabody Library', 2400, 1803, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('havana-cars', 'Havana cars', 2400, 1600, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('steam-train', 'Steam train', 2400, 1601, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('rowboats', 'Rowboats', 2400, 1915, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('vernazza', 'Vernazza', 2400, 1600, 'Photo: Evadb (public domain)'),
  pic('toy-shop', 'Toy shop', 2400, 1632, 'Photo: Andreas Praefcke (public domain)'),
  pic('pebbles', 'Lake pebbles', 2400, 1602, 'Photo: National Park Service'),
  pic('flamingos', 'Flamingos', 2400, 1829, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('harvesters', 'The Harvesters', 2400, 1769, 'Painting: Pieter Bruegel the Elder, 1565 (The Met)'),
  pic('wheat-field', 'Wheat Field with Cypresses', 2400, 1856, 'Painting: Vincent van Gogh, 1889 (The Met)'),
  pic('bedroom', 'The Bedroom', 2400, 1884, 'Painting: Vincent van Gogh, 1889 (Art Institute of Chicago)'),
  pic('monarchs', 'Monarch butterflies', 2400, 1600, 'Photo: Joanna Gilkeson, USFWS'),
  pic('ducklings', 'Ducklings', 2400, 1589, 'Photo: Courtney Celley, USFWS'),
  pic('fox-kits', 'Fox kits', 2400, 1600, 'Photo: National Park Service'),
  pic('baby-goats', 'Baby goats', 2400, 1573, 'Photo: Wilfredor (CC0)'),
  pic('hen-and-chicks', 'Hen and chicks', 2400, 1600, 'Photo: Pedalito (CC0)'),
  pic('puffins', 'Puffins', 2400, 1600, 'Photo: Rosie Walunas, USFWS'),
  pic('bison-calves', 'Bison and calves', 2400, 1600, 'Photo: Jacob W. Frank, National Park Service'),
  pic('lobster-buoys', 'Lobster buoys', 2400, 1599, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('beach-huts', 'Beach huts', 2400, 1600, 'Photo: Hassocks5489 (CC0)'),
  pic('carousel', 'Carousel horses', 2400, 1907, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('candy-stall', 'Candy stall', 2400, 1780, 'Photo: Steffen Mokosch (CC0)'),
  pic('covered-bridge', 'Covered bridge', 2400, 1600, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('painted-houses', 'Painted houses', 2400, 1596, 'Photo: DimiTalen (CC0)'),
  pic('red-barns', 'Red barns', 2400, 1800, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('snowy-cabins', 'Snowy barns', 2400, 1600, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('lighthouse', 'Lighthouse', 2400, 1602, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('rose-window', 'Rose window', 2400, 1600, 'Photo: Joselodos (CC0)'),
  pic('pumpkin-cabin', 'Pumpkin patch', 2400, 1800, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('azalea-garden', 'Azalea garden', 2400, 1602, 'Photo: Carol M. Highsmith, Library of Congress'),
  pic('great-wave', 'The Great Wave', 2400, 1614, 'Print: Katsushika Hokusai, about 1830–32 (The Met)'),
  pic('grande-jatte', 'La Grande Jatte', 2400, 1597, 'Painting: Georges Seurat, 1884–86 (Art Institute of Chicago)'),
  pic('monet-garden', 'Monet’s garden', 2400, 1796, 'Painting: Claude Monet, 1873 (National Gallery of Art)'),
  pic('teapot-fruit', 'Teapot and Fruit', 2400, 1719, 'Painting: Paul Gauguin, 1896 (The Met)'),
  pic('cezanne-apples', 'Apples and Primroses', 2400, 1883, 'Painting: Paul Cézanne, about 1890 (The Met)'),
  pic('peaceable-kingdom', 'Peaceable Kingdom', 2400, 1764, 'Painting: Edward Hicks, about 1830–32 (The Met)'),
  pic('nebulae', 'Heart and Soul nebulae', 2400, 1702, 'Image: NASA/JPL-Caltech/UCLA'),
  pic('bahamas', 'Bahamas from space', 2400, 1597, 'Photo: Scott Kelly, NASA'),
  pic('plankton', 'Plankton swirls', 2400, 1775, 'Image: NASA Goddard'),
];

/**
 * Pictures that live only on one computer: the git-ignored `local-puzzles/` folder (family
 * photos that must never be published). The dev server reads its `puzzles.json` at start-up and
 * the picker fetches it; production never does, and the folder is never committed or deployed.
 */
const localImages: PuzzleImage[] = [];
export const LOCAL_PUZZLE_PATH = '/puzzles/local';
export const LOCAL_PUZZLE_CREDIT = 'Only on this computer';

/** Check a local-puzzles/puzzles.json and turn it into pictures (anything odd is skipped). */
export function parseLocalPuzzles(raw: unknown): PuzzleImage[] {
  if (!Array.isArray(raw)) return [];
  const out: PuzzleImage[] = [];
  for (const r of raw.slice(0, 50)) {
    if (!r || typeof r !== 'object') continue;
    const { id, title, width, height } = r as Record<string, unknown>;
    if (typeof id !== 'string' || !/^local-[a-z0-9-]{1,34}$/.test(id)) continue;
    if (typeof title !== 'string' || !title.trim() || title.length > 40) continue;
    const size = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 10_000;
    if (!size(width) || !size(height)) continue;
    out.push({ id, file: `${LOCAL_PUZZLE_PATH}/${id}.jpg`, thumb: `${LOCAL_PUZZLE_PATH}/thumbs/${id}.webp`, title: title.trim(), width, height, credit: LOCAL_PUZZLE_CREDIT });
  }
  return out;
}

/** Add (or update, after a rename) this computer's own pictures; they come first in the picker. */
export function addLocalPuzzleImages(list: PuzzleImage[]) {
  for (const i of list) {
    if (PUZZLE_IMAGES.some((p) => p.id === i.id)) continue;
    const at = localImages.findIndex((p) => p.id === i.id);
    if (at >= 0) localImages[at] = i;
    else localImages.push(i);
  }
}

/** Every picture to choose from: this computer's own first (if any), then everyone's. */
export function allPuzzleImages(): PuzzleImage[] {
  return [...localImages, ...PUZZLE_IMAGES];
}

export function puzzleImage(id: string): PuzzleImage | undefined {
  return PUZZLE_IMAGES.find((i) => i.id === id) ?? localImages.find((i) => i.id === id);
}

/**
 * Columns and rows for about `target` pieces of a picture, keeping pieces close to square.
 * (A 3:2 photo at 100 pieces is 12 x 8 = 96.)
 */
export function gridFor(width: number, height: number, target: number): { cols: number; rows: number } {
  const aspect = width / height;
  let best = { cols: 1, rows: 1, score: Infinity };
  const r0 = Math.max(1, Math.round(Math.sqrt(target / aspect)));
  for (let rows = Math.max(2, r0 - 3); rows <= r0 + 3; rows++) {
    for (const cols of [Math.floor(target / rows), Math.ceil(target / rows)]) {
      if (cols < 2) continue;
      const pieceAspect = width / cols / (height / rows);
      // How far off the count is, plus how far from square the pieces are.
      const score = Math.abs(cols * rows - target) / target + Math.abs(Math.log(pieceAspect)) * 0.8;
      if (score < best.score) best = { cols, rows, score };
    }
  }
  return { cols: best.cols, rows: best.rows };
}

// ------------------------------------------------------------------ piece shapes

/**
 * One internal edge's tab, in edge-relative units: along the edge 0..1, out from it as a
 * fraction of the piece's short side. Every edge gets its own size, position, neck and lean,
 * so no two connections look the same.
 */
export interface TabShape {
  /** +1: the tab sticks out to the edge's left (as you walk it); -1: to the right. */
  flip: 1 | -1;
  /** Where along the edge the tab sits. */
  centre: number;
  /** Tab size. */
  size: number;
  /** Lean and wobble. */
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface PuzzleCut {
  cols: number;
  rows: number;
  /** Edge between row r-1 and r at column c: horizontal[(r - 1) * cols + c], r = 1..rows-1. */
  horizontal: TabShape[];
  /** Edge between column c-1 and c at row r: vertical[r * (cols - 1) + (c - 1)], c = 1..cols-1. */
  vertical: TabShape[];
}

function tab(rng: Rng): TabShape {
  const between = (lo: number, hi: number) => lo + rng.next() * (hi - lo);
  return {
    flip: rng.next() < 0.5 ? 1 : -1,
    centre: between(0.4, 0.6),
    size: between(0.085, 0.115),
    a: between(-0.05, 0.05),
    b: between(-0.03, 0.03),
    c: between(-0.035, 0.035),
    d: between(-0.035, 0.035),
  };
}

/** The same seed always cuts the same pieces (server and every player agree). */
export function cutPuzzle(cols: number, rows: number, seed: number): PuzzleCut {
  const rng = new Rng(seed);
  const horizontal: TabShape[] = [];
  const vertical: TabShape[] = [];
  for (let i = 0; i < (rows - 1) * cols; i++) horizontal.push(tab(rng));
  for (let i = 0; i < rows * (cols - 1); i++) vertical.push(tab(rng));
  return { cols, rows, horizontal, vertical };
}

/**
 * The curve of one tabbed edge from (0,0) to (1,0) as three cubic Béziers (each [c1, c2, end]),
 * with y measured out from the edge as a fraction of the piece's short side.
 */
export function tabCurve(t: TabShape): [number, number][][] {
  const { centre: m, size: s, a, b, c, d } = t;
  const y = (v: number) => v * t.flip;
  return [
    [
      [0.2, y(a)],
      [m + b + d, y(-s + c)],
      [m - s + b, y(s + c)],
    ],
    [
      [m - 2 * s + b - d, y(3 * s + c)],
      [m + 2 * s + b - d, y(3 * s + c)],
      [m + s + b, y(s + c)],
    ],
    [
      [m + b + d, y(-s + c)],
      [0.8, y(-a)],
      [1, 0],
    ],
  ];
}

/** How far a tab can reach past its piece's edge, as a fraction of the short side. */
export const TAB_REACH = 0.4;

// ------------------------------------------------------------------ the shared table

/** A piece where it lies: top-left corner in board coordinates, and its group. */
export interface PieceSpot {
  x: number;
  y: number;
  g: number;
}

/**
 * The table around the frame: room for every loose piece (about four times the picture's area),
 * kept not much wider than it is tall so it fits a laptop and a sideways or upright phone. With
 * only a few big pieces, it's wide enough for a ring of them all the way around.
 */
export function tableBounds(width: number, height: number, cols: number, rows: number) {
  const pw = width / cols;
  const ph = height / rows;
  const ring = 0.6 * Math.min(pw, ph);
  const mx = Math.max(0.6 * width, ring + 1.4 * pw);
  const tall = Math.max(2 * height, (width + 2 * mx) / 1.3, height + 2 * (ring + 1.4 * ph));
  const my = (tall - height) / 2;
  return { minX: -mx, minY: -my, maxX: width + mx, maxY: height + my };
}

/** What's saved to disk and sent to players. */
export interface PuzzleState {
  /** Unguessable id: how a puzzle is continued later. */
  id: string;
  image: string;
  imageFile: string;
  title: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  seed: number;
  /** pieces[r * cols + c] */
  pieces: PieceSpot[];
  /** Groups locked into the frame. */
  locked: number[];
  createdAt: number;
  updatedAt: number;
  /** When it was finished, if it has been. */
  doneAt: number | null;
}

/**
 * 0..1: how much of the puzzle is in place: pieces joined to at least one other, or set in their
 * spot in the frame (`locked` groups). 1 when it's all one piece.
 */
export function puzzleProgress(pieces: PieceSpot[], locked: readonly number[] = []): number {
  if (pieces.length <= 1) return 1;
  const sizes = new Map<number, number>();
  for (const p of pieces) sizes.set(p.g, (sizes.get(p.g) ?? 0) + 1);
  let placed = 0;
  for (const p of pieces) if ((sizes.get(p.g) ?? 0) > 1 || locked.includes(p.g)) placed++;
  return placed / pieces.length;
}

/** Nothing joined and nothing in the frame yet: not worth saving. */
export function puzzleUntouched(s: Pick<PuzzleState, 'pieces' | 'locked'>): boolean {
  return s.locked.length === 0 && puzzleProgress(s.pieces, s.locked) === 0;
}

/** A saved puzzle as the "Continue a puzzle" list shows it. */
export interface PuzzleSummary {
  id: string;
  image: string;
  imageFile: string;
  title: string;
  pieces: number;
  progress: number;
  updatedAt: number;
  done: boolean;
}

export function isPuzzleId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9]{16}$/.test(v);
}
