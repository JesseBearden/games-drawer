import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@tank/shared';

/** A stand-in browser WebSocket the test drives by hand. */
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: { t: string }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  // What the server does:
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.close();
  }
}

const welcome = { t: 'welcome', session: 's1', room: { kind: 'private', code: 'BCDFG' } };
const latest = () => FakeSocket.all.at(-1)!;

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

async function makeNet() {
  const { Net } = await import('../src/net');
  const seen = { fatal: [] as ServerMessage[], reconnecting: 0, messages: 0 };
  const net = new Net({ kind: 'private', code: 'BCDFG' }, () => 'Liz', 'phone', {
    onMessage: () => void seen.messages++,
    onFatal: (e) => void seen.fatal.push(e),
    onReconnecting: () => void seen.reconnecting++,
  });
  net.connect();
  latest().open();
  latest().receive(welcome);
  return { net, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  const doc = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal('document', doc);
  // Timers go through the (faked) global ones at call time.
  vi.stubGlobal('window', {
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (f: () => void, ms: number) => setInterval(f, ms),
    clearInterval: (id: number) => clearInterval(id),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.test', search: '' });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Net (the connection to a table)', () => {
  it('reconnects after a drop, and goes back to the same table', async () => {
    const { seen } = await makeNet();
    latest().drop();
    expect(seen.reconnecting).toBe(1);
    vi.advanceTimersByTime(400);
    expect(FakeSocket.all).toHaveLength(2);
    latest().open();
    expect(latest().sent[0]).toMatchObject({ t: 'hello', room: { kind: 'private', code: 'BCDFG' } });
    expect(seen.fatal).toHaveLength(0);
  });

  it('stops for good when the table has closed by the time it reconnects (no endless retries)', async () => {
    const { seen } = await makeNet();
    latest().drop();
    vi.advanceTimersByTime(400);
    latest().open();
    latest().receive({ t: 'error', code: 'not-found', message: 'That room has closed or the code is wrong.' });
    latest().drop(); // the server closes it
    expect(seen.fatal.map((e) => e.t === 'error' && e.code)).toEqual(['not-found']);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('starts again when the connection goes quiet while the page is showing', async () => {
    const { seen } = await makeNet();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(8_000);
    expect(seen.reconnecting).toBe(1);
    vi.advanceTimersByTime(400);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('keeps a connection that is talking', async () => {
    await makeNet();
    const { PING_MS } = await import('../src/net');
    expect(PING_MS).toBe(5000); // a card table's traffic is mostly this
    for (let i = 0; i < 20; i++) {
      // Every other answer lost still isn't silence.
      vi.advanceTimersByTime(PING_MS * 2);
      latest().receive({ t: 'pong', at: 0 });
    }
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('after "opened in another tab", leaving says nothing on that socket', async () => {
    const { net, seen } = await makeNet();
    const old = latest();
    old.receive({ t: 'error', code: 'replaced', message: 'Opened in another tab.' });
    expect(seen.fatal).toHaveLength(1);
    net.close();
    expect(old.sent.map((m) => m.t)).not.toContain('leave');
  });

  it('asks for batches, and takes one as the messages in it, in order', async () => {
    const { seen } = await makeNet();
    expect(latest().sent[0]).toMatchObject({ t: 'hello', batch: true });
    const had = seen.messages;
    latest().receive({ t: 'batch', msgs: [{ t: 'pong', at: 1 }, { t: 'pong', at: 2 }, { t: 'pong', at: 3 }] });
    expect(seen.messages - had).toBe(3);
  });

  it('gives up on a connection that never opens, rather than joining for ever', async () => {
    const { Net } = await import('../src/net');
    let gaveUp = 0;
    const net = new Net({ kind: 'private', code: 'BCDFG' }, () => 'Liz', 'phone', { onMessage: () => {}, onFatal: () => {}, onReconnecting: () => void gaveUp++ });
    net.connect();
    vi.advanceTimersByTime(8000);
    expect(gaveUp).toBe(0);
    vi.advanceTimersByTime(4000);
    expect(gaveUp).toBe(1);
    expect(FakeSocket.all[0].readyState).toBe(FakeSocket.CLOSED);
    net.close();
  });

  it('once let go of, a late answer is ignored', async () => {
    const { net, seen } = await makeNet();
    const old = latest();
    const had = seen.messages;
    net.close();
    old.receive(welcome);
    old.receive({ t: 'batch', msgs: [welcome] });
    expect(seen.messages).toBe(had);
  });

  it('a message that trips up its screen loses only itself, not the rest of its batch', async () => {
    const { Net } = await import('../src/net');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: number[] = [];
    const net = new Net({ kind: 'private', code: 'BCDFG' }, () => 'Liz', 'phone', {
      onMessage: (m) => {
        if (m.t !== 'pong') return;
        got.push(m.at);
        if (m.at === 1 || m.at === 4) throw new Error('a bug drawing this one');
      },
      onFatal: () => {},
      onReconnecting: () => {},
    });
    net.connect();
    latest().open();
    latest().receive(welcome);
    latest().receive({ t: 'batch', msgs: [{ t: 'pong', at: 1 }, { t: 'pong', at: 2 }, { t: 'pong', at: 3 }] });
    // One on its own, too: it doesn't escape, and the next still arrives.
    latest().receive({ t: 'pong', at: 4 });
    latest().receive({ t: 'pong', at: 5 });
    expect(got).toEqual([1, 2, 3, 4, 5]);
    expect(quiet).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
    net.close();
  });

  it('says "table" where the server says "room"', async () => {
    const { inTableWords } = await import('../src/net');
    expect(inTableWords('Room is full.')).toBe('Table is full.');
    expect(inTableWords('That room has closed or the code is wrong.')).toBe('That table has closed or the code is wrong.');
    expect(inTableWords("You've made a lot of rooms. Try again in a few minutes.")).toBe("You've made a lot of tables. Try again in a few minutes.");
    expect(inTableWords('Too many wrong room codes.')).toBe('Too many wrong table codes.');
    expect(inTableWords('Opened in another tab. Roomy bathroom.')).toBe('Opened in another tab. Roomy bathroom.');
  });

  it('leaving a table normally says "leave"', async () => {
    const { net } = await makeNet();
    const s = latest();
    net.close();
    expect(s.sent.map((m) => m.t)).toContain('leave');
  });
});
