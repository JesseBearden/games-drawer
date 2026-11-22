// The fonts are served from the site itself (not Google Fonts), so visitors' addresses go to no
// one else. Both are under the SIL Open Font License (public/licenses/, CREDITS.md).
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
import {
  canPlayPrivately,
  cleanName,
  gameForPath,
  gameInfo,
  isGameId,
  isInviteToken,
  isRoomCode,
  MAX_NAME_LENGTH,
  normalizeRoomCode,
  randomName,
  ROOM_CODE_LENGTH,
  slotOfCode,
  type GameId,
  type RoomRequest,
  type ServerMessage,
  type TableInfo,
} from '@tank/shared';
import { RoomApp, type EntryChoice } from './shell';
import type { Device } from './views';
import { Sfx } from './audio';
import { Gamepads, moveFocus, watchPadMode } from './gamepad';
import { reloadForUpdate } from './reload';
import { Net } from './net';
import { escapeHtml } from './html';
import { MIC_CONSTRAINTS, voiceSupported } from './voice';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const NAME_KEY = 'tank.name';
const sfx = new Sfx();

function detectDevice(): Device {
  const touch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const small = touch && Math.min(window.innerWidth, window.innerHeight) < 600;
  return { touch, small };
}

function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: just not remembered */
  }
}

// ------------------------------------------------------------------ the pages

/** Which page an address is: home, starting a table (maybe with a game picked), or joining one. */
type Page = { kind: 'home' } | { kind: 'start'; game: GameId | null } | { kind: 'join'; code: string; token: string | null } | { kind: 'privacy' } | { kind: 'rules' };

function pageFor(): Page {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  // Invite links look like /r/BCDFG, with ?i=<token> when they're from someone (and maybe for someone).
  const m = path.match(/^\/r\/([A-Za-z]+)\/?$/);
  if (m) {
    const code = normalizeRoomCode(m[1]);
    const token = params.get('i');
    if (isRoomCode(code)) return { kind: 'join', code, token: isInviteToken(token) ? token : null };
  }
  // What the site keeps, and the house rules (plain pages, linked under every way-in page).
  if (path === '/privacy') return { kind: 'privacy' };
  if (path === '/rules') return { kind: 'rules' };
  if (path === '/start') {
    const g = params.get('game');
    return { kind: 'start', game: isGameId(g) && canPlayPrivately(g) ? g : null };
  }
  // A game's own address (/jigsaw, /tanks…) starts a table with that game picked.
  const game = gameForPath(path);
  if (game && canPlayPrivately(game.id)) return { kind: 'start', game: game.id };
  return { kind: 'home' };
}

let page: Page = pageFor();


function showPage() {
  page = pageFor();
  // Old and unknown addresses settle on home; game addresses keep their name (/jigsaw).
  if (page.kind === 'home' && location.pathname !== '/') history.replaceState(null, '', '/');
  if (page.kind === 'start') {
    const g = gameForPath(location.pathname);
    if (g && location.pathname !== `/${g.slug}`) history.replaceState(null, '', `/${g.slug}`);
  }
  $('page-home').hidden = page.kind !== 'home';
  $('page-start').hidden = page.kind !== 'start';
  $('page-join').hidden = page.kind !== 'join';
  $('page-privacy').hidden = page.kind !== 'privacy';
  $('page-rules').hidden = page.kind !== 'rules';
  showError(null);
  nameEditing = false;
  if (page.kind === 'home') {
    document.title = 'Games Drawer';
  } else if (page.kind === 'start') {
    document.title = page.game ? `${gameInfo(page.game).name} · Games Drawer` : 'Start a table · Games Drawer';
    renderStartDetail(page.game);
    renderName('start');
  } else if (page.kind === 'privacy') {
    document.title = 'Privacy · Games Drawer';
  } else if (page.kind === 'rules') {
    document.title = 'House rules · Games Drawer';
  } else {
    document.title = 'Join a table · Games Drawer';
    void loadJoin(page);
  }
}

function navigate(path: string) {
  if (path !== location.pathname + location.search) history.pushState(null, '', path);
  showPage();
  $('landing').scrollTo(0, 0);
}

$('landing').addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-nav]');
  if (link) {
    e.preventDefault();
    navigate(link.dataset.nav!);
  }
});
window.addEventListener('popstate', () => {
  if (!app) showPage();
});

// ------------------------------------------------------------------ starting: what happens next

