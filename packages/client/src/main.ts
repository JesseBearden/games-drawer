import './styles.css';
import './room.css';
import { cleanName, isRoomCode, normalizeRoomCode, randomName, ROOM_CODE_LENGTH, type RoomRequest, type ServerMessage } from '@tank/shared';
import { RoomApp } from './shell';
import type { Device } from './views';
import { Sfx } from './audio';
import { Net } from './net';
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

const code = inviteCode();
if (code) {
  $('invite-panel').hidden = false;
  $('invite-code').textContent = code;
  $('play-public').textContent = 'Play public instead';
  $('play-public').classList.replace('btn-primary', 'btn-secondary');
  $('play-public').classList.remove('btn-big');
  $('join-invite').addEventListener('click', () => start({ kind: 'private', code }));
}

$('play-public').addEventListener('click', () => start({ kind: 'public' }));
$('create-private').addEventListener('click', () => start({ kind: 'create-private' }));
$('code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = normalizeRoomCode($<HTMLInputElement>('code-input').value);
  if (!isRoomCode(c)) {
    showError(`Room codes are ${ROOM_CODE_LENGTH} letters.`);
    return;
  }
  start({ kind: 'private', code: c });
});

function showError(msg: string | null) {
  const el = $('landing-error');
  el.hidden = !msg;
  el.textContent = msg ?? '';
}

function setBusy(busy: boolean) {
  for (const id of ['play-public', 'create-private', 'join-invite']) ($<HTMLButtonElement>(id)).disabled = busy;
}

let app: RoomApp | null = null;
let net: Net | null = null;

/**
 * The room this tab is in. If the page reloads (or a phone discards the tab while
 * you switch apps) we go straight back in and reclaim the tank.
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

async function start(room: RoomRequest) {
  // Called from a button tap, so audio is allowed to start (required on iPhone).
  sfx.unlock();
  showError(null);
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
        setActive(msg.room.kind === 'private' ? { kind: 'private', code: msg.room.code } : { kind: 'public' });
        enterGame();
        app = new RoomApp(msg, thisNet, sprites, sfx, device, leave);
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

// iOS Safari ignores user-scalable=no; block pinch-zoom so the game never zooms by accident.
for (const ev of ['gesturestart', 'gesturechange'] as const) document.addEventListener(ev, (e) => e.preventDefault());

const resume = getActive();
if (resume) start(resume);

function enterGame() {
  $('landing').hidden = true;
  $('game').hidden = false;
  setBusy(false);
}

function leave() {
  setActive(null);
  app?.dispose();
  app = null;
  net?.close();
  net = null;
  $('game').hidden = true;
  $('landing').hidden = false;
  if (location.pathname !== '/' && !inviteCode()) history.replaceState(null, '', '/' + location.search);
}
