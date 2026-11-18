import { describe, expect, it } from 'vitest';
import { LOUPE_FILL, LOUPE_MIN_ZOOM, loupeZoom } from '../src/loupe';

// A 50-piece puzzle of the dog photo: square pieces 178 board units across, tabs reaching 40%.
const piece = 178;
const tab = 0.4 * piece;
// A phone's magnifier (radius in screen pixels).
const r = 83;

describe('the magnifier', () => {
  it('shows a piece that is small on screen, enlarged to fill about half of it', () => {
    const scale = 0.108; // the whole table on a phone: pieces about 19 pixels across
    const zoom = loupeZoom(piece, piece, tab, scale, r)!;
    expect(zoom).toBeGreaterThan(scale * LOUPE_MIN_ZOOM);
    expect((piece + 2 * tab) * zoom).toBeCloseTo(2 * r * LOUPE_FILL, 5);
  });

  it('always enlarges at least a little', () => {
    const scale = 0.4; // pieces about 71 pixels across
    expect(loupeZoom(piece, piece, tab, scale, r)).toBeCloseTo(scale * LOUPE_MIN_ZOOM, 9);
  });

  it('stays away when the piece is already big on screen (a finger hides little of it)', () => {
    expect(loupeZoom(piece, piece, tab, 0.6, r)).toBeNull();
  });

  it('goes by the longer side of pieces that aren’t square', () => {
    // A wide piece: as big as a square one its width, not its height.
    expect(loupeZoom(piece, piece / 2, tab / 2, 0.6, r)).toBeNull();
    expect(loupeZoom(piece, piece / 2, tab / 2, 0.3, r)).not.toBeNull();
  });
});
