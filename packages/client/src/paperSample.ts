// Fills in the dev-only Cut Paper sample sheet (paper.html).
import { cardBackHtml, cardFaceSvg, dominoSvg, type Rank, type Suit } from './paperArt';

const $ = (id: string) => document.getElementById(id)!;

// Font candidates: ?font=<name> swaps the whole sheet.
const FONTS: Record<string, string> = {
  'Open Sans': 'Open+Sans:wght@400;800',
  'Nunito Sans': 'Nunito+Sans:opsz,wght@6..12,400;6..12,800',
  'Atkinson Hyperlegible Next': 'Atkinson+Hyperlegible+Next:wght@400;800',
  Figtree: 'Figtree:wght@400;800',
  'Noto Sans': 'Noto+Sans:wght@400;800',
};
const font = new URLSearchParams(location.search).get('font') ?? 'Atkinson Hyperlegible Next';
if (FONTS[font]) {
  ($('font-css') as HTMLLinkElement).href = `https://fonts.googleapis.com/css2?family=${FONTS[font]}&display=swap`;
  document.documentElement.style.setProperty('--font', `'${font}', system-ui, sans-serif`);
}
$('fonts').innerHTML = Object.keys(FONTS)
  .map((f) => `<a href="?font=${encodeURIComponent(f)}"${f === font ? ' aria-current="true"' : ''}>${f}</a>`)
  .join(' · ');

// Choose a game. Each game has its own paper colour.
const GAMES: [string, string, string, string?][] = [
  ['jigsaw', 'Jigsaw', 'sky'],
  ['dominoes', 'Dominoes', 'mint', 'Work in Progress'],
  ['hearts', 'Hearts', 'butter', 'Work in Progress'],
  ['spades', 'Spades', 'lilac', 'Work in Progress'],
  ['tanks', 'Tanks', 'peach'],
];
$('choices').innerHTML = GAMES.map(
  ([id, name, tint, note], i) =>
    `<label class="pc-choice paper-${tint}"><input type="radio" name="game" value="${id}"${i === 0 ? ' checked' : ''} /><img src="/art/games/${id}.webp" alt="" /><span>${name}${note ? `<small>${note}</small>` : ''}</span></label>`,
).join('');

// Dominoes: a small cross on the board (mirrored arms, never a pinwheel) and a hand.
const tile = (a: number, b: number, v = false, cls = '') => `<span class="pc-domino${v ? ' v' : ''} ${cls}" style="--u: 30px">${dominoSvg(a, b, v)}</span>`;
$('board').innerHTML =
  `<div class="row">${tile(2, 6, true)}</div>` +
  `<div class="row">${tile(3, 6)}${tile(6, 6, true)}${tile(6, 4)}</div>` +
  `<div class="row">${tile(6, 1, true)}</div>`;
const hand: [number, number][] = [
  [5, 5],
  [2, 3],
  [4, 4],
  [0, 1],
  [4, 5],
  [3, 3],
];
$('hand').innerHTML = hand.map(([a, b], i) => tile(a, b, false, i === 1 ? 'is-picked' : '').replace('--u: 30px', '--u: 36px')).join('');

// Cards.
const card = (r: Rank, s: Suit, cls = '') => `<span class="pc-card ${cls}">${cardFaceSvg(r, s)}</span>`;

// The whole deck.
const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
$('deck').innerHTML = (['H', 'S', 'D', 'C'] as Suit[]).map((s) => RANKS.map((r) => card(r, s)).join('')).join('');
const show: [Rank, Suit][] = [
  ['A', 'S'],
  ['7', 'H'],
  ['10', 'D'],
  ['J', 'C'],
  ['Q', 'H'],
  ['K', 'S'],
];
$('cards').innerHTML = show.map(([r, s]) => card(r, s)).join('') + `<span class="pc-card back">${cardBackHtml()}</span>`;
const fan: [Rank, Suit, string][] = [
  ['2', 'C', ''],
  ['9', 'C', ''],
  ['4', 'D', 'is-dim'],
  ['J', 'D', 'is-dim'],
  ['3', 'H', 'is-up'],
  ['Q', 'S', ''],
  ['A', 'H', ''],
];
$('fan').innerHTML = fan.map(([r, s, c]) => card(r, s, c)).join('');
