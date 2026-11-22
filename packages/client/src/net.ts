import { isSlot, PROTOCOL_VERSION, slotOfCode, type ClientMessage, type Device, type RoomRequest, type ServerMessage, type Slot } from '@tank/shared';

const SESSION_KEY = 'tank.session';
const DEVICE_KEY = 'gd.device';

/**
 * A random number this browser keeps for good (unlike the session, which is per tab), so the admin
 * page can count devices rather than tabs. It's sent when joining and logged only scrambled; it
 * says nothing about who you are (the privacy page explains it). Null if storage is off.
 */
function getDeviceId(): string | null {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[0-9a-f]{32}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * The session credential lets a player reclaim their tank after a disconnect. It lives in
 * sessionStorage, so each browser tab is its own player (handy for local multiplayer tests)
 * while a reload or app switch on a phone keeps the same identity.
 */
export function getSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function setSession(s: string) {
  try {
    sessionStorage.setItem(SESSION_KEY, s);
  } catch {
    /* private mode: reclaim only works while the socket lives */
  }
}

/**
 * Which copy of the server to reach (see Slot in the protocol). The room code decides once we know
 * it; before that, ?slot= on the page lets a deploy test the new copy directly. With no slot the
 * web server picks, which is how new rooms reach the newest copy.
 */
function slotFor(roomCode: string | null): Slot | null {
  if (roomCode) return slotOfCode(roomCode);
  try {
    const s = new URLSearchParams(location.search).get('slot');
    return isSlot(s) ? s : null;
  } catch {
    return null;
  }
}

export type FatalError = Extract<ServerMessage, { t: 'error' }>;

/**
 * At a table something arrives at least every couple of seconds (the shell pings every 2 s). This
 * long with nothing, while the page is showing, means the connection died quietly (Wi-Fi to
 * cellular, a router dropping it) even though the browser still calls it open: start again.
 * Generous, so a slow moment on the server doesn't turn into everyone reconnecting at once.
 */
const SILENT_MS = 15_000;
/**
 * A connection still being made after this long isn't going to be (a network that swallows it;
 * the browser's own limit can be minutes): "Joining the table…" gives up, and reconnecting tries afresh.
 */
const CONNECT_MS = 10_000;

export interface NetHandlers {
  onMessage(msg: ServerMessage): void;
  onFatal(err: FatalError): void;
  onReconnecting(): void;
}

/** One logical connection to a room, with automatic reconnect + reclaim. */
export class Net {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private retry = 0;
  private retryTimer: number | undefined;
  private watchdog: number;
  /** When the open socket last heard anything from the server. */
  private lastHeard = 0;
  private room: RoomRequest;
  /** The room's code once known (public rooms have one too), for reconnecting to the same copy. */
  private roomCode: string | null = null;

  constructor(
    room: RoomRequest,
    private name: () => string,
    private device: Device,
    private h: NetHandlers,
  ) {
    this.room = room;
    if (room.kind === 'private') this.roomCode = room.code;
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onVisible);
    this.watchdog = window.setInterval(this.checkAlive, 2000);
  }

  connect() {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const slot = slotFor(this.roomCode);
    const ws = new WebSocket(`${proto}://${location.host}/ws${slot ? `?slot=${slot}` : ''}`);
    this.ws = ws;
    this.lastHeard = Date.now();
    // Every socket must be welcomed on its own. An error before that (the table closed while the
    // phone slept, it filled up, too many tries) is final: trying again can't fix it, and each try
    // would count as a wrong table code against everyone on the same home internet.
    let welcomed = false;
    ws.onopen = () => {
      this.lastHeard = Date.now();
      const deviceId = getDeviceId();
      this.send({ t: 'hello', v: PROTOCOL_VERSION, session: getSession(), name: this.name(), room: this.room, device: this.device, batch: true, ...(deviceId && { deviceId }) });
    };
    const take = (msg: ServerMessage) => {
      if (msg.t === 'welcome') {
        welcomed = true;
        this.retry = 0;
        setSession(msg.session);
        // Reconnects go straight back to the same room.
        this.room = msg.room.kind === 'private' ? { kind: 'private', code: msg.room.code } : { kind: 'public' };
        this.roomCode = msg.room.code;
      }
      if (msg.t === 'error') {
        if (!welcomed || msg.code === 'replaced' || msg.code === 'version' || msg.code === 'room-closed') {
          this.closedByUs = true;
          // The server closes this socket itself. Let go of it now, so leaving doesn't say "leave"
          // on it (after "replaced", the server would take that as the new tab leaving).
          this.ws = null;
          ws.close();
          this.h.onFatal(msg);
          return;
        }
      }
      this.h.onMessage(msg);
    };
    ws.onmessage = (ev) => {
      // Let go of (left, cancelled, given up on): a welcome arriving late mustn't pull anyone in.
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      let frame: ServerMessage;
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (frame.t !== 'batch') return take(frame);
      // Several at once: exactly as if they'd come one after another.
      for (const msg of frame.msgs) if (this.ws === ws) take(msg);
    };
    ws.onclose = () => this.lost(ws);
  }

  /** This socket is gone (closed, or silent too long): reconnect after a short, growing wait. */
  private lost(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.ws = null;
    if (ws.readyState !== WebSocket.CLOSED) ws.close();
    if (this.closedByUs) return;
    this.h.onReconnecting();
    const delay = Math.min(5000, 300 * 2 ** this.retry++);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private checkAlive = () => {
    const ws = this.ws;
    if (!ws || document.visibilityState !== 'visible') return;
    const limit = ws.readyState === WebSocket.OPEN ? SILENT_MS : CONNECT_MS;
    if (Date.now() - this.lastHeard > limit) this.lost(ws);
  };

  private onVisible = () => {
    if (document.visibilityState !== 'visible' || this.closedByUs) return;
    // Pings pause while the page is hidden; give the connection a fresh window to answer.
    this.lastHeard = Date.now();
    if (!this.ws) {
      this.retry = 0;
      this.connect();
    }
  };

  send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
    if (this.ws) {
      this.send({ t: 'leave' });
      this.ws.close();
    }
    this.ws = null;
  }
}
