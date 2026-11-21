// Cut Paper art drawn in code: suits, playing cards and dominoes, as SVG strings.
// The paper itself (colour, grain, shadow) comes from CSS (paper.css); these SVGs only draw
// what's printed or stuck on top, so every piece shares one texture and one light source.

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

export const SUIT_NAME: Record<Suit, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const RANK_NAME: Record<Rank, string> = {
  A: 'Ace', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '10': '10', J: 'Jack', Q: 'Queen', K: 'King',
};

/** Cards are printed the classic way: red and black. (The card red is deeper than tomato so small corner numbers stay readable on white.) */
export const suitColor = (s: Suit) => (s === 'H' || s === 'D' ? 'var(--card-red)' : 'var(--card-black)');

/** Suit shapes in a 100 x 100 box (separate shapes for the club, so overlaps never cut holes). */
const SUIT_SHAPE: Record<Suit, string> = {
  H: '<path d="M50 90C22 68 4 50 4 30 4 15 15 5 29 5c10 0 17 6 21 14 4-8 11-14 21-14 14 0 25 10 25 25 0 20-18 38-46 60z"/>',
  S: '<path d="M50 4c28 24 46 40 46 58 0 13-10 22-22 22-9 0-16-4-20-11 1 10 5 17 12 22H34c7-5 11-12 12-22-4 7-11 11-20 11C14 84 4 75 4 62 4 44 22 28 50 4z"/>',
  D: '<path d="M50 3Q68 28 88 50 68 72 50 97 32 72 12 50 32 28 50 3z"/>',
  C: '<circle cx="50" cy="28" r="21"/><circle cx="26" cy="58" r="21"/><circle cx="74" cy="58" r="21"/><circle cx="50" cy="52" r="12"/><path d="M45 56c0 18-4 30-12 39h34c-8-9-12-21-12-39z"/>',
};

/** A suit symbol as its own small SVG (for labels, scores, the trump marker). */
export function suitSvg(s: Suit, size = '1em') {
  return `<svg class="suit" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true" fill="${suitColor(s)}">${SUIT_SHAPE[s]}</svg>`;
}

function pip(s: Suit, cx: number, cy: number, size: number, flip = false) {
  const k = size / 100;
  const t = `translate(${cx - size / 2} ${cy - size / 2}) scale(${k})` + (flip ? ' rotate(180 50 50)' : '');
  return `<g transform="${t}">${SUIT_SHAPE[s]}</g>`;
}

// Pip layouts on a 250 x 350 card: columns and rows of the centre area.
const L = 88, C = 125, R = 162;
const T = 92, B = 258, M = 175, U = 147, D = 203;
const LAYOUT: Record<string, [number, number][]> = {
  '2': [[C, T], [C, B]],
  '3': [[C, T], [C, M], [C, B]],
  '4': [[L, T], [R, T], [L, B], [R, B]],
  '5': [[L, T], [R, T], [C, M], [L, B], [R, B]],
  '6': [[L, T], [R, T], [L, M], [R, M], [L, B], [R, B]],
  '7': [[L, T], [R, T], [C, 133], [L, M], [R, M], [L, B], [R, B]],
  '8': [[L, T], [R, T], [C, 133], [L, M], [R, M], [C, 217], [L, B], [R, B]],
  '9': [[L, T], [R, T], [L, U], [R, U], [C, M], [L, D], [R, D], [L, B], [R, B]],
  '10': [[L, T], [R, T], [C, 120], [L, U], [R, U], [L, D], [R, D], [C, 230], [L, B], [R, B]],
};

/**
 * The royals: cut-paper portraits (the project's own art, in public/art/cards/<rank><suit>.webp),
 * cut out of their white backgrounds, with their paper shadow baked in (PAD px around each, so
 * the cards need no SVG filter: filters made every redraw slow). Pixel sizes, padding included,
 * so all 12 share one scale.
 *
 * Jokers (no game deals them yet) are whole card faces instead: public/art/cards/joker-black.webp
 * and joker-red.webp, 420 x 588, the card's own 250 x 350 shape, so a joker's face is just
 * <image href="/art/cards/joker-red.webp" width="250" height="350"/>.
 */
const PORTRAIT: Record<string, [number, number]> = {
  JD: [381, 410], QD: [380, 414], KD: [392, 416],
  JH: [376, 403], QH: [376, 409], KH: [383, 408],
  JC: [385, 406], QC: [377, 408], KC: [409, 414],
  JS: [358, 400], QS: [368, 407], KS: [368, 406],
};
const PORTRAIT_PAD = 10;
// Placement on the 250 x 350 card: roughly centred top to bottom (the card's middle is y 175),
// and narrow enough that the corners stay clear: the top one ends at y 118, and the upside-down
// one starts at x 202, y 232. (Measured on the portrait itself, not its padding.)
const PORTRAIT_SCALE = 0.4; // portrait px -> card units
const PORTRAIT_X = 123; // centre
const PORTRAIT_BOTTOM = 255;

