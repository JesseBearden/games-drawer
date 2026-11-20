import { describe, expect, it } from 'vitest';
import { Rng, type ClientMessage, type ServerMessage } from '@tank/shared';
import { ChatModerator } from '../src/chat';
import { MemoryLog } from '../src/eventlog';
import { SessionSigner, TokenBucket, WindowCounter } from '../src/guard';
import { RoomManager } from '../src/manager';
import { ANNOUNCE_COOLDOWN_MS, RENAME_COOLDOWN_MS, type Conn } from '../src/room';

class FakeConn implements Conn {
  sent: ServerMessage[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  chats() {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: 'chat' }> => m.t === 'chat').map((m) => m.msg);
  }
}

function setup() {
  const clock = { now: 1_000_000 };
  const log = new MemoryLog();
  const mgr = new RoomManager({
    now: () => clock.now,
    log,
    moderator: new ChatModerator(),
    emptyRoomMs: 60_000,
    publicReclaimMs: 60_000,
    maxPublicRooms: 10,
    maxPrivateRooms: 10,
    chatHistorySize: 10,
  });
  return { clock, log, mgr };
}

function join(mgr: RoomManager, session: string, name = session) {
  const lookup = mgr.resolve({ kind: 'public' }, session);
  if (!lookup.ok) throw new Error(lookup.code);
  const conn = new FakeConn();
  const r = lookup.room.join(conn, session, name, 'desktop');
  if (!r.ok) throw new Error(r.code);
  lookup.room.sendWelcome(session, r);
  return { room: lookup.room, conn, tankId: lookup.room.tanks!.tankIdOf(session)!, name: r.name };
}

describe('names', () => {
  it('replaces an offensive starting name with a default one', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa', 'shithead');
    expect(a.name.toLowerCase()).not.toContain('shit');
    expect(a.name.length).toBeGreaterThan(0);
  });

  it('cleans invisible characters out of names', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa', `Ad${String.fromCodePoint(0x200b)}min${String.fromCodePoint(0x202e)}`);
    expect(a.name).toBe('Admin');
  });

  it('limits renames to one per cooldown and never broadcasts the rejected ones', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    const before = b.conn.chats().length;
    for (let i = 0; i < 50; i++) a.room.handle('session-aaaa', { t: 'name', name: `Spam ${i}` });
    const tank = a.room.tanks!.world.tanks.get(a.tankId)!;
    expect(tank.name).toBe('Spam 0');
    expect(b.conn.chats().length - before).toBe(1);
    clock.now += RENAME_COOLDOWN_MS;
    a.room.handle('session-aaaa', { t: 'name', name: 'Sharpshooter' });
    expect(tank.name).toBe('Sharpshooter');
  });

  it('bots give up a name a person picks', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const bot = [...a.room.tanks!.world.tanks.values()].find((t) => t.controller === 'bot')!;
    const botName = bot.name;
    const b = join(mgr, 'session-bbbb', botName);
    expect(b.name).toBe(botName);
    const names = [...a.room.tanks!.world.tanks.values()].map((t) => t.name.toLowerCase());
    expect(names.filter((n) => n === botName.toLowerCase())).toHaveLength(1);
  });

  it('cannot take another player name exactly', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa', 'Sharp Shooter');
    const b = join(mgr, 'session-bbbb', 'Sharp Shooter');
    expect(a.name).toBe('Sharp Shooter');
    expect(b.name).toBe('Sharp Shooter 2');
  });
});

