/** How much of the magnifier the piece you're holding (tabs and all) fills. */
export const LOUPE_FILL = 0.55;
/** The magnifier always enlarges at least this much. */
export const LOUPE_MIN_ZOOM = 1.25;

/**
 * How much the magnifier shows the piece you're holding enlarged (screen pixels per board unit),
 * or null when it shouldn't show at all.
 *
 * It's there because a finger covers a piece that's small on screen. So it shows only while the
 * piece would fit inside it enlarged: a piece that's already big on screen isn't hidden by a
 * finger, and the magnifier would just cover the table. (Groups of pieces never get one: see the
 * jigsaw view.)
 *
 * `w` and `h` are the piece's size in board units (without tabs), `tab` how far tabs stick out,
 * `scale` the table's zoom, and `r` the magnifier's radius in screen pixels.
 */
export function loupeZoom(w: number, h: number, tab: number, scale: number, r: number): number | null {
  const body = Math.max(w, h);
  if (body * scale * LOUPE_MIN_ZOOM > 1.2 * r) return null;
  return Math.max(scale * LOUPE_MIN_ZOOM, (2 * r * LOUPE_FILL) / (body + 2 * tab));
}