/** The game is picked at the table, together; a game's own page (/dominoes) picks it to begin with. */
function renderStartDetail(game: GameId | null) {
  $('start-detail').innerHTML = game
    ? `Your table opens with <b class="pc-nw">${escapeHtml(gameInfo(game).name)}</b> picked. Invite people, take your seats, and start when everyone’s ready.`
    : 'Your table opens first: invite people, pick a game together, and start when everyone’s ready.';
}

// ------------------------------------------------------------------ your name

const DICE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2.2"/><g fill="currentColor"><circle cx="8" cy="8" r="1.7"/><circle cx="16" cy="8" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="8" cy="16" r="1.7"/><circle cx="16" cy="16" r="1.7"/></g></svg>';

/** The name we'd use: the one remembered on this device, or the one an invite was made for. */
let suggestedName: string | null = stored(NAME_KEY);
let nameEditing = false;

/** A known name shows as a line with Change; otherwise a box (with a dice for a random one). */
function renderName(form: 'start' | 'join') {
  const box = document.querySelector<HTMLElement>(`[data-name-for="${form}"]`)!;
  const name = suggestedName;
  if (name && !nameEditing) {
    box.innerHTML = `<div class="pc-namerow"><b>Your name</b><span id="${form}-name-shown">${escapeHtml(name)}</span><button type="button" class="pc-link" data-name-act="change">Change</button></div>`;
    return;
  }
  box.innerHTML = `<div class="pc-field"><label for="${form}-name">Your name</label>
    <div class="entry-row">
      <input id="${form}-name" class="pc-input" name="name" maxlength="${MAX_NAME_LENGTH}" placeholder="First name, like Mike or Mike B" autocomplete="given-name" autocapitalize="words" spellcheck="false" value="${escapeHtml(name ?? '')}" />
      <button type="button" class="pc-btn pc-btn-plain entry-dice" data-name-act="dice" aria-label="Pick a random name" title="Pick a random name">${DICE_SVG}</button>
    </div></div>`;
}

document.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-name-act]');
  if (!act) return;
  const box = act.closest<HTMLElement>('[data-name-for]')!;
  const form = box.dataset.nameFor as 'start' | 'join';
  if (act.dataset.nameAct === 'change') {
    nameEditing = true;
    renderName(form);
    const input = $<HTMLInputElement>(`${form}-name`);
    input.focus();
    input.select();
  } else {
    const input = $<HTMLInputElement>(`${form}-name`);
    let n = randomName();
    while (n === input.value) n = randomName();
    input.value = n;
    showError(null);
  }
});

/** The name to join with, or null (with the box pointed out) when there isn't one yet. */
function chosenName(form: 'start' | 'join'): string | null {
  const input = document.getElementById(`${form}-name`) as HTMLInputElement | null;
  const name = cleanName(input ? input.value : (suggestedName ?? ''));
  if (!name) {
    showError('Type your name first, so everyone knows who you are.', document.querySelector<HTMLElement>(`[data-name-for="${form}"]`)!);
    input?.focus();
    return null;
  }
  if (input) input.value = name;
  suggestedName = name;
  store(NAME_KEY, name);
  return name;
}

// ------------------------------------------------------------------ home: a code

$('code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = normalizeRoomCode($<HTMLInputElement>('code-input').value);
  if (!isRoomCode(code)) {
    showError(`Table codes are ${ROOM_CODE_LENGTH} letters.`, $('code-form'));
    $('code-input').focus();
    return;
  }
  navigate(`/r/${code}`);
});
$('code-input').addEventListener('input', () => showError(null));

// ------------------------------------------------------------------ start a table

$('start-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = $<HTMLFormElement>('start-form');
  const name = chosenName('start');
  if (!name) return;
  const game = page.kind === 'start' ? page.game : null;
  const mic = (e as SubmitEvent).submitter?.getAttribute('value') !== 'off';
  start(game ? { kind: 'create-private', game } : { kind: 'create-private' }, { mic, name }, form);
});

// ------------------------------------------------------------------ join a table

/** "Jesse", "Jesse and Sam", "Jesse, Sam and Mory": each name in bold (escaped: names are typed by
 *  people), and never split across two lines. */
const namesHtml = (people: string[]) => {
  const b = people.map((n) => `<b class="pc-nw">${escapeHtml(n)}</b>`);
  return b.length <= 1 ? (b[0] ?? '') : `${b.slice(0, -1).join(', ')} and ${b.at(-1)}`;
};

