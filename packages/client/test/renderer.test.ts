import { afterEach, describe, expect, it, vi } from 'vitest';
import { nukeShake, Renderer } from '../src/renderer';

describe('the battlefield’s size', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A renderer on a canvas whose size on screen isn't whole CSS pixels (no sprites needed). */
  function onScreen(width: number, height: number, dpr: number) {
    vi.stubGlobal('window', { devicePixelRatio: dpr });
    const canvas = { width: 0, height: 0, clientWidth: Math.round(width), clientHeight: Math.round(height), getBoundingClientRect: () => ({ width, height }) };
    const r = Object.create(Renderer.prototype) as Renderer;
    Object.assign(r, { canvas, dpr: 1 });
    return { r, canvas };
  }

  it('settles after one resize, even when the screen isn’t whole CSS pixels', () => {
    // A Pixel 7 held sideways: 2400 x 1080 device pixels at 2.625 (capped to 2.5 here).
    const { r, canvas } = onScreen(2400 / 2.625, 1080 / 2.625, 2.625);
    r.resize();
    expect(canvas.width).toBe(2286);
    for (let frame = 0; frame < 3; frame++) expect(r.syncSize()).toBe(false);
  });

  it('follows the screen when it really changes size', () => {
    const { r, canvas } = onScreen(800.4, 360.6, 1.25);
    r.resize();
    expect(r.syncSize()).toBe(false);
    canvas.getBoundingClientRect = () => ({ width: 800.4, height: 390.2 });
    expect(r.syncSize()).toBe(true);
    expect(canvas.height).toBe(Math.round(390.2 * 1.25));
    expect(r.syncSize()).toBe(false);
  });
});

describe('the screen shake', () => {
  it('shakes through a nuke, and never with Reduce motion on', () => {
    expect(nukeShake(0.3, false)).toBeGreaterThan(5);
    for (let t = 0; t <= 1; t += 0.1) expect(nukeShake(t, true)).toBe(0);
  });
});
