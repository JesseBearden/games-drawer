// Dev-only page (design.html): the felt design system in one place. It shows DESIGN.md's named
// values (the text sizes, corners, heights and colours in felt.css) and every shared piece in every
// state, drawn with the site's own stylesheets loaded in the site's order, and beside each piece
// what it measures as built (text size and corner, from getComputedStyle), so a piece that's off
// the lists shows. With ?frame=phone it draws a card table at a phone's size instead, for the
// iframe on the page.
//
// Pieces are made by the site's own functions where it has one (memberTagHtml, seatNameHtml,
// cardHtml, tileSvg, tileHtml, scoreSheetHtml…). Where a piece's markup lives only inside one
// view's template, it's copied here and the page says so: a copy can fall behind the real thing.

// The site's stylesheets, in main.ts's order (mahjong.css comes with mahjongView, below).
import '@fontsource/atkinson-hyperlegible-next/400.css';
import '@fontsource/atkinson-hyperlegible-next/800.css';
import '@fontsource/lilita-one/400.css';
import './styles.css';
import './room.css';
import './paper.css';
import './entry.css';
import './table.css';
import './cards.css';
import './jigsaw.css';
import './tanks.css';
import './felt.css';
import type { MemberInfo } from '@tank/shared';
import { cardHtml, fitOneLine, fitScoreTable, fitSeatText, notePx, scoreSheetHtml, seatNameHtml, seatRows, showTrick } from './heartsView';
import { ttCardHtml } from './threeThirteenView';
import { feltBackHtml } from './paperArt';
import { tileSvg } from './dominoLayout';
import { tileHtml } from './mahjongView';
import { inviteTagHtml, memberTagHtml } from './lobby';
import { colorCss, escapeHtml } from './html';

const isFrame = new URLSearchParams(location.search).get('frame') === 'phone';
document.documentElement.classList.add(isFrame ? 'ds-frame-root' : 'ds-root');

// ------------------------------------------------------------------ the lists (DESIGN.md)

// (The "for" of each is DESIGN.md's, sections 1 and 4.)
const TEXT_SIZES = [
  { token: '--type-note', name: 'Note', for: 'A name tag’s second line (points, You, Ready), scores, counts, times, small notes', sample: 'Mom · 20 pts · 7:41 PM' },
  {
    token: '--type-text',
    name: 'Text',
    for: 'Sentences (on the way in too: a trial), messages, boxes you type into, buttons, the name on a name tag',
    sample: 'Talk and play at your own private table.',
  },
  { token: '--type-strong', name: 'Strong', for: 'The big main button, a game’s name on its tile, the line over a game', sample: 'Start with mic on' },
  { token: '--type-sub', name: 'Subheading', for: 'A sheet’s title, a section’s heading', sample: 'Pick a game' },
  { token: '--type-head', name: 'Heading', for: 'A page’s heading (Your table, Start a table); 40 px on a large layout', sample: 'Your table' },
];
const HEADLINE = { token: '--type-headline', name: 'Headline', for: 'The home page’s title only', sample: 'Play a game together.' };
const CORNERS = [
  { token: '--corner-s', name: 'Small', for: 'Marks and the smallest pieces' },
  { token: '--corner-m', name: 'Medium', for: 'Buttons, boxes you type into, name tags, chips, game tiles, the bar’s tabs' },
  { token: '--corner-l', name: 'Large', for: 'Sheets and strips' },
];

interface Lists {
  text: { name: string; px: number }[];
  corner: { name: string; px: number }[];
}

/** The lists in px, as this browser works them out (rem follows its own text size setting). */
function readLists(): Lists {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.body.append(el);
  const cs = getComputedStyle(el);
  const font = (token: string) => {
    el.style.fontSize = `var(${token})`;
    return round1(parseFloat(cs.fontSize));
  };
  const corner = (token: string) => {
    el.style.borderTopLeftRadius = `var(${token})`;
    return round1(parseFloat(cs.borderTopLeftRadius));
  };
  const lists = {
    text: [...TEXT_SIZES, HEADLINE].map((t) => ({ name: t.name, px: font(t.token) })),
    corner: CORNERS.map((c) => ({ name: c.name, px: corner(c.token) })),
  };
  el.remove();
  return lists;
}

// ------------------------------------------------------------------ measuring a piece as built

/** A piece to measure, inside its stage. */
interface Part {
  label: string;
  /** The piece; '' is the stage's first element. Several matches are measured as one piece cut alike. */
  sel: string;
  /** Its words: what they are, and where inside the piece ('' is the piece itself). */
  text?: [string, string][];
  /** Where its corner is ('' is the piece itself; may end in ::before or ::after). */
  corner?: string;
  /** Why it isn't counted. */
  skip?: string;
}

interface Val {
  px: number;
  on: boolean;
  /** The list entry it is, or the nearest one. */
  match: string;
}

interface Measured {
  label: string;
  texts: { what: string; vals: Val[] }[];
  corners: Val[];
  skip?: string;
  found: boolean;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const near = (want: { name: string; px: number }[], px: number) => want.reduce((a, b) => (Math.abs(b.px - px) < Math.abs(a.px - px) ? b : a));

function textVal(px: number, lists: Lists): Val {
  const hit = lists.text.find((t) => Math.abs(t.px - px) < 0.05);
  if (hit) return { px, on: true, match: hit.name };
  const n = near(lists.text, px);
  return { px, on: false, match: `${n.name}, ${fmt(n.px)}` };
}

function cornerVal(px: number, box: { width: number; height: number }, lists: Lists): Val {
  // Fully round: a dot, or a pill whose ends are half circles, whatever number made it so.
  if (box.width > 0 && box.height > 0 && px >= Math.min(box.width, box.height) / 2 - 0.5) return { px, on: true, match: 'Round' };
  const hit = lists.corner.find((c) => Math.abs(c.px - px) < 0.05);
  if (hit) return { px, on: true, match: hit.name };
  const n = near(lists.corner, px);
  return { px, on: false, match: `${n.name}, ${fmt(n.px)}` };
}

const RADII = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'] as const;

function measure(root: ParentNode, part: Part, lists: Lists): Measured {
  const first = root instanceof Element ? root.firstElementChild : null;
  const pieces = part.sel ? [...root.querySelectorAll<HTMLElement>(part.sel)] : first instanceof HTMLElement ? [first] : [];
  const texts = (part.text ?? []).map(([what, sel]) => {
    const sizes = new Set<number>();
    for (const p of pieces) for (const el of sel ? [...p.querySelectorAll(sel)] : [p]) sizes.add(round1(parseFloat(getComputedStyle(el).fontSize)));
    return { what, vals: [...sizes].sort((a, b) => a - b).map((px) => textVal(px, lists)) };
  });
  const corners = new Map<string, Val>();
  if (part.corner !== undefined) {
    const m = part.corner.match(/^(.*?)(::before|::after)?$/)!;
    const sel = m[1].trim();
    const pseudo = m[2] ?? null;
    for (const p of pieces) {
      const el = sel ? p.querySelector(sel) : p;
      if (!el) continue;
      const cs = getComputedStyle(el, pseudo);
      const box = pseudo ? { width: parseFloat(cs.width) || 0, height: parseFloat(cs.height) || 0 } : el.getBoundingClientRect();
      for (const prop of RADII) {
        const one = cs[prop].split(' ')[0];
        const px = round1(one.endsWith('%') ? (parseFloat(one) / 100) * box.width : parseFloat(one));
        if (!(px > 0)) continue; // (a tab's square side: only its free side is rounded)
        const v = cornerVal(px, box, lists);
        corners.set(`${v.px} ${v.match}`, v);
      }
    }
  }
  return { label: part.label, texts, corners: [...corners.values()].sort((a, b) => a.px - b.px), skip: part.skip, found: pieces.length > 0 };
}

const counted = (m: Measured) => !m.skip && m.found;
const isOn = (m: Measured) => m.found && m.texts.every((t) => t.vals.every((v) => v.on)) && m.corners.every((v) => v.on);

function valHtml(v: Val, judged = true) {
  if (!judged) return `<span class="ds-v">${fmt(v.px)} px</span>`;
  return v.on
    ? `<span class="ds-v">${fmt(v.px)} px</span> <span class="ds-m">(${v.match})</span>`
    : `<span class="ds-v is-off">${fmt(v.px)} px</span> <span class="ds-m">(not on the list; nearest is ${v.match})</span>`;
}

function partHtml(m: Measured) {
  const verdict = m.skip
    ? '<span class="ds-chip is-skip">not counted</span>'
    : !m.found
      ? '<span class="ds-chip is-off">not found on the page</span>'
      : isOn(m)
        ? '<span class="ds-chip">on the lists</span>'
        : '<span class="ds-chip is-off">off the lists</span>';
  const val = (v: Val) => valHtml(v, !m.skip);
  const bits = m.texts.filter((t) => t.vals.length).map((t) => `<span>${t.what} ${t.vals.map(val).join(' and ')}</span>`);
  if (m.corners.length) bits.push(`<span>Corner ${m.corners.map(val).join(' and ')}</span>`);
  if (m.skip) bits.push(`<span class="ds-why">${m.skip}</span>`);
  return `<div class="ds-part"><b>${escapeHtml(m.label)}</b>${verdict}${bits.join('')}</div>`;
}

// ------------------------------------------------------------------ pressed, pointed at, focused

/**
 * A page can't hold a button down or keep a box focused, so every rule the site has for :active,
 * :hover and :focus(-visible) is copied, just after itself, onto a class (ds-active, ds-hover,
 * ds-focus), and the pieces showing those states wear the class. The looks are the site's own
 * rules, so they can't drift from them. (Saving a stylesheet while the page is open drops the
 * copies: reload.)
 */
const STATE_CLASS: Record<string, string> = { active: 'ds-active', hover: 'ds-hover', 'focus-visible': 'ds-focus', focus: 'ds-focus' };
const STATE_RE = /:(active|hover|focus-visible|focus)(?![\w-])/;

function selectorParts(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(sel.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(sel.slice(start).trim());
  return out;
}

function copyStates(rules: CSSRuleList, into: CSSStyleSheet | CSSGroupingRule) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r instanceof CSSStyleRule) {
      const parts = selectorParts(r.selectorText).filter((s) => STATE_RE.test(s));
      if (!parts.length) continue;
      const sel = parts.map((s) => s.replace(new RegExp(STATE_RE.source, 'g'), (_, k: string) => `.${STATE_CLASS[k]}`)).join(', ');
      try {
        into.insertRule(`${sel} { ${r.style.cssText} }`, i + 1);
      } catch {
        /* a state no class can stand for (a scroll bar's thumb) */
      }
    } else if (r instanceof CSSGroupingRule) copyStates(r.cssRules, r);
  }
}

