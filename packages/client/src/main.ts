import './styles.css';
import './room.css';
import {
  canPlayPrivately,
  canPlayPublicly,
  cleanName,
  gameForPath,
  GAMES,
  isRoomCode,
  normalizeRoomCode,
  randomName,
  ROOM_CODE_LENGTH,
  type GameInfo,
  type RoomRequest,
  type ServerMessage,
} from '@tank/shared';
import { RoomApp } from './shell';
import type { Device } from './views';
import { Sfx } from './audio';
import { Gamepads, moveFocus, watchPadMode } from './gamepad';
import { Net } from './net';
import { escapeHtml } from './state';
import { loadSprites, type Sprites } from './sprites';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const NAME_KEY = 'tank.name';
const spritesReady: Promise<Sprites> = loadSprites();
const sfx = new Sfx();

function detectDevice(): Device {
  const touch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const small = touch && Math.min(window.innerWidth, window.innerHeight) < 600;
  return { touch, small };
}

function storedName() {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

/** Invite links look like /r/BCDFG. */
function inviteCode(): string | null {
  const m = location.pathname.match(/^\/r\/([A-Za-z]+)\/?$/);
  const code = m ? normalizeRoomCode(m[1]) : '';
  return isRoomCode(code) ? code : null;
}

const nameInput = $<HTMLInputElement>('name-input');
nameInput.value = storedName() || randomName();
$('name-dice').addEventListener('click', () => {
  let n = randomName();
  while (n === nameInput.value) n = randomName();
  nameInput.value = n;
});

// ------------------------------------------------------------------ pages

/** Big two-line logos for games with long names. */
const LOGOS: Record<string, string> = { tanks: 'Tank You<br><span>For Being A Friend</span>' };

/** The sign on games that are still being finished. */
const UNDER_CONSTRUCTION = '<span class="uc-chip">🚧 Under construction</span>';

/** The game whose page is showing, or null on the home page. */
let pageGame: GameInfo | null = null;

function renderGameList() {
  let html = '';
  for (const g of GAMES) {
    if (!canPlayPrivately(g.id)) continue;
    const pub = canPlayPublicly(g.id);
    html += `<div class="game-tile">
      <a class="gt-main" href="/${g.slug}" data-nav="/${g.slug}">
        <span class="gt-icon" aria-hidden="true">${g.icon}</span>
        <span class="gt-text"><b>${escapeHtml(g.name)}</b>${g.underConstruction ? UNDER_CONSTRUCTION : ''}<small>${escapeHtml(g.blurb)}</small></span>
      </a>
      ${pub ? `<button class="btn btn-primary gt-play" type="button" data-play="${g.id}">Play</button>` : '<span class="gt-tag">Private rooms</span>'}
    </div>`;
  }
  $('game-list').innerHTML = html;
}

/** Show the home page or a game's page for the current address. */
function showPage() {
  const game = gameForPath(location.pathname);
  // Old and alternative addresses settle on the game's main one (e.g. /tankyouforbeingafriend).
  if (game && location.pathname !== `/${game.slug}`) history.replaceState(null, '', `/${game.slug}${location.search}`);
  if (!game && !inviteCode() && location.pathname !== '/') history.replaceState(null, '', `/${location.search}`);
  pageGame = game;
  // Arrived on an invite link: joining that room comes first.
  const invite = inviteCode();
  $('invite-panel').hidden = !invite;
  $('invite-code').textContent = invite ?? '';
  const create = $('create-private');
  create.textContent = invite ? 'Start my own room instead' : 'Start a private room';
  create.classList.toggle('btn-primary', !invite);
  create.classList.toggle('btn-big', !invite);
  create.classList.toggle('btn-secondary', !!invite);
  $('home-head').hidden = !!game;
  $('home-actions').hidden = !!game;
  $('game-head').hidden = !game;
  $('game-actions').hidden = !game;
  showError(null);
  if (!game) {
    document.title = 'Games Drawer';
    renderGameList();
    return;
  }
  document.title = `${game.title} · Games Drawer`;
  // The catalog's icons are our own (an emoji, or Dominoes' drawn tile), never player text.
  $('gp-icon').innerHTML = game.icon;
  $('gp-title').innerHTML = LOGOS[game.id] ?? escapeHtml(game.title);
  $('gp-tagline').textContent = game.tagline;
  $('gp-construction').hidden = !game.underConstruction;
  const pub = canPlayPublicly(game.id);
  $('play-public').hidden = !pub;
  $('play-friends').classList.toggle('btn-primary', !pub);
  $('play-friends').classList.toggle('btn-big', !pub);
  $('play-friends').classList.toggle('btn-secondary', pub);
  $('gp-hint').textContent = pub
    ? 'Play now joins a game with anyone who’s on. Play with friends opens your own room with chat, voice and an invite link.'
    : 'Opens your own room with chat, voice and an invite link.';
  $('gp-howto').innerHTML = game.howTo.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
  $('gp-players').textContent = game.players;
}

function navigate(path: string) {
  if (path !== location.pathname) history.pushState(null, '', path);
  showPage();
  window.scrollTo(0, 0);
}

$('landing').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const play = t.closest<HTMLElement>('[data-play]')?.dataset.play;
  if (play) {
    const game = GAMES.find((g) => g.id === play);
    if (game) start({ kind: 'public', game: game.id }, $('game-list'));
    return;
  }
  const link = t.closest<HTMLAnchorElement>('a[data-nav]');
  if (link) {
    e.preventDefault();
    navigate(link.dataset.nav!);
  }
});
window.addEventListener('popstate', () => {
  if (!app) showPage();
});