/** How each game reads in "Join Jesse for …". */
const GAME_PHRASE: Record<GameId, string> = { jigsaw: 'a puzzle', dominoes: 'Dominoes', hearts: 'Hearts', spades: 'Spades', threethirteen: 'Three Thirteen', tanks: 'Tanks' };

/** The join page re-checks who's there this often, so someone arriving or leaving shows before you join. */
const JOIN_REFRESH_MS = 8000;
let joinTimer = 0;

/**
 * A table you can't join (closed, full, too many tries): no join buttons, and Back to home is
 * the page's one main button. (Not a page to optimise: it's rare.)
 */
function setJoinClosed(closed: boolean) {
  // With no form under it, the message is centred like home's (left-aligned, it looked lopsided).
  $('page-join').classList.toggle('is-closed', closed);
  // The page itself says what's wrong: no second, red note saying it again.
  if (closed) showError(null);
  const home = $('join-home');
  home.classList.toggle('pc-btn-main', closed);
  home.classList.toggle('pc-btn-big', closed);
  home.classList.toggle('pc-btn-wide', closed);
  home.classList.toggle('pc-btn-plain', !closed);
}

/** Open the join page: reset it, then look the table up. */
function loadJoin(p: Extract<Page, { kind: 'join' }>) {
  $('join-title').textContent = 'Join the table';
  $('join-detail').textContent = '';
  $('join-form').hidden = false;
  setJoinClosed(false);
  renderName('join');
  return refreshJoin(p, true);
}

/**
 * Look the table up (who's there, what they're playing, who invited you) and fill in the page.
 * Everyone at the table is named before you join, so you can choose not to.
 */
async function refreshJoin(p: Extract<Page, { kind: 'join' }>, first = false) {
  clearTimeout(joinTimer);
  const title = $('join-title');
  const detail = $('join-detail');
  const form = $('join-form');
  let info: TableInfo | null = null;
  try {
    const q = new URLSearchParams({ code: p.code, slot: slotOfCode(p.code) });
    if (p.token) q.set('i', p.token);
    const res = await fetch(`/api/table?${q}`, { cache: 'no-store' });
    if (res.ok) info = (await res.json()) as TableInfo;
  } catch {
    /* offline or an old server: the page still works, just without names */
  }
  // The address may have changed (or you joined) while we waited.
  const stillHere = () => !app && page.kind === 'join' && page.code === p.code;
  if (!stillHere()) return;
  const again = () => {
    joinTimer = window.setTimeout(() => {
      if (stillHere() && document.visibilityState === 'visible') void refreshJoin(p);
      else if (stillHere()) again();
    }, JOIN_REFRESH_MS);
  };
  if (!info) {
    again();
    return;
  }
  detail.hidden = false;
  if (!info.ok) {
    form.hidden = true;
    setJoinClosed(true);
    if (info.reason === 'busy') {
      title.textContent = 'Too many tries';
      detail.textContent = 'Wait a few minutes, then try the code again.';
    } else {
      title.textContent = 'This table has closed';
      detail.textContent = 'Ask whoever invited you for a new link, or start your own table.';
    }
    return;
  }
  const who = namesHtml(info.people);
  if (info.full) {
    form.hidden = true;
    setJoinClosed(true);
    title.textContent = 'This table is full';
    detail.innerHTML = `${who || 'Four people'} ${info.people.length === 1 ? 'is' : 'are'} already playing. Ask them to make room, or start your own table.`;
    again();
    return;
  }
  form.hidden = false;
  setJoinClosed(false);
  const game = info.game ? GAME_PHRASE[info.game] : null;
  const joinLine = who ? (game ? `Join ${who} for ${game}` : `Join ${who} at the table`) : '';
  if (joinLine && (!info.from || info.people.includes(info.from))) {
    // Whoever invited you is there: "Join Jesse and Sam for a puzzle" says it all.
    title.innerHTML = joinLine;
    detail.textContent = '';
  } else {
    // They've stepped away (or nobody's there): who invited you, then who's there.
    title.textContent = info.from ? `${info.from} invited you to play` : 'Join the table';
    detail.innerHTML = joinLine ? `${joinLine}.` : `Nobody is at the table right now${game ? `. It’s set up for ${game}` : ''}.`;
  }
  // People who dropped out still hold their seat and may come back: name them too.
  const away = (info.away ?? []).filter((n) => !info.people.includes(n));
  if (away.length) {
    const line = `${namesHtml(away)} stepped away and may come back.`;
    detail.innerHTML = detail.innerHTML ? `${detail.innerHTML} ${line}` : line;
  }
  detail.hidden = !detail.textContent;
  // An invite made for you by name fills it in, unless this device already knows yours.
  if (first && info.for && !stored(NAME_KEY)) {
    suggestedName = info.for;
    nameEditing = false;
    renderName('join');
  }
  again();
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (page.kind !== 'join') return;
  const name = chosenName('join');
  if (!name) return;
  const mic = (e as SubmitEvent).submitter?.getAttribute('value') !== 'off';
  start({ kind: 'private', code: page.code }, { mic, name }, $('join-form'));
});