function copyAllStates() {
  for (const sheet of [...document.styleSheets]) {
    try {
      copyStates(sheet.cssRules, sheet);
    } catch {
      /* a stylesheet from elsewhere (there are none) */
    }
  }
}

// ------------------------------------------------------------------ pieces

interface Spec {
  title: string;
  about?: string;
  /** Where the piece comes from. */
  from: string;
  /** Its markup is copied from a view: not yet a shared piece. */
  copied?: boolean;
  /** The stage's classes: the felt it lies on, and any game wrapper its styles need. */
  stage: string;
  style?: string;
  html: string;
  parts: Part[];
  wide?: boolean;
  /** Run once it's on the page, and again on a resize (fitting names, as the views do). */
  after?: (stage: HTMLElement) => void;
}

interface Group {
  title: string;
  intro?: string;
  specs: Spec[];
}

const classes = (c: string) => `The site’s classes: ${c}.`;
const copiedFrom = (where: string) => `Markup copied from ${where}: not yet a shared piece.`;

// Copied from main.ts (renderName).
const DICE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2.2"/><g fill="currentColor"><circle cx="8" cy="8" r="1.7"/><circle cx="16" cy="8" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="8" cy="16" r="1.7"/><circle cx="16" cy="16" r="1.7"/></g></svg>';
// Copied from index.html (the bar).
const CHAT_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" /></svg>';
const MENU_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" /></svg>';
const FUNNEL_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 5h16l-6.2 7.4V18l-3.6 2v-7.6z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" /></svg>';

function barHtml(mic: 'Mute mic' | 'Unmute mic') {
  return `<nav class="toolbar pc-toolbar" aria-label="Table">
    <button id="btn-mic" class="pc-btn ${mic === 'Mute mic' ? 'pc-btn-main' : 'pc-btn-alert'}" type="button">${mic}</button>
    <button class="bar-tab chat-toggle" type="button" aria-label="Messages" title="Messages">${CHAT_SVG}<span class="bar-dot"></span></button>
    <button class="bar-tab" type="button" aria-label="Menu" title="Menu">${MENU_SVG}</button>
  </nav>`;
}

const person = (name: string, color: number, connected = true): MemberInfo => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, color, connected });
const PEOPLE = ['Jesse', 'Mom', 'Sam', 'Liz', 'Mory', 'Penny', 'Grandpa', 'Ana'].map((n, i) => person(n, i));
const tags = (html: string) => `<section class="tb-here"><ul class="lobby-people">${html}</ul></section>`;
const TAG_PART: Part = { label: 'Name tag', sel: '.pc-tag', text: [['Name', '.pc-nm'], ['Note', '.pc-note']], corner: '' };

/** A name tag at a card table: seatNameHtml inside the tag the views wrap it in (copied). */
const seatTag = (name: string, felt: string, score: string, opts: { bot?: boolean; away?: boolean; cls?: string } = {}) =>
  `<div class="ht-seat${opts.cls ? ` ${opts.cls}` : ''}" data-felt="${felt}">${seatNameHtml(name, opts)}<div class="ht-score">${score}</div></div>`;
const SEAT_PART: Part = { label: 'Name tag', sel: '.ht-seat', text: [['Name', '.ht-nm'], ['Points', '.ht-score']], corner: '' };
/** As fitSeatText fits a tag on its own (a name or score shrinks to Note at the least). */
function fitTags(stage: HTMLElement) {
  const least = notePx();
  for (const el of stage.querySelectorAll<HTMLElement>('.ht-nm, .ht-score')) fitOneLine(el, least);
}

const gameTile = (id: string, name: string, felt: string, state: '' | 'picked' | 'locked' = '') =>
  `<button class="pc-choice paper-${felt}${state === 'picked' ? ' is-picked' : ''}${state === 'locked' ? ' is-locked' : ''}" data-game="${id}" type="button" aria-pressed="${state === 'picked'}"${state === 'locked' ? ' aria-disabled="true"' : ''}><img src="/art/games/${id}.webp" alt="" width="52" height="52" /><span>${name}${state === 'locked' ? '<small>Up to 4</small>' : ''}</span></button>`;

