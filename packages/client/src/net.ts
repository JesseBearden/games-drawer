import { PROTOCOL_VERSION, type ClientMessage, type Device, type RoomRequest, type ServerMessage } from '@tank/shared';

const SESSION_KEY = 'tank.session';

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

  constructor(
    room: RoomRequest,
    private name: () => string,
    private device: Device,
    private h: NetHandlers,
  ) {
    this.room = room;
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onVisible);
  }

  connect() {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'hello', v: PROTOCOL_VERSION, session: getSession(), name: this.name(), room: this.room, device: this.device });
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

  /** Drop and re-open the socket to get a fresh snapshot (used if terrain falls out of sync). */
  resync() {
    this.ws?.close();
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
