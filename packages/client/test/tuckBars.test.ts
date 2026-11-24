/** A phone's browser held sideways: swiping the browser's bars away, and the hint that says so. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tuckBars } from '../src/tuckBars';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
let classes: Set<string>;
let arena: { children: { className: string; classList: Set<string>; removed: boolean }[] };
let listeners: Map<string, (e?: unknown) => void>;
let win: { innerHeight: number; scrollY: number; scrolls: number };
let landscape: boolean;
let standalone: boolean;

function setup(ua = IPHONE) {
  classes = new Set();
  arena = { children: [] };
  listeners = new Map();
  win = { innerHeight: 330, scrollY: 0, scrolls: 0 };
  landscape = true;
  standalone = false;
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('display-mode') ? standalone : q.includes('landscape') === landscape }));
  vi.stubGlobal('navigator', { userAgent: ua });
  vi.stubGlobal('screen', { width: 393, height: 852 });
  vi.stubGlobal('document', {
    documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
    getElementById: (id: string) =>
      id === 'arena'
        ? {
            append: (el: (typeof arena.children)[number]) => arena.children.push(el),
          }
        : null,
    createElement: () => {
      const cls = new Set<string>();
      const el = { className: '', classList: cls, removed: false, setAttribute() {}, textContent: '', remove: () => (el.removed = true) };
      (el.classList as unknown as { add: (c: string) => void }).add = (c: string) => Set.prototype.add.call(cls, c);
      return el;
    },
  });
  vi.stubGlobal(
    'window',
    Object.assign(win, {
      addEventListener: (ev: string, f: () => void) => listeners.set(ev, f),
      removeEventListener: (ev: string) => listeners.delete(ev),
      scrollTo: (_x: number, y: number) => {
        win.scrollY = y;
        win.scrolls++;
      },
      setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    }),
  );
}
const fire = (ev: string, e?: unknown) => listeners.get(ev)?.(e);
const hint = () => arena.children.find((c) => !c.removed && !c.classList.has('gone'));

beforeEach(() => setup());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tucking the browser’s bars away', () => {
  it('only in a phone’s browser, not on bigger screens or from the home screen icon', () => {
    tuckBars(false)();
    expect(classes.has('tuck-bars')).toBe(false);
    standalone = true;
    tuckBars(true);
    expect(classes.has('tuck-bars')).toBe(false);
    standalone = false;
    const untuck = tuckBars(true);
    expect(classes.has('tuck-bars')).toBe(true);
    untuck();
    expect(classes.has('tuck-bars')).toBe(false);
  });

  it('an iPhone with the bars showing gets a brief "Swipe up for fullscreen"', () => {
    const untuck = tuckBars(true);
    vi.advanceTimersByTime(700);
    expect(hint()).toBeTruthy();
    vi.advanceTimersByTime(2800 + 450);
    expect(hint()).toBeUndefined();
    untuck();
  });

  it('no hint with the bars already away, or on other phones', () => {
    win.innerHeight = 393;
    tuckBars(true)();
    setup('Mozilla/5.0 (Linux; Android 14)');
    const untuck = tuckBars(true);
    vi.advanceTimersByTime(5000);
    expect(arena.children).toEqual([]);
    untuck();
  });

  it('held upright, the hint waits for the phone to be turned', () => {
    landscape = false;
    const untuck = tuckBars(true);
    vi.advanceTimersByTime(5000);
    expect(hint()).toBeUndefined();
    landscape = true;
    fire('orientationchange');
    vi.advanceTimersByTime(300);
    expect(hint()).toBeTruthy();
    untuck();
  });

  it('once the bars are showing again, the page goes back to the top so a swipe up works', () => {
    const untuck = tuckBars(true);
    // They swipe: the page scrolls and the bars tuck away.
    fire('touchstart', { touches: [1] });
    win.scrollY = 120;
    win.innerHeight = 393;
    fire('resize');
    fire('touchend', { touches: [] });
    vi.advanceTimersByTime(1000);
    expect(win.scrollY).toBe(120); // the bars are away: leave it
    // The phone turns upright and back: the bars show, the page still scrolled to the bottom.
    win.innerHeight = 330;
    fire('resize');
    fire('touchstart', { touches: [1] });
    vi.advanceTimersByTime(1000);
    expect(win.scrollY).toBe(120); // not while a finger is down
    fire('touchend', { touches: [] });
    vi.advanceTimersByTime(500);
    expect(win.scrollY).toBe(0);
    untuck();
  });
});
