import { describe, expect, it } from 'vitest';
import { cleanName, cleanText } from '../src/names';
import { parseClientMessage } from '../src/protocol';
import { Rng } from '../src/rng';
import { addPlaced, flatWorld, runTicks } from './helpers';

/** Anti-cheat rules live in the authoritative simulation; these prove a client can't bend them. */
describe('shot limits', () => {
  it('only one shell in flight per tank, however fast fire is sent', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    let accepted = 0;
    for (let i = 0; i < 500; i++) if (w.fire(a.id, 60, 50)) accepted++;
    expect(accepted).toBe(1);
    expect(w.shells.filter((s) => s.owner === a.id)).toHaveLength(1);
    // Keep spamming every tick while the shell flies: still only one.
    for (let t = 0; t < 30; t++) {
      for (let i = 0; i < 20; i++) w.fire(a.id, 60, 50);
      w.step();
      expect(w.shells.filter((s) => s.owner === a.id).length).toBeLessThanOrEqual(1);
    }
    runTicks(w, 300);
    expect(w.fire(a.id, 60, 50)).toBe(true);
  });

  it('a spread volley holds the shot slot until all three shells land', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    a.level = 15;
    a.shotsUntilSpread = 0;
    expect(w.fire(a.id, 70, 60)).toBe(true);
    expect(w.shells).toHaveLength(3);
    let blockedWhileInFlight = true;
    while (w.shells.length > 0) {
      if (w.fire(a.id, 70, 60)) blockedWhileInFlight = false;
      w.step();
    }
    expect(blockedWhileInFlight).toBe(true);
    expect(a.shellsInFlight).toBe(0);
    expect(w.fire(a.id, 70, 60)).toBe(true);
  });

  it('cannot fire while carried, parachuting, falling, dead, or after a win', () => {
    const w = flatWorld(800);
    const t = w.addTank({ name: 'A', controller: 'human' });
    w.step();
    expect(t.phase).toBe('carried');
    expect(w.fire(t.id, 60, 50)).toBe(false);
    w.requestDrop(t.id);
    expect(t.phase).toBe('chute');
    expect(w.fire(t.id, 60, 50)).toBe(false);
    t.phase = 'air';
    expect(w.fire(t.id, 60, 50)).toBe(false);
    t.phase = 'dead';
    expect(w.fire(t.id, 60, 50)).toBe(false);
    const b = addPlaced(w, 'B', 900);
    w.match = { state: 'won', winner: b.id, nukeAt: w.tick + 999 };
    expect(w.fire(b.id, 60, 50)).toBe(false);
    expect(w.shells).toHaveLength(0);
  });

  it('cannot fire for a tank that does not exist', () => {
    const w = flatWorld(800);
    expect(w.fire(99, 60, 50)).toBe(false);
    expect(w.fire(-1, 60, 50)).toBe(false);
  });
});

describe('events caused by input between ticks', () => {
  it('a human shot and a helicopter drop are reported by the next step', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    const b = w.addTank({ name: 'B', controller: 'human' });
    w.step();
    expect(w.fire(a.id, 60, 50)).toBe(true);
    expect(w.requestDrop(b.id)).toBe(true);
    const events = w.step();
    const fire = events.find((e) => e.type === 'fire');
    expect(fire).toBeDefined();
    expect(fire!.tick).toBe(w.tick - 1);
    expect(events.some((e) => e.type === 'drop' && e.tank === b.id)).toBe(true);
    // Reported once, not again.
    expect(w.step().some((e) => e.type === 'fire')).toBe(false);
  });
});