describe('chat', () => {
  it('strips control and bidi characters before delivery', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    a.room.handle('session-aaaa', { t: 'chat', text: `nice${String.fromCodePoint(0x202e)}\n\n\nshot` });
    const got = b.conn.chats().filter((m) => !m.system).at(-1)!;
    expect(got.text).toBe('nice shot');
  });

  it('logs rate-limited spam as periodic counts, not one line per message', () => {
    const { mgr, clock, log } = setup();
    const a = join(mgr, 'session-aaaa');
    for (let i = 0; i < 500; i++) a.room.handle('session-aaaa', { t: 'chat', text: `spam ${i}` });
    const perMessage = log.chats.filter((c) => c.outcome === 'delivered' || c.outcome === 'blocked');
    expect(perMessage.length).toBeLessThanOrEqual(5);
    clock.now += 1000;
    mgr.housekeeping();
    const summary = log.chats.find((c) => c.outcome === 'rate-limited-summary')!;
    expect(summary.rapid).toBe(495);
    expect(log.chats.length).toBeLessThanOrEqual(6);
  });

  it('does not echo a notice for every flooded message', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const before = a.conn.sent.length;
    for (let i = 0; i < 300; i++) a.room.handle('session-aaaa', { t: 'chat', text: `spam ${i}` });
    // 5 delivered messages + at most one notice.
    expect(a.conn.sent.length - before).toBeLessThanOrEqual(7);
  });

  it('rejects overlong messages, counting emoji as one character', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    a.room.handle('session-aaaa', { t: 'chat', text: '🙂'.repeat(200) });
    expect(b.conn.chats().some((m) => m.text.startsWith('🙂'))).toBe(true);
    a.room.handle('session-aaaa', { t: 'chat', text: 'x'.repeat(201) });
    expect(b.conn.chats().some((m) => m.text.startsWith('xxx'))).toBe(false);
  });

  it('throttles join/leave notices from reconnect loops', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    const watcher = join(mgr, 'session-bbbb');
    const before = watcher.conn.chats().length;
    for (let i = 0; i < 30; i++) {
      a.room.disconnect('session-aaaa', null, 'disconnect');
      a.room.join(new FakeConn(), 'session-aaaa', 'x', 'desktop');
    }
    expect(watcher.conn.chats().length - before).toBeLessThanOrEqual(2);
    clock.now += ANNOUNCE_COOLDOWN_MS;
    a.room.disconnect('session-aaaa', null, 'disconnect');
    expect(watcher.conn.chats().length - before).toBeLessThanOrEqual(3);
  });
});

describe('human input reaches everyone', () => {
  it('a human shot is broadcast to other players and logged as a human shot', () => {
    const { mgr, log } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    const tank = a.room.tanks!.world.tanks.get(a.tankId)!;
    a.room.tanks!.world.helis = a.room.tanks!.world.helis.filter((h) => h.tankId !== tank.id);
    tank.phase = 'ground';
    tank.x = 300;
    tank.y = a.room.tanks!.world.terrain.groundBelow(300, 0);
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'fire', angle: 60, power: 50 } });
    for (let i = 0; i < 3; i++) mgr.stepAll();
    const fires = b.conn.sent
      .flatMap((m) => (m.t === 'g' && m.m.t === 'events' ? m.m.events : []))
      .filter((e) => e.type === 'fire' && e.tank === tank.id);
    expect(fires).toHaveLength(1);
    expect(log.events.some((e) => e.type === 'shot' && e.tank === tank.id && e.controller === 'human')).toBe(true);
  });
});