// ------------------------------------------------------------------ notices

/**
 * Where a problem is shown: right under what you tapped (the bottom of the page is off the
 * screen on a phone, so a message there looks like nothing happened).
 */
let errorAnchor: HTMLElement | null = null;
let pendingTimer = 0;

function placeNotice(text: string, kind: 'error' | 'pending', anchor?: HTMLElement) {
  const el = $('landing-error');
  const at = anchor ?? errorAnchor ?? $(`page-${page.kind}`);
  if (el.previousElementSibling !== at) at.after(el);
  el.classList.toggle('pending', kind === 'pending');
  el.classList.remove('retrying');
  el.textContent = text;
  el.hidden = false;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showError(msg: string | null, anchor?: HTMLElement) {
  clearTimeout(pendingTimer);
  if (msg) return placeNotice(msg, 'error', anchor);
  const el = $('landing-error');
  el.hidden = true;
  el.textContent = '';
  el.classList.remove('pending', 'retrying');
}

/** "Joining…" where the answer will appear, after a moment (most answers are quicker). */
function showPending(text: string) {
  clearTimeout(pendingTimer);
  const el = $('landing-error');
  if (!el.hidden) el.classList.add('retrying');
  pendingTimer = window.setTimeout(() => placeNotice(text, 'pending'), 250);
}

function setBusy(busy: boolean) {
  for (const el of document.querySelectorAll<HTMLButtonElement>('#landing button')) el.disabled = busy;
}

// ------------------------------------------------------------------ playing

let app: RoomApp | null = null;
let net: Net | null = null;

/**
 * The table this tab is at, and whether the mic was on. If the page reloads (or a phone discards
 * the tab while you switch apps) we go straight back in and reclaim your place.
 */
const ACTIVE_KEY = 'tank.active';
interface Active {
  room: RoomRequest;
  mic: boolean;
}
function setActive(a: Active | null) {
  try {
    if (a) sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(a));
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}
function getActive(): Active | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    const a = raw ? (JSON.parse(raw) as Active | RoomRequest) : null;
    if (!a) return null;
    // Older tabs stored just the room.
    return 'kind' in a ? { room: a, mic: false } : a;
  } catch {
    return null;
  }
}

/** Ask for the mic straight from the tap, so the browser's question answers "with mic on". */
function requestMic(): Promise<MediaStream> | null {
  if (!voiceSupported()) return null;
  const p = navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  p.catch(() => {}); // handled when voice starts
  return p;
}

/** An audio context made during the tap, so iPhones and iPads let it play. */
function tapAudioContext(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor || !voiceSupported()) return null;
    const ctx = new Ctor();
    void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Join or open a table. `from` is what was tapped: if it doesn't work out, the reason shows there. */