const time = (h: number, m: number) => new Date(2026, 10, 27, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const note = (from: string, color: number, at: string, text: string, cls = '') =>
  `<li${cls ? ` class="${cls}"` : ''}><span class="msg-head"><span class="who" style="color:${colorCss(color)}">${escapeHtml(from)}</span><span class="time">${at}</span></span><span class="msg-text">${escapeHtml(text)}</span></li>`;

const handTile = (a: number, b: number, cls: string) => `<button type="button" class="dm-tile dm-mine ${cls}" aria-label="${a} and ${b}">${tileSvg(a, b, false)}</button>`;

const CARD_SKIP = 'A card’s corner is a share of its own width, and its numbers are drawn, not type.';
const TILE_SKIP = 'A tile’s corner is a share of its own width, and it has no words.';

const GROUPS: Group[] = [
  {
    title: 'Buttons',
    intro: 'Only buttons stand up off the table, so you can tell what to tap. Each says what will happen, starting with a verb.',
    specs: [
      {
        title: 'Main button',
        about: 'Cobalt. One per screen.',
        from: classes('pc-btn pc-btn-main'),
        stage: 'pc-page',
        html: '<button class="pc-btn pc-btn-main" type="button">New game</button>',
        parts: [{ label: 'Main button', sel: '.pc-btn', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'Main button, big',
        about: 'Home, Start a table, the join page and I’m ready.',
        from: classes('pc-btn pc-btn-main pc-btn-big'),
        stage: 'pc-page',
        html: '<button class="pc-btn pc-btn-main pc-btn-big" type="button">Start a table</button>',
        parts: [{ label: 'Big button', sel: '.pc-btn', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'Plain button',
        about: 'White felt with cobalt words: every other button.',
        from: classes('pc-btn pc-btn-plain'),
        stage: 'pc-page',
        html: '<button class="pc-btn pc-btn-plain" type="button">Switch game</button>',
        parts: [{ label: 'Plain button', sel: '.pc-btn', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'Tomato button',
        about: 'Something is off: the mic, and leaving.',
        from: classes('pc-btn pc-btn-alert'),
        stage: 'pc-page',
        html: '<div class="ds-row"><button class="pc-btn pc-btn-alert" type="button">Turn on mic</button><button class="pc-btn pc-btn-alert" type="button">Leave table</button></div>',
        parts: [{ label: 'Tomato button', sel: '.pc-btn', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'Pressed',
        about: 'It sinks into the felt while you press it.',
        from: 'The site’s own :active rules, copied onto a class (ds-active).',
        stage: 'pc-page',
        html: '<div class="ds-row"><button class="pc-btn pc-btn-main ds-active" type="button">New game</button><button class="pc-btn pc-btn-plain ds-active" type="button">Switch game</button></div>',
        parts: [{ label: 'Pressed button', sel: '.pc-btn', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'Pointed at, on a computer',
        about: 'It lifts a little under the pointer.',
        from: 'The site’s own :hover rules, copied onto a class (ds-hover).',
        stage: 'pc-page',
        html: '<div class="ds-row"><button class="pc-btn pc-btn-main ds-hover" type="button">New game</button><button class="pc-btn pc-btn-plain ds-hover" type="button">Switch game</button></div>',
        parts: [{ label: 'Lifted button', sel: '.pc-btn', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'Can’t press yet',
        about: 'Send with nothing typed: white felt lying flat, with soft words.',
        from: classes('pc-btn pc-btn-main, disabled'),
        stage: 'pc-page',
        html: '<button class="pc-btn pc-btn-main" type="button" disabled>Send</button>',
        parts: [{ label: 'Disabled button', sel: '.pc-btn', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'With an icon',
        about: 'The dice beside Your name, for a random name. The only button with an icon today, and it has no words, which DESIGN.md says a button should have.',
        from: copiedFrom('main.ts (renderName)'),
        copied: true,
        stage: 'pc-page',
        html: `<div class="entry-row"><input class="pc-input" value="Mike B" aria-label="Your name" /><button type="button" class="pc-btn pc-btn-plain entry-dice" aria-label="Pick a random name" title="Pick a random name">${DICE_SVG}</button></div>`,
        parts: [{ label: 'Dice button', sel: '.entry-dice', corner: '' }],
      },
      {
        title: 'Link',
        about: 'A button that reads as a link, in a line of words.',
        from: classes('pc-link'),
        stage: 'pc-page',
        html: '<button type="button" class="pc-link">Change</button>',
        parts: [{ label: 'Link', sel: '.pc-link', text: [['Words', '']] }],
      },
    ],
  },
  {
    title: 'The bar',
    specs: [
      {
        title: 'Mic, Messages and the menu',
        about: 'The same on every screen: your mic hangs from the top-left corner, Messages (a dot means something new) and the menu from the top-right. The tomato mic tab is on the phone further down.',
        from: copiedFrom('index.html (the mic tab is styled by its id, #btn-mic)'),
        copied: true,
        stage: 'ds-baize ds-bar-stage',
        wide: true,
        html: barHtml('Mute mic'),
        parts: [
          { label: 'Mic tab', sel: '#btn-mic', text: [['Words', '']], corner: '' },
          { label: 'Messages tab', sel: '.chat-toggle', corner: '' },
          { label: 'Unread dot', sel: '.bar-dot', corner: '' },
          { label: 'Menu tab', sel: '.bar-tab:not(.chat-toggle)', corner: '' },
        ],
      },
    ],
  },
  {
    title: 'Boxes you type into',
    intro: 'Cut into the felt, so the shadow falls inside.',
    specs: [
      {
        title: 'Empty',
        from: classes('pc-field, pc-input'),
        stage: 'pc-page',
        html: '<div class="pc-field"><label for="ds-name-1">Your name</label><input id="ds-name-1" class="pc-input" placeholder="First name, like Mike or Mike B" autocomplete="off" /></div>',
        parts: [
          { label: 'Box', sel: '.pc-input', text: [['Words', '']], corner: '' },
          { label: 'Its label', sel: 'label', text: [['Words', '']] },
        ],
      },
      {
        title: 'Filled',
        from: classes('pc-field, pc-input'),
        stage: 'pc-page',
        html: '<div class="pc-field"><label for="ds-name-2">Your name</label><input id="ds-name-2" class="pc-input" value="Jesse" autocomplete="off" /></div>',
        parts: [{ label: 'Box', sel: '.pc-input', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'Focused',
        about: 'Picked with the keyboard: an ink outline.',
        from: 'The site’s own :focus-visible rule, copied onto a class (ds-focus).',
        stage: 'pc-page',
        html: '<div class="pc-field"><label for="ds-name-3">Your name</label><input id="ds-name-3" class="pc-input ds-focus" value="Jes" autocomplete="off" /></div>',
        parts: [{ label: 'Box', sel: '.pc-input', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'A table code',
        about: 'On home, with Join beside it.',
        from: copiedFrom('index.html (home)'),
        copied: true,
        stage: 'pc-page',
        html: '<label class="pc-field" for="ds-code">Have a table code?</label><div class="entry-row"><input id="ds-code" class="pc-input pc-input-code" maxlength="120" placeholder="6 letters" value="BCDFGH" autocomplete="off" /><button class="pc-btn pc-btn-plain" type="button">Join</button></div>',
        parts: [
          { label: 'Code box', sel: '.pc-input-code', text: [['Letters', '']], corner: '' },
          { label: 'Its label', sel: '.pc-field', text: [['Words', '']] },
        ],
      },
      {
        title: 'A name we already know',
        about: 'Shown as a line with Change, instead of a box.',
        from: copiedFrom('main.ts (renderName)'),
        copied: true,
        stage: 'pc-page',
        html: '<div class="pc-namerow"><b>Your name</b><span>Jesse</span><button type="button" class="pc-link">Change</button></div>',
        parts: [{ label: 'Name line', sel: '.pc-namerow', text: [['Label', 'b'], ['Name', 'span']] }],
      },
    ],
  },
  {
    title: 'Name tags on Your table',
    intro: 'Each person’s own felt, laid flat (a name tag isn’t a button), with a mark for their mic.',
    specs: [
      {
        title: 'Each person’s felt',
        about: 'Sky, lilac, peach and mint first, then blush, kraft, white and dove.',
        from: 'Built by memberTagHtml() in lobby.ts.',
        stage: 'paper-paper',
        wide: true,
        html: tags(PEOPLE.map((m) => memberTagHtml(m, [], false, { mic: 'on' })).join('')),
        parts: [{ label: 'All eight', sel: '.pc-tag', text: [['Name', '.pc-nm']], corner: '' }],
      },
      {
        title: 'You',
        from: 'Built by memberTagHtml() in lobby.ts.',
        stage: 'paper-paper',
        html: tags(memberTagHtml(PEOPLE[0], ['You'], false, { mic: 'on' })),
        parts: [TAG_PART],
      },
      {
        title: 'Mic off, and your own muted',
        about: 'Struck through: grey when off, tomato when it’s your own and muted.',
        from: 'Built by memberTagHtml() in lobby.ts.',
        stage: 'paper-paper',
        html: tags(memberTagHtml(PEOPLE[1], [], false, { mic: 'off' }) + memberTagHtml(PEOPLE[0], ['You'], false, { mic: 'muted' })),
        parts: [TAG_PART],
      },
      {
        title: 'Ready',
        about: 'A cobalt tick on the tag’s corner.',
        from: 'Built by memberTagHtml() in lobby.ts.',
        stage: 'paper-paper',
        html: tags(memberTagHtml(PEOPLE[2], ['Ready'], false, { mic: 'on', extraClass: ' is-ready' })),
        parts: [TAG_PART, { label: 'The tick', sel: '.pc-tag', corner: '::after' }],
      },
      {
        title: 'Talking',
        about: 'Rings of the tag’s own colour ripple out.',
        from: 'Built by memberTagHtml() in lobby.ts.',
        stage: 'paper-paper',
        html: tags(memberTagHtml(PEOPLE[3], [], true, { mic: 'on' })),
        parts: [TAG_PART],
      },
      {
        title: 'Away',
        about: 'Still there, faded.',
        from: 'Built by memberTagHtml() in lobby.ts.',
        stage: 'paper-paper',
        html: tags(memberTagHtml(person('Mory', 4, false), ['Away'], false, { mic: 'off' })),
        parts: [TAG_PART],
      },
      {
        title: 'Invite someone',
        about: 'The next tag along: empty, with a big cobalt +. A button, so it stands up.',
        from: 'Built by inviteTagHtml() in lobby.ts.',
        stage: 'paper-paper',
        html: tags(memberTagHtml(PEOPLE[0], ['You'], false, { mic: 'on' }) + inviteTagHtml()),
        parts: [{ label: 'Invite tag', sel: '.pc-tag-add', corner: '' }],
      },
      {
        title: 'Your mic is off',
        about: 'The tomato strip on Your table, laid flat, with a button.',
        from: copiedFrom('lobby.ts (LobbyView)'),
        copied: true,
        stage: 'paper-paper',
        wide: true,
        html: '<div class="ds-col"><div class="pc-alert"><span style="flex: 1">Your mic is off. Your friends won’t be able to hear you.</span><button class="pc-btn pc-btn-plain" type="button">Turn on mic</button></div></div>',
        parts: [
          { label: 'Strip', sel: '.pc-alert', text: [['Words', 'span']], corner: '' },
          { label: 'Its button', sel: '.pc-alert .pc-btn', text: [['Words', '']], corner: '' },
        ],
      },
    ],
  },
  {
    title: 'Name tags in a game',
    intro: 'On the green table, in each player’s own felt, every tag the same size. A long name shrinks a little (to Note at the least) and then ends in “…”. (Mahjong’s tags are on its own table, drawn at fixed sizes: they move onto the lists later.)',
    specs: [
      {
        title: 'Plain',
        from: 'Built by seatNameHtml() in heartsView.ts; the tag around it is copied from the card games’ views.',
        copied: true,
        stage: 'ds-baize hearts-view',
        html: seatTag('Mom', 'sky', '20 pts'),
        parts: [SEAT_PART],
        after: fitTags,
      },
      {
        title: 'Whose turn it is',
        about: 'A band of sunflower round the tag.',
        from: 'Built by seatNameHtml() in heartsView.ts; the tag around it is copied from the card games’ views.',
        copied: true,
        stage: 'ds-baize hearts-view',
        html: seatTag('Sam', 'lilac', '12 pts', { cls: 'turn' }),
        parts: [SEAT_PART],
        after: fitTags,
      },
      {
        title: 'Away',
        about: 'A small “zzz” after the name.',
        from: 'Built by seatNameHtml() in heartsView.ts; the tag around it is copied from the card games’ views.',
        copied: true,
        stage: 'ds-baize hearts-view',
        html: seatTag('Liz', 'peach', '31 pts', { away: true }),
        parts: [SEAT_PART],
        after: fitTags,
      },
      {
        title: 'A computer player',
        about: 'A robot name and a small computer screen.',
        from: 'Built by seatNameHtml() in heartsView.ts; the tag around it is copied from the card games’ views.',
        copied: true,
        stage: 'ds-baize hearts-view',
        html: seatTag('Robo-Bob', 'mint', '8 pts', { bot: true }),
        parts: [SEAT_PART],
        after: fitTags,
      },
      {
        title: 'A long name',
        about: 'Shrinks, then ends in “…”. The first is as long as a name can be (15 letters); the second is longer than that, to show where “…” comes in.',
        from: 'Built by seatNameHtml() and fitted by fitOneLine() in heartsView.ts; the tag around it is copied from the card games’ views.',
        copied: true,
        stage: 'ds-baize hearts-view',
        html: `<div class="ds-row">${seatTag('Wendy Woodworth', 'blush', '44 pts')}${seatTag('Maximiliana Wolfgang-Smith-Barrington', 'dove', '9 pts')}</div>`,
        parts: [SEAT_PART],
        after: fitTags,
      },
      {
        title: 'Talking',
        about: 'Rings of the tag’s own colour.',
        from: 'Built by seatNameHtml() in heartsView.ts; the tag around it is copied from the card games’ views.',
        copied: true,
        stage: 'ds-baize hearts-view',
        html: seatTag('Mory', 'kraft', '17 pts', { cls: 'speaking' }),
        parts: [SEAT_PART],
        after: fitTags,
      },
    ],
  },
];

/** The phone (an iframe of this page with ?frame=phone): its readouts arrive by message. */
const PHONE_SPEC: Spec = {
  title: 'On a phone held upright',
  about: 'A card table in a frame 390 px wide, so the phone’s own rules apply: the players on your left and right have their tags turned on their side up the edges (left reads upward, right downward), the player across is one line along the top, and the names side by side share one size. The mic tab here is tomato: Unmute mic. (Your hand is left out: its layout is the view’s own code.)',
  from: 'Built by seatNameHtml(), fitSeatText(), showTrick() and cardHtml() in heartsView.ts; the table around them is copied from heartsView.ts, and the bar from index.html.',
  copied: true,
  stage: 'is-bare',
  wide: true,
  html: '<iframe class="ds-frame" src="/design.html?frame=phone" title="A card table on a phone held upright"></iframe>',
  parts: [],
};
GROUPS[GROUPS.length - 1].specs.push(PHONE_SPEC);

GROUPS.push(
  {
    title: 'Chips and notes',
    specs: [
      {
        title: 'A score chip',
        about: 'Spades: each team’s score, laid flat.',
        from: copiedFrom('spadesView.ts'),
        copied: true,
        stage: 'ds-baize',
        html: '<div class="sp-score"><span><b>Us 120</b> <small>3 of 4 tricks</small></span><span><b>Them 85</b> <small>1 of 5 tricks</small> <small>2 bags</small></span></div>',
        parts: [{ label: 'Score chip', sel: '.sp-score > span', text: [['Score', 'b'], ['Tricks', 'small']], corner: '' }],
      },
      {
        title: 'A status chip',
        about: 'Three Thirteen: what’s left over in your hand, grass once it’s all in melds.',
        from: copiedFrom('threeThirteenView.ts'),
        copied: true,
        stage: 'ds-baize',
        html: '<div class="ds-row"><span class="tt-loose">Left over: 12 pts</span><span class="tt-loose done">All in melds</span></div>',
        parts: [{ label: 'Status chip', sel: '.tt-loose', text: [['Words', '']], corner: '' }],
      },
      {
        title: 'A pop-up note',
        about: 'Someone arriving, or a message while Messages is closed. It goes by itself (held still here).',
        from: copiedFrom('shell.ts (note)'),
        copied: true,
        stage: 'ds-baize',
        html: '<div class="toasts"><div>Miranda is here.</div><div class="toast-chat"><b class="pc-nw">Sam:</b> I can’t hear you</div></div>',
        parts: [{ label: 'Note', sel: '.toasts > div', text: [['Words', '']], corner: '' }],
      },
    ],
  },
  {
    title: 'Game tiles',
    intro: 'On Your table: each game in its own colour.',
    specs: [
      {
        title: 'Plain, picked and not available',
        about: 'Picked is lifted, with a cobalt tick. With more people here than a game takes, its tile lies flat and faded, with “Up to 4”.',
        from: copiedFrom('lobby.ts (LobbyView)'),
        copied: true,
        stage: 'paper-paper',
        wide: true,
        html: `<div class="lobby-paper"><div class="pc-choices lobby-games">${gameTile('jigsaw', 'Jigsaw', 'sky')}${gameTile('dominoes', 'Dominoes', 'mint', 'picked')}${gameTile('hearts', 'Hearts', 'butter', 'locked')}${gameTile('mahjong', 'Mahjong', 'kraft')}</div></div>`,
        parts: [
          { label: 'Plain', sel: '.pc-choice:not(.is-picked):not(.is-locked)', text: [['Name', 'span']], corner: '' },
          { label: 'Picked', sel: '.pc-choice.is-picked', text: [['Name', 'span']], corner: '' },
          { label: 'The tick', sel: '.pc-choice.is-picked', corner: '::after' },
          { label: 'Not available', sel: '.pc-choice.is-locked', text: [['Name', 'span'], ['Up to 4', 'small']], corner: '' },
        ],
      },
    ],
  },
  {
    title: 'Seats',
    intro: 'Four places round a small piece of the green table. An open seat is a button: tap it to sit. A taken one lies flat in its person’s felt.',
    specs: [
      {
        title: 'Open, taken, ready, talking and not playing',
        from: copiedFrom('lobby.ts (LobbyView)'),
        copied: true,
        stage: 'paper-paper',
        wide: true,
        html: `<div class="lobby-paper"><section class="tb-seats"><div class="tb-ring">
          <button class="tb-seat s-near is-mine is-ready" data-seat="0" data-alias="jesse" data-felt="sky" type="button"><span class="pc-talk"></span><span class="pc-nm">Jesse</span><small>You · Ready</small></button>
          <button class="tb-seat s-left is-open" data-seat="1" type="button"><span class="pc-nm">Open seat</span><small>Tap to sit</small></button>
          <button class="tb-seat s-far is-talking" data-seat="2" data-alias="mom" data-felt="lilac" type="button" aria-disabled="true"><span class="pc-talk"></span><span class="pc-nm">Mom</span></button>
          <button class="tb-seat s-right is-open is-off" data-seat="3" type="button"><span class="pc-nm">Empty</span><small>Not playing</small></button>
          <div class="tb-mat" aria-hidden="true"><img src="/art/games/hearts.webp" alt="" width="52" height="52" /></div>
        </div></section></div>`,
        parts: [
          { label: 'Open seat', sel: '.tb-seat.s-left', text: [['Words', '.pc-nm'], ['Note', 'small']], corner: '' },
          { label: 'Taken seat', sel: '.tb-seat.s-near', text: [['Name', '.pc-nm'], ['Note', 'small']], corner: '' },
          { label: 'The ready tick', sel: '.tb-seat.s-near', corner: '::after' },
          { label: 'Not playing', sel: '.tb-seat.s-right', text: [['Words', '.pc-nm'], ['Note', 'small']], corner: '' },
          { label: 'The little green table', sel: '.tb-mat', corner: '' },
        ],
      },
    ],
  },
  {
    title: 'Sheets and strips',
    specs: [
      {
        title: 'The menu',
        about: 'A felt sheet over the dimmed table, with its title and Close on a raised strip of kraft. Thin strips of kraft lie between its parts; your own tag is a button here (tap it to change your name).',
        from: `${copiedFrom('index.html (the menu)')} The name tags are built by memberTagHtml() and inviteTagHtml() in lobby.ts.`,
        copied: true,
        stage: 'ds-baize is-flush',
        wide: true,
        html: `<div class="sheet-wrap"><div class="pc-sheet sheet has-top menu-sheet" role="dialog" aria-label="Menu">
          <div class="sheet-top"><h2 class="pc-h3">Menu</h2><button class="pc-btn pc-btn-plain" type="button">Close</button></div>
          <div class="sheet-body">
            <div class="sheet-actions">
              <button class="pc-btn pc-btn-plain pc-btn-wide" type="button">Switch game</button>
              <button class="pc-btn pc-btn-alert pc-btn-wide" type="button">Leave table</button>
            </div>
            <section class="sheet-part tb-here menu-here" aria-label="At the table">
              <ul class="lobby-people">${memberTagHtml(PEOPLE[0], ['You'], false, { mic: 'on', edit: true })}${memberTagHtml(PEOPLE[1], [], false, { mic: 'on' })}${memberTagHtml(PEOPLE[2], [], false, { mic: 'off' })}${inviteTagHtml()}</ul>
              <div class="menu-mic"><button class="pc-btn pc-btn-plain" type="button">Turn my mic off</button><p class="pc-small">Headphones keep game sounds out of your mic.</p></div>
            </section>
            <section class="sheet-part">
              <div class="sound-row"><button id="btn-sound" class="pc-btn pc-btn-plain" type="button">Turn sound off</button><input type="range" min="0" max="100" step="5" value="80" aria-label="Volume" style="--fill: 80%" /></div>
            </section>
            <section class="sheet-part">
              <div class="menu-fullscreen"><button class="pc-btn pc-btn-plain pc-btn-wide" type="button">Full screen</button></div>
              <button class="pc-btn pc-btn-plain pc-btn-wide" type="button">Game Rules</button>
            </section>
            <p class="pc-small menu-legal"><a class="entry-link" href="/privacy" target="_blank" rel="noopener">Privacy</a> · <a class="entry-link" href="/rules" target="_blank" rel="noopener">House rules</a></p>
          </div>
        </div></div>`,
        parts: [
          { label: 'Sheet', sel: '.sheet', text: [['Words', ''], ['Small print', '.pc-small']], corner: '' },
          { label: 'Kraft header', sel: '.sheet-top', text: [['Title', '.pc-h3']], corner: '' },
          { label: 'Close', sel: '.sheet-top .pc-btn', text: [['Words', '']], corner: '' },
          { label: 'Menu rows', sel: '.sheet-body .pc-btn', text: [['Words', '']], corner: '' },
          { label: 'Your own tag', sel: '.pc-tag.is-editable', text: [['Name', '.pc-nm'], ['Note', '.pc-note']], corner: '' },
          { label: 'Strips between parts', sel: '.sheet-part', corner: '::before' },
        ],
      },
      {
        title: 'The I’m ready strip',
        about: 'It stays at the bottom of Your table: what’s next, who we’re waiting for, and the button.',
        from: copiedFrom('lobby.ts (LobbyView)'),
        copied: true,
        stage: 'paper-paper',
        wide: true,
        html: '<div class="ds-col"><div class="tb-go"><p><span class="tb-next">Hearts</span><span class="tb-status"><b class="pc-nw">Mom</b> and <b class="pc-nw">Sam</b> are ready.</span></p><button class="pc-btn pc-btn-main pc-btn-big" type="button">I’m ready</button></div></div>',
        parts: [
          { label: 'Strip', sel: '.tb-go', text: [['Game', '.tb-next'], ['Who’s ready', '.tb-status']], corner: '' },
          { label: 'Its button', sel: '.tb-go .pc-btn', text: [['Words', '']], corner: '' },
        ],
      },
    ],
  },
  {
    title: 'Messages',
    specs: [
      {
        title: 'Messages',
        about: 'A cream felt sheet. Others’ messages are white felt, yours cobalt; “Sam joined.” is printed straight on it. Tap someone’s message for Mute and Report.',
        from: copiedFrom('index.html and shell.ts (addChat)'),
        copied: true,
        stage: 'ds-baize',
        html: `<aside class="chat" aria-label="Messages">
          <header class="chat-head"><h2>Messages</h2><button class="chat-filter-btn" type="button" aria-expanded="false" aria-label="Message filter" title="Message filter">${FUNNEL_SVG}</button><button id="chat-collapse" class="pc-btn pc-btn-plain" type="button">Close</button></header>
          <ol class="chat-log">
            <li class="system"><span class="msg-text">Sam joined.</span> <span class="time">${time(19, 40)}</span></li>
            ${note('Mom', 1, time(19, 41), 'Hello everyone! Can you hear me?', 'reportable')}
            ${note('Jesse', 0, time(19, 42), 'Loud and clear.', 'mine')}
            ${note('Sam', 2, time(19, 43), 'Whose turn is it?', 'reportable').replace('</li>', '<div class="chat-actions"><button type="button">Mute Sam</button><button type="button">Report</button></div></li>')}
          </ol>
          <form class="chat-form"><div class="chat-row"><input class="pc-input" maxlength="200" placeholder="Write a message" autocomplete="off" aria-label="Write a message" /><button class="pc-btn pc-btn-main chat-send" type="button" disabled>Send</button></div></form>
        </aside>`,
        parts: [
          { label: 'Heading', sel: '.chat-head h2', text: [['Words', '']] },
          { label: 'Filter button', sel: '.chat-filter-btn', corner: '' },
          { label: 'Someone else’s message', sel: '.chat-log li.reportable', text: [['Name', '.who'], ['Time', '.time'], ['Message', '.msg-text']], corner: '' },
          { label: 'Your own message', sel: '.chat-log li.mine', text: [['Time', '.time'], ['Message', '.msg-text']], corner: '' },
          { label: 'Table note', sel: '.chat-log li.system', text: [['Words', '.msg-text'], ['Time', '.time']] },
          { label: 'Mute and Report', sel: '.chat-actions button', text: [['Words', '']], corner: '' },
          { label: 'Box you type into', sel: '.chat-row .pc-input', text: [['Words', '']], corner: '' },
        ],
      },
    ],
  },
  {
    title: 'Score sheet',
    specs: [
      {
        title: 'A small score sheet',
        about: 'One row per player, you first: the name with all the room it needs, the points each hand scored, then a bold Total. The hand just ended is darker. Phones show the last 3 hands.',
        from: 'Built by scoreSheetHtml() in scoreSheet.ts, seatRows() and fitScoreTable() in heartsView.ts; the sheet around it is copied from heartsView.ts.',
        copied: true,
        stage: 'ds-baize',
        wide: true,
        html: `<div class="ht-panel pc-sheet"><h2>Hand 4 done</h2>${scoreSheetHtml(
          seatRows(
            [
              { name: 'Jesse', score: 42 },
              { name: 'Mom', score: 18 },
              { name: 'Wendy Woodworth', score: 61 },
              { name: 'Robo-Bob', score: 33 },
            ],
            [
              [5, 0, 13, 8],
              [12, 4, 26, 8],
              [30, 9, 39, 20],
              [42, 18, 61, 33],
            ],
            0,
          ),
          true,
        )}<p class="pc-small">First to 100 ends the game. Lowest score wins.</p><div class="actions"><button class="pc-btn pc-btn-main" type="button">Close</button></div></div>`,
        parts: [
          { label: 'Sheet', sel: '.ht-panel', text: [['Title', 'h2'], ['Small print', '.pc-small']], corner: '' },
          { label: 'Names', sel: '.ht-sheet tbody .ht-who', text: [['Name', '.pc-nm']] },
          { label: 'Hand numbers', sel: '.ht-sheet thead th.ht-h', text: [['Words', '']] },
          { label: 'Points', sel: '.ht-sheet td.ht-h', text: [['Numbers', '']] },
          { label: 'Totals', sel: '.ht-sheet td.ht-tot', text: [['Numbers', '']] },
        ],
        after: (stage) => fitScoreTable(stage),
      },
    ],
  },
  {
    title: 'Playing pieces',
    intro: 'Cards are ivory card stock, dominoes matte ceramic, Mahjong tiles real tiles with depth. Their corners grow with them, so they aren’t counted.',
    specs: [
      {
        title: 'A number card',
        from: 'Built by cardHtml() in heartsView.ts (the face is cardFaceSvg() in paperArt.ts).',
        stage: 'ds-baize hearts-view',
        html: `<div class="ds-row ds-cards">${cardHtml('7H')}${cardHtml('TC')}</div>`,
        parts: [{ label: 'Card', sel: '.card', corner: '', skip: CARD_SKIP }],
      },
      {
        title: 'A royal',
        about: 'The user’s portraits, one per card.',
        from: 'Built by cardHtml() in heartsView.ts (the face is cardFaceSvg() in paperArt.ts).',
        stage: 'ds-baize hearts-view',
        html: `<div class="ds-row ds-cards">${cardHtml('QS')}${cardHtml('KH')}</div>`,
        parts: [{ label: 'Card', sel: '.card', corner: '', skip: CARD_SKIP }],
      },
      {
        title: 'A joker',
        about: 'The user’s art, as the whole face.',
        from: 'Built by ttCardHtml() in threeThirteenView.ts.',
        stage: 'ds-baize hearts-view',
        html: `<div class="ds-row ds-cards">${ttCardHtml('XR0', 1)}${ttCardHtml('XB0', 1)}</div>`,
        parts: [{ label: 'Card', sel: '.card', corner: '', skip: CARD_SKIP }],
      },
      {
        title: 'A card back, on the pile',
        about: 'One of the user’s 30 felt backs, with how many are left on a chip.',
        from: `The back is feltBackHtml() in paperArt.ts. ${copiedFrom('threeThirteenView.ts (the pile)')}`,
        copied: true,
        stage: 'ds-baize hearts-view',
        html: `<button class="tt-pile tt-stock" type="button" aria-label="The pile"><span class="card tt-back">${feltBackHtml(12)}</span><span class="tt-count">42</span></button>`,
        parts: [
          { label: 'Card back', sel: '.tt-back', skip: 'The back is the user’s art, with its own corners.' },
          { label: 'Count chip', sel: '.tt-count', text: [['Number', '']], corner: '' },
        ],
      },
      {
        title: 'Dominoes upright, in your hand',
        about: 'One you can play, one picked (lifted), one that can’t go this turn.',
        from: `Built by tileSvg() in dominoLayout.ts. ${copiedFrom('dominoesView.ts (the hand)')}`,
        copied: true,
        stage: 'ds-baize hearts-view dominoes-view',
        html: `<div class="ht-hand dm-hand my-turn"><div class="dm-hand-tiles">${handTile(3, 5, 'legal')}${handTile(1, 6, 'legal raised')}${handTile(0, 2, 'illegal')}</div></div>`,
        parts: [{ label: 'Domino', sel: '.dm-tile', skip: TILE_SKIP }],
      },
      {
        title: 'Dominoes lying down, on the table',
        about: 'A line with a double crosswise. The tile just played keeps a sunflower edge.',
        from: `Built by tileSvg() in dominoLayout.ts. ${copiedFrom('dominoesView.ts (the board)')}`,
        copied: true,
        stage: 'ds-baize hearts-view dominoes-view',
        html: `<div class="dm-board ds-board"><div class="dm-window"><div class="dm-layout">
          <div class="dm-tile dm-placed" style="left:0px;top:28px;width:80px;height:40px">${tileSvg(2, 4, true)}</div>
          <div class="dm-tile dm-placed dm-last" style="left:80px;top:8px;width:40px;height:80px">${tileSvg(4, 4, false)}</div>
        </div></div></div>`,
        parts: [{ label: 'Domino', sel: '.dm-tile', skip: TILE_SKIP }],
      },
      {
        title: 'Mahjong tiles, face up',
        from: 'Built by tileHtml() in mahjongView.ts. (Sizes here are the page’s: the game sizes its tiles to fit its table.)',
        stage: 'ds-baize mahjong-view',
        style: '--dw: 40px',
        html: `<div class="ds-row">${tileHtml('dr')}${tileHtml('b5')}${tileHtml('we')}${tileHtml('c7')}</div>`,
        parts: [{ label: 'Tile', sel: '.mj-t', skip: TILE_SKIP }],
      },
      {
        title: 'Mahjong tiles, face down',
        from: 'Built by tileHtml() in mahjongView.ts.',
        stage: 'ds-baize mahjong-view',
        style: '--dw: 40px',
        html: `<div class="ds-row">${tileHtml(null)}${tileHtml(null)}</div>`,
        parts: [{ label: 'Tile', sel: '.mj-t', skip: TILE_SKIP }],
      },
      {
        title: 'The small backs',
        about: 'Everyone else’s hand, face down beside their tag.',
        from: `Built by tileHtml() in mahjongView.ts. ${copiedFrom('mahjongView.ts (a player’s tiles)')}`,
        copied: true,
        stage: 'ds-baize mahjong-view',
        style: '--bw: 22px',
        html: `<div class="mj-op"><button class="mj-theirs" type="button" aria-label="Their tiles"><span class="mj-backs">${tileHtml(null).repeat(9)}</span></button></div>`,
        parts: [{ label: 'Tile', sel: '.mj-t', skip: TILE_SKIP }],
      },
    ],
  },
);

// ------------------------------------------------------------------ the page

const COLOURS: { signal?: boolean; name: string; label: string; for: string }[] = [
  { signal: true, name: 'cobalt', label: 'Cobalt', for: 'The main button (one per screen), the words on other buttons, links, something picked.' },
  { signal: true, name: 'sunflower', label: 'Sunflower', for: 'Whose turn it is.' },
  { signal: true, name: 'tomato', label: 'Tomato', for: 'Something is off: mic muted, unread messages, mic blocked, leaving.' },
  { name: 'paper', label: 'Paper (cream)', for: 'The page itself, sheets, Messages, the bar’s tabs.' },
  { name: 'white', label: 'White', for: 'Plain buttons, others’ messages, open seats, the I’m ready strip; a person’s felt.' },
  { name: 'mat', label: 'Mat (grey)', for: 'The grey table, under a game with no table of its own.' },
  { name: 'baize', label: 'Baize (green)', for: 'The card table: Hearts, Spades, Dominoes, Three Thirteen, Mahjong.' },
  { name: 'dove', label: 'Dove', for: 'The light grey Jigsaw table; a person’s felt.' },
  { name: 'sky', label: 'Sky', for: 'Jigsaw’s tile; a person’s felt.' },
  { name: 'mint', label: 'Mint', for: 'Dominoes’ tile; a person’s felt.' },
  { name: 'butter', label: 'Butter', for: 'Hearts’ tile.' },
  { name: 'lilac', label: 'Lilac', for: 'Spades’ tile; a person’s felt.' },
  { name: 'peach', label: 'Peach', for: 'Tanks’ tile; a person’s felt.' },
  { name: 'blush', label: 'Blush', for: 'Three Thirteen’s tile; a person’s felt.' },
  { name: 'kraft', label: 'Kraft', for: 'Mahjong’s tile, sheet headers and the strips between the menu’s parts; a person’s felt.' },
  { name: 'grass', label: 'Grass', for: 'A player colour on the board (Tanks, Jigsaw) and Three Thirteen’s “All in melds”. Never a person’s felt: it vanishes into the green table.' },
  { name: 'sage', label: 'Sage', for: 'Tried for the Jigsaw table. Named in felt.css, but not used and not on DESIGN.md’s list.' },
];

const HEIGHTS = [
  { name: 'Laid down', shadow: 'var(--laid)', token: '--laid', for: 'Felt that isn’t a button: name tags, taken seats, chips, messages, strips.' },
  { name: 'Pressed', shadow: 'var(--lift-0)', token: '--lift-0', for: 'A button while it’s being pressed.' },
  { name: 'Resting', shadow: 'var(--lift-1)', token: '--lift-1', for: 'Buttons, cards, tiles.' },
  { name: 'Lifted', shadow: 'var(--lift-2)', token: '--lift-2', for: 'The thing you picked; pointed at on a computer.' },
  { name: 'Held', shadow: 'var(--lift-3)', token: '--lift-3', for: 'A card you’re dragging; sheets and pop-up panels.' },
];

const felt = (name: string) => `--fc: var(--${name}); background: var(--${name}) var(--${name}-img) 0 0 / var(--paper-size)`;
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function swatchHtml(c: (typeof COLOURS)[number]) {
  return `<div class="ds-swatch"><div class="ds-felt" style="${felt(c.name)}"></div><div class="ds-swatch-cap"><b>${c.label}</b><span class="ds-code">--${c.name} · ${cssVar(`--${c.name}`)}</span><span>${c.for}</span></div></div>`;
}

function heightsHtml(stage: string) {
  const blocks = HEIGHTS.map((h) => `<div class="ds-piece"><div class="ds-block" style="border-radius: var(--corner-m); box-shadow: ${h.shadow}">${h.name}</div></div>`).join('');
  return `<div class="ds-stage ${stage} ds-heights"><div class="ds-pieces">${blocks}<div class="ds-piece"><div class="ds-block pc-input">Cut in</div></div></div></div>`;
}

function specHtml(s: Spec, i: number) {
  return `<div class="ds-spec${s.wide ? ' is-wide' : ''}" data-spec="${i}">
    <div class="ds-stage ${s.stage}"${s.style ? ` style="${s.style}"` : ''}>${s.html}</div>
    <div class="ds-cap"><span class="ds-cap-title">${s.title}</span>${s.about ? `<span>${s.about}</span>` : ''}<span class="ds-from${s.copied ? ' is-copied' : ''}">${s.from}</span><div class="ds-readout"></div></div>
  </div>`;
}

const ALL_SPECS = GROUPS.flatMap((g) => g.specs);

function pageHtml() {
  const typeRow = (t: { token: string; name: string; for: string; sample: string }, extra = '') => `<li>
      <div class="ds-type-meta"><b>${t.name}</b><span class="ds-code">${t.token}</span><span><b data-px="${t.token}"></b> px here${extra}</span><span>${t.for}</span></div>
      <div class="ds-type-sample" style="font-size: var(${t.token})"><span style="font-weight: 400">${t.sample}</span><span style="font-weight: 800">${t.sample}</span></div>
    </li>`;
  const cornerPiece = (c: (typeof CORNERS)[number], w: number, h: number) =>
    `<div class="ds-piece"><div class="ds-block" style="width:${w}px;height:${h}px;border-radius: var(${c.token})"></div><span><b>${c.name}</b> <span class="ds-code">${c.token}</span></span><span><b data-corner="${c.token}"></b> px · ${c.for}</span></div>`;
  let i = 0;
  const groups = GROUPS.map(
    (g) => `<h3 class="ds-h3">${g.title}</h3>${g.intro ? `<p class="ds-p">${g.intro}</p>` : ''}<div class="ds-specs">${g.specs.map((s) => specHtml(s, i++)).join('')}</div>`,
  ).join('');
  return `<main class="ds-page"><div id="game" class="game chat-collapsed ds-game"><div class="ds-wrap">
    <header>
      <h1 class="ds-h1">Felt design</h1>
      <p class="ds-p">Everything the site is made of, in one place: the named values agreed in DESIGN.md, and every shared piece in every state it has. It’s drawn with the site’s own stylesheets, so what you see is what the site shows.</p>
      <p class="ds-p">Beside each piece is what it measures as built: the size of its words and its corner, in pixels. A size that isn’t on DESIGN.md’s lists has a wavy tomato line under it, with the nearest one on the list. Many pieces are off the lists today; they move onto them area by area.</p>
      <div class="ds-count" aria-live="polite"><span><b id="ds-count">Measuring…</b></span><span class="ds-small">A piece is on the lists when every text size and corner it has is one of DESIGN.md’s. Cards, dominoes and Mahjong tiles aren’t counted. Measured at this window’s width: a phone shows phone sizes.</span></div>
      <p class="ds-p ds-small">Only on the dev server; the site that goes out doesn’t include this page. Pressed, pointed-at and focused looks are the site’s own rules for them, copied onto a class, since a page can’t hold a button down.</p>
      <ul class="ds-nav"><li><a class="ds-link" href="#colours">Colours</a></li><li><a class="ds-link" href="#text">Text</a></li><li><a class="ds-link" href="#corners">Corners</a></li><li><a class="ds-link" href="#heights">Heights and the shadow</a></li><li><a class="ds-link" href="#pieces">Shared pieces</a></li></ul>
    </header>

    <section id="colours">
      <h2 class="ds-h2">Colours</h2>
      <p class="ds-p">Each colour is a sheet of felt (public/art/felt/) and a name in felt.css. Pieces use the name, never the number. The three signal colours mean one thing each, so nobody has to guess.</p>
      <h3 class="ds-h3">Signal colours</h3>
      <div class="ds-swatches is-signals">${COLOURS.filter((c) => c.signal).map(swatchHtml).join('')}</div>
      <h3 class="ds-h3">The other felts</h3>
      <div class="ds-swatches">${COLOURS.filter((c) => !c.signal).map(swatchHtml).join('')}</div>
      <h3 class="ds-h3">Words and card stock</h3>
      <div class="ds-swatches">
        <div class="ds-swatch"><div class="ds-felt" style="${felt('paper')}; display:grid; place-items:center; color: var(--ink); font-size: var(--type-head); font-weight: 800">Aa</div><div class="ds-swatch-cap"><b>Ink</b><span class="ds-code">--ink · ${cssVar('--ink')}</span><span>Words. On a green or grey table, words are near-white instead.</span></div></div>
        <div class="ds-swatch"><div class="ds-felt" style="${felt('paper')}; display:grid; place-items:center; color: var(--ink-soft); font-size: var(--type-head); font-weight: 400">Aa</div><div class="ds-swatch-cap"><b>Soft ink</b><span class="ds-code">--ink-soft · ${cssVar('--ink-soft')}</span><span>Small words under a name, on cream or white only. On deeper felt, full ink.</span></div></div>
        <div class="ds-swatch"><div class="ds-felt" style="--fc: var(--card); background: var(--card) var(--card-img) 0 0 / 120% auto"></div><div class="ds-swatch-cap"><b>Card stock</b><span class="ds-code">--card · ${cssVar('--card')}</span><span>Playing cards.</span></div></div>
      </div>
    </section>

    <section id="text">
      <h2 class="ds-h2">Text</h2>
      <p class="ds-p">One font, Atkinson Hyperlegible Next: 400 for text, 800 for headings, buttons and names. Five sizes, the same on every device apart from a page’s heading, and one headline that grows with the screen. They’re set in rem, so the pixel sizes follow this browser’s own text size setting (15, 16, 18, 22 and 28 at the default). Nothing is smaller than Note.</p>
      <ul class="ds-type">${TEXT_SIZES.map((t) => typeRow(t)).join('')}${typeRow(HEADLINE, ' (it grows with the window: 32 to 72 px at the default)')}</ul>
    </section>

    <section id="corners">
      <h2 class="ds-h2">Corners</h2>
      <p class="ds-p">Three corners, so pieces of a kind are cut alike, and fully round for dots and pills. A tab hanging from an edge is rounded on its free side only. Cards, dominoes and Mahjong tiles keep a corner that’s a share of their own width, so it grows and shrinks with them.</p>
      <div class="ds-stage paper-paper"><div class="ds-pieces">
        ${cornerPiece(CORNERS[0], 84, 40)}${cornerPiece(CORNERS[1], 168, 52)}${cornerPiece(CORNERS[2], 200, 110)}
        <div class="ds-piece"><div class="ds-row"><div class="ds-block" style="width:150px;height:44px;border-radius: var(--corner-round)"></div><div class="ds-block ds-dot" style="border-radius: var(--corner-round)"></div></div><span><b>Round</b> <span class="ds-code">--corner-round</span></span><span>Dots and pills</span></div>
        <div class="ds-piece"><div class="ds-block" style="width:84px;height:52px;border-radius: 0 0 var(--corner-l) var(--corner-l)"></div><span><b>A tab</b></span><span>Large, on its free side only</span></div>
      </div></div>
    </section>

    <section id="heights">
      <h2 class="ds-h2">Heights and the shadow</h2>
      <p class="ds-p">Light comes from above, so shadows fall downward. A piece sits at one of five heights; only buttons stand up off the table, so you can tell what to tap. Boxes you type into are cut into the felt instead, so their shadow falls inside.</p>
      <ul class="ds-p ds-small">${HEIGHTS.map((h) => `<li><b>${h.name}</b> (<span class="ds-code">${h.token}</span>): ${h.for}</li>`).join('')}<li><b>Cut in</b> (<span class="ds-code">--cut-in</span>): boxes you type into.</li></ul>
      <h3 class="ds-h3">On cream felt</h3>
      ${heightsHtml('paper-paper')}
      <h3 class="ds-h3">On the green card table</h3>
      ${heightsHtml('ds-baize')}
      <h3 class="ds-h3">The one shadow colour</h3>
      <p class="ds-p">Every shadow, shaded edge and dimmed table is shade, a warm dark measured from the user’s felt, at whatever strength it needs.</p>
      <div class="ds-shade">
        <div><div class="ds-felt" style="background: rgb(var(--shade))"></div><span class="ds-small"><b>Shade</b> <span class="ds-code">--shade · rgb(${cssVar('--shade')})</span></span></div>
        <div><div class="ds-felt" style="${felt('baize')}; position: relative; overflow: hidden"><div style="position:absolute; inset:0; background: rgb(var(--shade) / 0.4)"></div></div><span class="ds-small">The table dimmed behind a sheet: shade at 40%.</span></div>
      </div>
    </section>

    <section id="pieces">
      <h2 class="ds-h2">Shared pieces</h2>
      <p class="ds-p">Each piece with the classes and markup the site really uses. Under each: where it comes from, and what it measures. Where its markup lives only inside one screen’s code, it’s copied here and says so in ink: those aren’t shared pieces yet, and a copy can fall behind the real thing. Buttons and boxes are shown as on the way in (home, Start a table), the rest as at a table: a piece that doesn’t set its own text size takes the size of where it is.</p>
      ${groups}
    </section>
  </div></div></main>`;
}

// ------------------------------------------------------------------ measuring the page

let pageResults: Measured[] = [];
let phoneResults: Measured[] = [];

function showCount() {
  const all = [...pageResults, ...phoneResults].filter(counted);
  const on = all.filter(isOn).length;
  document.getElementById('ds-count')!.textContent = `${on} of ${all.length} pieces on the lists`;
}

function measurePage() {
  const lists = readLists();
  for (const el of document.querySelectorAll<HTMLElement>('[data-px]')) el.textContent = fmt(round1(parseFloat(getComputedStyle(el.closest('li')!.querySelector('.ds-type-sample')!).fontSize)));
  for (const el of document.querySelectorAll<HTMLElement>('[data-corner]')) el.textContent = fmt(lists.corner[CORNERS.findIndex((k) => k.token === el.dataset.corner)].px);
  pageResults = [];
  ALL_SPECS.forEach((s, i) => {
    if (s === PHONE_SPEC) return;
    const spec = document.querySelector<HTMLElement>(`[data-spec="${i}"]`)!;
    const stage = spec.querySelector<HTMLElement>('.ds-stage')!;
    s.after?.(stage);
    const results = s.parts.map((p) => measure(stage, p, lists));
    pageResults.push(...results);
    spec.querySelector('.ds-readout')!.innerHTML = results.map(partHtml).join('');
  });
  showCount();
}

function showPhone() {
  const i = ALL_SPECS.indexOf(PHONE_SPEC);
  const box = document.querySelector<HTMLElement>(`[data-spec="${i}"] .ds-readout`);
  if (box) box.innerHTML = phoneResults.map(partHtml).join('');
  showCount();
}

const fontsReady = async () => {
  await Promise.all([document.fonts.load('400 16px "Atkinson Hyperlegible Next"'), document.fonts.load('800 16px "Atkinson Hyperlegible Next"')]);
  await document.fonts.ready;
};

function onResize(run: () => void) {
  let t = 0;
  addEventListener('resize', () => {
    clearTimeout(t);
    t = window.setTimeout(run, 150);
  });
}

async function buildPage() {
  addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== location.origin || e.data?.ds !== 'phone') return;
    phoneResults = e.data.parts as Measured[];
    showPhone();
  });
  copyAllStates();
  document.body.insertAdjacentHTML('beforeend', pageHtml());
  await fontsReady();
  measurePage();
  onResize(measurePage);
}

// ------------------------------------------------------------------ the phone (?frame=phone)

// The card table, copied from heartsView.ts; the bar, from index.html.
const PHONE_HTML = `<div id="game" class="game phone chat-collapsed" data-view="hearts"><div class="arena">
  <div class="view hearts-view">
    <div class="ht" data-phase="playing">
      <div class="ht-seat ht-pos-2"></div>
      <div class="ht-seat ht-pos-1"></div>
      <div class="ht-seat ht-pos-3"></div>
      <div class="ht-center">
        <div class="ht-trick">
          <div class="ht-slot ht-slot-0"></div><div class="ht-slot ht-slot-1"></div><div class="ht-slot ht-slot-2"></div><div class="ht-slot ht-slot-3"></div>
        </div>
        <div class="ht-status" aria-live="polite">Your turn: tap a card</div>
      </div>
      <div class="ht-mine"><div class="ht-seat ht-pos-0"></div><button class="ht-scores-btn pc-btn pc-btn-plain" type="button">Scores</button></div>
      <div class="ht-hand"></div>
    </div>
  </div>
  ${barHtml('Unmute mic')}
</div></div>`;

const PHONE_SEATS = [
  { pos: 0, name: 'Jesse', felt: 'sky', score: '12 pts', cls: 'turn speaking' },
  { pos: 1, name: 'Wendy Woodworth', felt: 'lilac', score: '20 pts', cls: '' },
  { pos: 2, name: 'Robo-Bob', felt: 'mint', score: '8 pts', cls: '', bot: true },
  { pos: 3, name: 'Liz', felt: 'peach', score: '31 pts', cls: '', away: true },
];

const PHONE_PARTS: Part[] = [
  { label: 'Your tag (your turn, talking)', sel: '.ht-pos-0', text: [['Name', '.ht-nm'], ['Points', '.ht-score']], corner: '' },
  { label: 'On your left, turned on its side (a 15-letter name)', sel: '.ht-pos-1', text: [['Name', '.ht-nm'], ['Points', '.ht-score']], corner: '' },
  { label: 'Across, along the top (a computer player)', sel: '.ht-pos-2', text: [['Name', '.ht-nm'], ['Points', '.ht-score']], corner: '' },
  { label: 'On your right, turned on its side (away)', sel: '.ht-pos-3', text: [['Name', '.ht-nm'], ['Points', '.ht-score']], corner: '' },
  { label: 'Scores', sel: '.ht-scores-btn', text: [['Words', '']], corner: '' },
  { label: 'The line over the game', sel: '.ht-status', text: [['Words', '']] },
  { label: 'Mic tab, muted', sel: '#btn-mic', text: [['Words', '']], corner: '' },
  { label: 'Messages and menu tabs', sel: '.bar-tab', corner: '' },
  { label: 'Cards in the middle', sel: '.ht-trick .card', corner: '', skip: CARD_SKIP },
];

async function buildPhone() {
  document.body.insertAdjacentHTML('beforeend', PHONE_HTML);
  const root = document.querySelector<HTMLElement>('.hearts-view')!;
  for (const s of PHONE_SEATS) {
    const el = root.querySelector<HTMLElement>(`.ht-pos-${s.pos}`)!;
    el.innerHTML = `${seatNameHtml(s.name, { bot: s.bot, away: s.away })}<div class="ht-score">${s.score}</div>`;
    el.dataset.felt = s.felt;
    if (s.cls) el.classList.add(...s.cls.split(' '));
  }
  showTrick(
    root,
    [
      { seat: 1, card: 'QS' },
      { seat: 2, card: 'TH' },
      { seat: 3, card: '7H' },
    ],
    null,
    (seat) => seat,
  );
  await fontsReady();
  const send = () => {
    fitSeatText(root);
    const lists = readLists();
    parent.postMessage({ ds: 'phone', parts: PHONE_PARTS.map((p) => measure(document, p, lists)) }, location.origin);
  };
  send();
  onResize(send);
}

void (isFrame ? buildPhone() : buildPage());