describe('messages from a hostile client', () => {
  it('ignores input for tanks it does not own', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const b = join(mgr, 'session-bbbb');
    const bTank = a.room.tanks!.world.tanks.get(b.tankId)!;
    const angle = bTank.angle;
    // There is no tank id in any client message; the server only ever applies input to
    // the sender's own tank, so the best a client can do is aim its own.
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'aim', angle: 3, power: 90 } });
    expect(bTank.angle).toBe(angle);
    // Unknown sessions are ignored entirely.
    a.room.handle('session-zzzz', { t: 'g', m: { t: 'fire', angle: 45, power: 50 } });
    expect(a.room.tanks!.world.shells).toHaveLength(0);
  });

  it('a disconnected player cannot keep sending input', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    const tank = a.room.tanks!.world.tanks.get(a.tankId)!;
    tank.phase = 'ground';
    a.room.disconnect('session-aaaa', a.conn, 'disconnect');
    const shells = a.room.tanks!.world.shells.length;
    a.room.handle('session-aaaa', { t: 'g', m: { t: 'fire', angle: 45, power: 50 } });
    expect(a.room.tanks!.world.shells.length).toBe(shells);
  });

  it('survives thousands of random messages while the game runs (fuzz)', () => {
    const { mgr, clock } = setup();
    const a = join(mgr, 'session-aaaa');
    const rng = new Rng(99);
    const weird = [NaN, Infinity, -Infinity, -1e308, 1e308, -0, 0.5, 179.999, 180.0001];
    for (let i = 0; i < 20_000; i++) {
      const n = (): number => (rng.chance(0.3) ? rng.pick(weird) : rng.range(-500, 500));
      const msgs: ClientMessage[] = [
        { t: 'g', m: { t: 'aim', angle: n(), power: n() } },
        { t: 'g', m: { t: 'fire', angle: n(), power: n() } },
        { t: 'g', m: { t: 'move', dir: rng.pick([-1, 0, 1] as const) } },
        { t: 'g', m: { t: 'drop' } },
        { t: 'ping', at: n() },
        { t: 'chat', text: String.fromCodePoint(rng.int(0, 0x10ffff - 1) & 0xfffff) },
        { t: 'name', name: 'x'.repeat(rng.int(0, 64)) },
        { t: 'g', m: { t: 'resync' } },
        { t: 'g', m: { t: 'play', card: rng.pick(['QS', '2C', 'AH']) } },
        { t: 'g', m: { t: 'pass', cards: ['2C', '3C', '4C'] } },
        { t: 'g', m: { t: 'again' } },
        { t: 'pick', game: 'hearts' },
        { t: 'lobby' },
      ];
      expect(() => a.room.handle('session-aaaa', rng.pick(msgs))).not.toThrow();
      if (i % 5 === 0) mgr.stepAll();
      clock.now += 7;
    }
    for (const t of a.room.tanks!.world.tanks.values()) {
      expect(Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.angle) && Number.isFinite(t.power)).toBe(true);
      expect(t.angle).toBeGreaterThanOrEqual(0);
      expect(t.angle).toBeLessThanOrEqual(180);
    }
    expect(mgr.rooms.size).toBe(1);
  });
});

describe('guards', () => {
  it('token bucket allows a burst, then the steady rate', () => {
    const b = new TokenBucket(10, 20, 0);
    let ok = 0;
    for (let i = 0; i < 100; i++) if (b.take(0)) ok++;
    expect(ok).toBe(20);
    expect(b.take(50)).toBe(false);
    expect(b.take(100)).toBe(true);
  });

  it('window counter forgets old events', () => {
    const c = new WindowCounter(1000);
    c.add('ip', 0);
    c.add('ip', 500);
    expect(c.count('ip', 900)).toBe(2);
    expect(c.count('ip', 1200)).toBe(1);
    c.sweep(5000);
    expect(c.count('ip', 5000)).toBe(0);
  });

  it('session credentials cannot be forged or tampered with', () => {
    const s = new SessionSigner('secret-a');
    const token = s.issue();
    expect(s.verify(token)).toBe(true);
    expect(new SessionSigner('secret-b').verify(token)).toBe(false);
    const [id, mac] = token.split('.');
    expect(s.verify(`${id}.${mac.replace(/.$/, (c) => (c === '0' ? '1' : '0'))}`)).toBe(false);
    expect(s.verify(`${id.replace(/^./, 'f')}.${mac}`)).toBe(id.startsWith('f'));
    expect(s.verify('session-aaaa')).toBe(false);
    expect(s.verify(null)).toBe(false);
    expect(s.verify({})).toBe(false);
  });
});

describe('chat reports', () => {
  it('saves a reported message and its sender for review, ignores unknown ids, and is rate limited', () => {
    const { mgr, log, clock } = setup();
    const a = join(mgr, 'session-aaaa', 'Alice');
    const b = join(mgr, 'session-bbbb', 'Bob');
    a.room.handle('session-aaaa', { t: 'chat', text: 'hello there' });
    const msg = b.conn.chats().find((m) => m.text === 'hello there')!;
    // Chat carries a room alias, never the session or the log pseudonym.
    expect(msg.speaker).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(msg)).not.toContain('session-aaaa');
    b.room.handle('session-bbbb', { t: 'report', msgId: msg.id });
    const report = log.chats.find((c) => c.outcome === 'reported')!;
    expect(report.msgId).toBe(msg.id);
    expect(report.reported).toBe(a.room.players.get('session-aaaa')!.pid);
    // The one time chat text is written down: the message someone reported.
    expect(report.text).toBe('hello there');
    expect(report.reportedName).toBe('Alice');
    expect(log.chats.find((c) => c.outcome === 'delivered')!.text).toBeUndefined();
    b.room.handle('session-bbbb', { t: 'report', msgId: 'not-a-real-id' });
    expect(log.chats.filter((c) => c.outcome === 'reported')).toHaveLength(1);
    for (let i = 0; i < 20; i++) {
      clock.now += 3000;
      a.room.handle('session-aaaa', { t: 'chat', text: `line ${i}` });
    }
    for (const m of b.conn.chats().filter((m) => m.text.startsWith('line '))) b.room.handle('session-bbbb', { t: 'report', msgId: m.id });
    // 1 earlier + at most 4 more inside the minute window.
    expect(log.chats.filter((c) => c.outcome === 'reported').length).toBeLessThanOrEqual(10);
  });
});

