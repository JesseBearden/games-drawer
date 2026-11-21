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
  private connected = false;
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
  }

  connect() {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const slot = slotFor(this.roomCode);
    const ws = new WebSocket(`${proto}://${location.host}/ws${slot ? `?slot=${slot}` : ''}`);
    this.ws = ws;
    ws.onopen = () => {
      const deviceId = getDeviceId();
      this.send({ t: 'hello', v: PROTOCOL_VERSION, session: getSession(), name: this.name(), room: this.room, device: this.device, ...(deviceId && { deviceId }) });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.connected = true;
        this.retry = 0;
        setSession(msg.session);
        // Reconnects go straight back to the same room.
        this.room = msg.room.kind === 'private' ? { kind: 'private', code: msg.room.code } : { kind: 'public' };
        this.roomCode = msg.room.code;
      }
      if (msg.t === 'error') {
        if (msg.code === 'replaced' || msg.code === 'version' || msg.code === 'room-closed' || !this.connected) {
          this.closedByUs = true;
          this.h.onFatal(msg);
          return;
        }
      }
      this.h.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUs) return;
      this.h.onReconnecting();
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible' && !this.ws && !this.closedByUs) {
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
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
    if (this.ws) {
      this.send({ t: 'leave' });
      this.ws.close();
    }
    this.ws = null;
  }
}