const gameButtons = () => $('game-actions').querySelector<HTMLElement>('.actions')!;
const homeButtons = () => $('home-actions').querySelector<HTMLElement>('.actions')!;

$('join-invite').addEventListener('click', () => {
  const code = inviteCode();
  if (code) start({ kind: 'private', code }, $('invite-panel'));
});

$('play-public').addEventListener('click', () => pageGame && start({ kind: 'public', game: pageGame.id }, gameButtons()));
$('play-friends').addEventListener('click', () => pageGame && start({ kind: 'create-private', game: pageGame.id }, gameButtons()));
$('create-private').addEventListener('click', () => start({ kind: 'create-private' }, homeButtons()));
$('code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = $('code-form');
  const c = normalizeRoomCode($<HTMLInputElement>('code-input').value);
  if (!isRoomCode(c)) {
    showError(`Room codes are ${ROOM_CODE_LENGTH} letters.`, form);
    return;
  }
  start({ kind: 'private', code: c }, form);
});
// Fixing the code clears the complaint about it.
$('code-input').addEventListener('input', () => showError(null));

/**
 * Where a problem is shown: right under what you tapped (the bottom of the page is off the
 * screen on a phone, so a message there looks like nothing happened).
 */
let errorAnchor: HTMLElement | null = null;
let pendingTimer = 0;

/** Put the message line under `anchor` (or what was tapped last), and show it. */
function placeNotice(text: string, kind: 'error' | 'pending', anchor?: HTMLElement) {
  const el = $('landing-error');
  const at = anchor ?? errorAnchor ?? (inviteCode() ? $('invite-panel') : pageGame ? gameButtons() : homeButtons());
  // Moving it would replay its opening animation: only when it's somewhere else.
  const moved = el.previousElementSibling !== at;
  if (moved) at.after(el);
  const before = el.hidden || moved ? 0 : el.offsetHeight;
  el.classList.toggle('pending', kind === 'pending');
  el.classList.remove('retrying');
  el.textContent = text;
  el.hidden = false;
  // A longer message (two lines on a phone) grows smoothly instead of jolting the page.
  const after = el.offsetHeight;
  if (before && after !== before) el.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: 200, easing: 'ease-out' });
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

/**
 * While joining: "Joining room ABCDE…" in the same spot the answer will appear (so nothing jumps).
 * It waits a moment first, since most answers are quicker than that; meanwhile an old complaint
 * fades back, as it's being tried again.
 */
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
 * The room this tab is in. If the page reloads (or a phone discards the tab while
 * you switch apps) we go straight back in and reclaim your place.
 */
const ACTIVE_KEY = 'tank.active';
function setActive(room: RoomRequest | null) {
  try {
    if (room) sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(room));
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}
function getActive(): RoomRequest | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    return raw ? (JSON.parse(raw) as RoomRequest) : null;
  } catch {
    return null;
  }
}

/** Join or open a room. `from` is what was tapped: if it doesn't work out, the reason shows there. */
async function start(room: RoomRequest, from?: HTMLElement) {
  // Called from a button tap, so audio is allowed to start (required on iPhone).
  sfx.unlock();
  errorAnchor = from ?? null;
  showPending(
    room.kind === 'private' ? `Joining room ${room.code}…` : room.kind === 'create-private' ? 'Opening your room…' : 'Finding a game…',
  );
  setBusy(true);
  const name = cleanName(nameInput.value) || randomName();
  nameInput.value = name;
  saveName(name);
  const sprites = await spritesReady;
  const device = detectDevice();
  net?.close();
  const thisNet = new Net(room, () => storedName() || name, device.touch ? 'phone' : 'desktop', {
    onMessage: (msg: ServerMessage) => {
      if (msg.t === 'welcome' && !app) {
        setActive(msg.room.kind === 'private' ? { kind: 'private', code: msg.room.code } : { kind: 'public', game: msg.game ?? 'tanks' });
        enterGame();
        app = new RoomApp(msg, thisNet, sprites, sfx, device, leave, pads);
        if (import.meta.env.DEV) (window as unknown as { __tank: RoomApp }).__tank = app;
        return;
      }
      app?.onMessage(msg);
    },
    onFatal: (err) => {
      if (app) leave();
      setActive(null);
      setBusy(false);
      showError(err.message);
    },
    onReconnecting: () => {
      if (app) app.showReconnecting();
      else {
        thisNet.close();
        setBusy(false);
        showError("Couldn't reach the game server. Is it running?");
      }
    },
  });
  net = thisNet;
  thisNet.connect();
}

// ------------------------------------------------------------------ controllers

/**
 * One reader for every controller. In a room the room handles it; on the home page and game
 * pages the d-pad moves between buttons, A presses, and B goes back to all games.
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
    } else if (b === 'b' && pageGame) navigate('/');
  },
  release: (b) => app?.onPadRelease(b),
  connected: () => app?.toast('Controller connected. Menu opens the menu; the d-pad and A get around.'),
});
watchPadMode();

// iOS Safari ignores user-scalable=no; block pinch-zoom so the game never zooms by accident.
for (const ev of ['gesturestart', 'gesturechange'] as const) document.addEventListener(ev, (e) => e.preventDefault());

showPage();
const resume = getActive();
if (resume) start(resume);

function enterGame() {
  showError(null);
  $('landing').hidden = true;
  $('game').hidden = false;
  setBusy(false);
}

/** Back out of a room: to the game's page after a public game, home after a private room. */
function leave() {
  setActive(null);
  app?.dispose();
  app = null;
  net?.close();
  net = null;
  $('game').hidden = true;
  $('landing').hidden = false;
  // A private room's address is its invite link; once you've left, go home instead.
  if (inviteCode()) history.replaceState(null, '', `/${location.search}`);
  showPage();
}