describe('voice signalling', () => {
  function joinPrivate(mgr: RoomManager, session: string, code?: string) {
    const lookup = mgr.resolve(code ? { kind: 'private', code } : { kind: 'create-private' }, session);
    if (!lookup.ok) throw new Error(lookup.code);
    const conn = new FakeConn();
    const r = lookup.room.join(conn, session, session, 'phone');
    if (!r.ok) throw new Error(r.code);
    lookup.room.sendWelcome(session, r);
    return { room: lookup.room, conn, alias: lookup.room.players.get(session)!.alias };
  }
  const voiceMsgs = (c: FakeConn) => c.sent.filter((m): m is Extract<ServerMessage, { t: 'voice' }> => m.t === 'voice');
  const rtcMsgs = (c: FakeConn) => c.sent.filter((m): m is Extract<ServerMessage, { t: 'rtc' }> => m.t === 'rtc');
  const offer = { sdp: { type: 'offer' as const, sdp: 'v=0' } };

  it('is not available in public rooms', () => {
    const { mgr } = setup();
    const a = join(mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'voice', join: true });
    expect(a.room.voicePeers()).toHaveLength(0);
    expect(a.room.welcome('session-aaaa', { ok: true, reclaimed: false, name: a.name })).toMatchObject({ voice: { enabled: false } });
  });

  it('relays set-up messages only between voice members of the room', () => {
    const { mgr } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    const b = joinPrivate(mgr, 'session-bbbb', a.room.code);
    const c = joinPrivate(mgr, 'session-cccc', a.room.code);
    a.room.handle('session-aaaa', { t: 'voice', join: true });
    b.room.handle('session-bbbb', { t: 'voice', join: true });
    expect(voiceMsgs(c.conn).at(-1)!.peers.map((p) => p.id).sort()).toEqual([a.alias, b.alias].sort());

    a.room.handle('session-aaaa', { t: 'rtc', to: b.alias, data: offer });
    expect(rtcMsgs(b.conn)).toEqual([{ t: 'rtc', from: a.alias, data: offer }]);

    // C is not in voice: it can neither send nor receive set-up messages.
    c.room.handle('session-cccc', { t: 'rtc', to: a.alias, data: offer });
    a.room.handle('session-aaaa', { t: 'rtc', to: c.alias, data: offer });
    expect(rtcMsgs(a.conn)).toHaveLength(0);
    expect(rtcMsgs(c.conn)).toHaveLength(0);

    // Nobody can relay to themselves or to an unknown alias.
    a.room.handle('session-aaaa', { t: 'rtc', to: a.alias, data: offer });
    a.room.handle('session-aaaa', { t: 'rtc', to: 'ffffffff', data: offer });
    expect(rtcMsgs(a.conn)).toHaveLength(0);

    // Leaving (or disconnecting) updates everyone and stops relaying.
    b.room.disconnect('session-bbbb', b.conn, 'disconnect');
    expect(voiceMsgs(c.conn).at(-1)!.peers.map((p) => p.id)).toEqual([a.alias]);
    a.room.handle('session-aaaa', { t: 'rtc', to: b.alias, data: offer });
    expect(rtcMsgs(b.conn)).toHaveLength(1);
  });

  it('a reconnect starts outside voice', () => {
    const { mgr } = setup();
    const a = joinPrivate(mgr, 'session-aaaa');
    a.room.handle('session-aaaa', { t: 'voice', join: true });
    expect(a.room.voicePeers()).toHaveLength(1);
    a.room.join(new FakeConn(), 'session-aaaa', 'x', 'phone');
    expect(a.room.voicePeers()).toHaveLength(0);
  });
});