async function start(room: RoomRequest, opts: { mic: boolean; name: string; resumed?: boolean }, from?: HTMLElement) {
  // Called from a button tap, so sound is allowed to start (required on iPhone).
  sfx.unlock();
  const entry: EntryChoice = {
    mic: opts.mic,
    resumed: !!opts.resumed,
    micStream: opts.mic && !opts.resumed ? requestMic() : null,
    audioCtx: opts.mic ? tapAudioContext() : null,
  };
  errorAnchor = from ?? null;
  showPending(room.kind === 'private' ? 'Joining the table…' : 'Setting up your table…');
  setBusy(true);
  const device = detectDevice();
  net?.close();
  const thisNet = new Net(room, () => stored(NAME_KEY) || opts.name, device.touch ? 'phone' : 'desktop', {
    onMessage: (msg: ServerMessage) => {
      if (msg.t === 'welcome' && !app) {
        setActive({ room: { kind: 'private', code: msg.room.code }, mic: opts.mic });
        enterGame();
        app = new RoomApp(msg, thisNet, sfx, device, leave, pads, entry);
        if (import.meta.env.DEV) (window as unknown as { __tank: RoomApp }).__tank = app;
        return;
      }
      app?.onMessage(msg);
    },
    onFatal: (err) => {
      if (err.code === 'version' && reloadForUpdate()) return;
      const wasIn = !!app;
      if (app) leave();
      dropEntry(entry);
      setActive(null);
      setBusy(false);
      const why = err.message.replace(/\broom\b/g, 'table');
      // Not getting in from a table's join page (it has closed, filled up, too many tries): look
      // again. If the page now says why itself ("This table has closed"), a red note saying it
      // twice is noise.
      if (!wasIn && page.kind === 'join') {
        void refreshJoin(page).then(() => {
          if (!$('page-join').classList.contains('is-closed')) showError(why);
        });
        return;
      }
      showError(why);
    },
    onReconnecting: () => {
      if (app) app.showReconnecting();
      else {
        thisNet.close();
        dropEntry(entry);
        setBusy(false);
        showError("Couldn't reach Games Drawer. Check your internet connection and try again.");
      }
    },
  });
  net = thisNet;
  thisNet.connect();
}

/** Didn't get in: let go of the mic and audio we opened for it. */
function dropEntry(entry: EntryChoice) {
  void entry.micStream?.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
  void entry.audioCtx?.close().catch(() => {});
}

// ------------------------------------------------------------------ controllers

/**
 * One reader for every controller. At a table the table handles it; on these pages the d-pad
 * moves between buttons, A presses, and B goes back home.
 */
const pads = new Gamepads({
  press: (p) => {
    if (app) return app.onPad(p);
    const landing = $('landing');
    const b = p.button;
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') moveFocus(landing, b);
    else if (b === 'a') {
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && landing.contains(el)) el.click();
      else moveFocus(landing, 'down');
    } else if (b === 'b' && page.kind !== 'home') navigate('/');
  },
  release: (b) => app?.onPadRelease(b),
  connected: () => app?.toast('Controller connected. Menu opens the menu; the d-pad and A get around.'),
});
watchPadMode();

// iOS Safari ignores user-scalable=no; block pinch-zoom so the game never zooms by accident.
for (const ev of ['gesturestart', 'gesturechange'] as const) document.addEventListener(ev, (e) => e.preventDefault());

/**
 * From the home screen icon on an iPhone, turning the phone shows or hides the status bar, and
 * the page can be left scrolled by the bar's height: everything sits too high, with an empty band
 * at the bottom (seen 2026-11-20). Nothing here scrolls the page itself (each screen scrolls in
 * its own box), so put it back once a turn has settled, and once the keyboard has gone away.
 * Never while you're typing: then the phone has moved the page to keep the box in sight.
 */
function unscrollPage() {
  const a = document.activeElement;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return;
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
}
const unscrollSoon = () => {
  for (const ms of [0, 250, 600, 1200]) window.setTimeout(unscrollPage, ms);
};
// (It still shows for a moment before it moves back: a small jump the user is happy to live with.)
matchMedia('(orientation: portrait)').addEventListener('change', unscrollSoon);
window.addEventListener('resize', unscrollSoon);
// The keyboard closing: focus leaves the box, and the visible part of the page grows again.
document.addEventListener('focusout', () => window.setTimeout(unscrollPage, 150));
window.visualViewport?.addEventListener('resize', unscrollSoon);

showPage();
const resume = getActive();
if (resume && resume.room.kind === 'private') start(resume.room, { mic: resume.mic, name: stored(NAME_KEY) || randomName(), resumed: true });

function enterGame() {
  showError(null);
  // Let go of the button that was pressed ("Start with mic on"): it's hidden now, and a
  // controller's next press should go to the game, not to wherever focus would move from there.
  (document.activeElement as HTMLElement | null)?.blur?.();
  $('landing').hidden = true;
  $('game').hidden = false;
  setBusy(false);
}

/** Leave the table and go home. */
function leave() {
  setActive(null);
  app?.dispose();
  app = null;
  net?.close();
  net = null;
  $('game').hidden = true;
  $('landing').hidden = false;
  history.replaceState(null, '', '/');
  showPage();
}