describe('aim and movement limits', () => {
  it('clamps angle and power, and ignores non-finite values', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    w.setAim(a.id, 1e9, 1e9);
    expect(a.angle).toBe(180);
    expect(a.power).toBe(w.cfg.maxPower);
    w.setAim(a.id, -50, -50);
    expect(a.angle).toBe(0);
    expect(a.power).toBe(w.cfg.minPower);
    w.setAim(a.id, NaN, Infinity);
    expect(a.angle).toBe(0);
    expect(a.power).toBe(w.cfg.minPower);
  });

  it('an over-powered fire request launches at max power, not faster', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    w.fire(a.id, 45, 10_000);
    const s = w.shells[0];
    const speed = Math.hypot(s.vx, s.vy);
    expect(speed).toBeLessThanOrEqual(w.cfg.maxShellSpeed + 1e-6);
  });

  it('movement does nothing before level 10, and is capped after', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 900);
    w.setMove(a.id, 1);
    runTicks(w, 120);
    expect(a.x).toBe(900);
    a.level = 10;
    w.setMove(a.id, 99);
    runTicks(w, 60);
    // One second at slow speed, whatever "dir" value was sent.
    expect(a.x - 900).toBeCloseTo(w.cfg.moveSpeedSlow, 0);
  });

  it('a drop request only works while on the helicopter, once', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    expect(w.requestDrop(a.id)).toBe(false);
    expect(a.phase).toBe('ground');
  });

  it('spawn protection always ends when you fire', () => {
    const w = flatWorld(800);
    const a = addPlaced(w, 'A', 300);
    a.protectedUntil = w.tick + 10_000;
    w.fire(a.id, 60, 50);
    expect(w.isProtected(a)).toBe(false);
  });
});

describe('protocol parsing', () => {
  it('rejects malformed messages', () => {
    const bad = [
      '',
      'null',
      '[]',
      '"hi"',
      '{',
      '{"t":"fire"}',
      '{"t":"fire","angle":"1","power":2}',
      '{"t":"fire","angle":1e999,"power":2}',
      '{"t":"move","dir":2}',
      '{"t":"move","dir":"1"}',
      '{"t":"chat","text":5}',
      `{"t":"chat","text":"${'x'.repeat(1001)}"}`,
      '{"t":"name","name":null}',
      '{"t":"hello","v":1,"session":null,"name":"a","device":"fridge","room":{"kind":"public"}}',
      '{"t":"hello","v":1,"session":null,"name":"a","device":"phone","room":{"kind":"secret"}}',
      '{"t":"hello","v":1,"session":null,"name":"a","device":"phone","room":{"kind":"private","code":7}}',
      '{"t":"nuke"}',
      'x'.repeat(5000),
    ];
    for (const raw of bad) expect(parseClientMessage(raw), raw.slice(0, 60)).toBeNull();
  });

  it('strips unknown fields and never passes the client object through', () => {
    const raw = '{"t":"fire","angle":45,"power":50,"__proto__":{"admin":true},"level":50,"extra":{"deep":[1,2,3]}}';
    const m = parseClientMessage(raw)!;
    expect(m).toEqual({ t: 'fire', angle: 45, power: 50 });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    const hello = parseClientMessage(
      '{"t":"hello","v":1,"session":null,"name":"a","device":"phone","room":{"kind":"public","code":"ZZZZZ","admin":1}}',
    )!;
    expect(hello).toEqual({ t: 'hello', v: 1, session: null, name: 'a', device: 'phone', room: { kind: 'public' } });
  });

  it('survives random garbage (fuzz)', () => {
    const rng = new Rng(1234);
    const pieces = ['{', '}', '[', ']', '"t"', ':', ',', '"fire"', '"hello"', '1e308', '-0', 'null', 'true', '"\\u0000"', '"angle"', '"power"', '"room"', '{"kind":"private"}'];
    for (let i = 0; i < 20_000; i++) {
      let s = '';
      const n = rng.int(0, 12);
      for (let k = 0; k < n; k++) s += rng.pick(pieces);
      expect(() => parseClientMessage(s)).not.toThrow();
    }
  });
});

describe('text cleaning', () => {
  it('removes invisible and direction-flipping characters', () => {
    const rlo = String.fromCodePoint(0x202e);
    const zw = String.fromCodePoint(0x200b);
    expect(cleanText(`hi${rlo}dlrow${zw}`, 50)).toBe('hidlrow');
    expect(cleanText('line1\nline2\r\n\tend', 50)).toBe('line1 line2 end');
  });

  it('caps stacked accents (zalgo) at two per letter', () => {
    const zalgo = 'a' + String.fromCodePoint(0x0301).repeat(40) + 'b';
    expect([...cleanText(zalgo, 50)].length).toBe(4);
  });

  it('caps length without splitting emoji', () => {
    const s = '🙂'.repeat(30);
    const out = cleanName(s);
    expect([...out].length).toBe(20);
    expect(out).toBe('🙂'.repeat(20));
  });
});