function portrait(rank: Rank, s: Suit) {
  const [pw, ph] = PORTRAIT[rank + s];
  const w = pw * PORTRAIT_SCALE;
  const h = ph * PORTRAIT_SCALE;
  const bottom = PORTRAIT_BOTTOM + PORTRAIT_PAD * PORTRAIT_SCALE;
  return `<image href="/art/cards/${rank}${s}.webp" x="${(PORTRAIT_X - w / 2).toFixed(1)}" y="${(bottom - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`;
}

/** A paper piece's shadow without a filter: the same shape, ink-tinted, a little lower. */
const shadowOf = (shape: string) => `<g fill="#112875" fill-opacity=".2" transform="translate(0 2.2)">${shape}</g>`;

/** The Ace: a big paper suit with a smaller, lighter one stuck on top. */
function ace(s: Suit) {
  const light = s === 'H' || s === 'D' ? 'var(--card-red-light)' : 'var(--card-black-light)';
  const big = pip(s, C, M, 128);
  const small = pip(s, C, M + 4, 70);
  return `${shadowOf(big)}${big}${shadowOf(small)}<g fill="${light}">${small}</g>`;
}

/**
 * The printed face of a playing card, drawn on a 250 x 350 box. Put it inside an element with
 * the `pc-card` class (paper.css), which supplies the card stock, the rounded corners and the shadow.
 */
export function cardFaceSvg(rank: Rank, s: Suit) {
  const corner = (flip: boolean) =>
    `<g${flip ? ' transform="rotate(180 125 175)"' : ''}><text x="30" y="70" text-anchor="middle" class="pc-rank"${rank === '10' ? ' textLength="50" lengthAdjust="spacingAndGlyphs"' : ''}>${rank}</text>${pip(s, 30, 100, 36)}</g>`;
  let middle: string;
  if (rank === 'A') middle = ace(s);
  else if (rank === 'J' || rank === 'Q' || rank === 'K') middle = portrait(rank, s);
  else middle = LAYOUT[rank].map(([x, y]) => pip(s, x, y, 46, y > M)).join('');
  // The corners go last, so they sit on top if a portrait reaches into them.
  return `<svg viewBox="0 0 250 350" fill="${suitColor(s)}" role="img" aria-label="${RANK_NAME[rank]} of ${SUIT_NAME[s]}">${middle}${corner(false)}${corner(true)}</svg>`;
}

/**
 * One of the user's felt card backs (art/backs, 1 to CARD_BACK_COUNT), already card-shaped with
 * its own cream border and rounded corners. Goes inside a card-sized element.
 */
export function feltBackHtml(n: number) {
  return `<img class="felt-back" src="/art/backs/back-${String(n).padStart(2, '0')}.webp" alt="" draggable="false" />`;
}

/**
 * The back of a card, like a real deck: a white border around a cobalt panel (its own piece of
 * paper) with a small diamond pattern and the drawer mark. Goes inside `<span class="pc-card back">`.
 */
export function cardBackHtml() {
  return (
    '<span class="pc-back-panel" aria-hidden="true"><svg viewBox="0 0 200 300" preserveAspectRatio="xMidYMid slice">' +
    '<defs><pattern id="pc-diamonds" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M10 3 17 10 10 17 3 10z" fill="#fff" fill-opacity=".13"/></pattern></defs>' +
    '<rect width="200" height="300" fill="url(#pc-diamonds)"/>' +
    '<circle cx="100" cy="150" r="38" fill="#fff"/>' +
    '<g transform="translate(66 118) scale(1.62)"><path fill="#ef5943" d="m3 12 8-9 13 10-8 10z"/><path fill="#ffcb2d" d="M17 5 31 1l5 16-14 4z"/><path fill="#103db6" d="m1 15 18 4 21-6-2 16-19 7L2 30z"/><path fill="#fff" d="m14 23 11-1-1 3-9 1z"/></g>' +
    '</svg></span>'
  );
}

// Domino pips in one square half, 100 x 100.
const PIPS: Record<number, [number, number][]> = {
  0: [],
  1: [[50, 50]],
  2: [[75, 25], [25, 75]],
  3: [[75, 25], [50, 50], [25, 75]],
  4: [[25, 25], [75, 25], [25, 75], [75, 75]],
  5: [[25, 25], [75, 25], [50, 50], [25, 75], [75, 75]],
  6: [[25, 25], [50, 25], [75, 25], [25, 75], [50, 75], [75, 75]],
};

/**
 * A domino's printed face. Horizontal tiles are 200 x 100 (a on the left); vertical ones 100 x 200
 * (a on top). Drawn separately rather than rotated, so the CSS shadow always falls downward.
 * Put it inside an element with the `pc-domino` class.
 */
export function dominoSvg(a: number, b: number, vertical = false) {
  const half = (n: number, ox: number, oy: number) =>
    PIPS[n].map(([x, y]) => `<circle cx="${ox + (vertical ? y : x)}" cy="${oy + (vertical ? x : y)}" r="9.5"/>`).join('');
  const line = vertical ? '<path d="M14 100H86"/>' : '<path d="M100 14V86"/>';
  const [w, h] = vertical ? [100, 200] : [200, 100];
  const second = vertical ? half(b, 0, 100) : half(b, 100, 0);
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Domino ${a}–${b}"><g class="pd-line">${line}</g><g class="pd-pips">${half(a, 0, 0)}${second}</g></svg>`;
}
