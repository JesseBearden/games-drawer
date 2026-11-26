/** The Tanks screen around its battlefield: what each new game starts from. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, generateTerrain, PHASES } from '@tank/shared';

const art = vi.hoisted(() => ({ ready: null as object | null, load: (): Promise<object> => new Promise(() => {}), renderers: 0 }));
vi.mock('../src/terrainRenderer', () => ({ TerrainRenderer: class { reset() {} redraw() {} release() {} } }));
vi.mock('../src/sprites', () => ({ tankSpritesNow: () => art.ready, tankSprites: () => art.load() }));
vi.mock('../src/input', () => ({
  Input: class {
    angle = 60;
    power = 50;
    moving = 0;
    update() {}
    dispose() {}
  },
}));
vi.mock('../src/renderer', () => ({
  Renderer: class {
    constructor() {
      art.renderers++;
    }
    resize() {}
    release() {}
  },
}));

import { TankView } from '../src/tankView';

let els: Map<string, ReturnType<typeof element>>;
let frame: (now: number) => void;

function element() {
  const classes = new Set<string>();
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    classes,
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)),
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getContext: () => null,
  };
}
const el = (id: string) => {
  if (!els.has(id)) els.set(id, element());
  return els.get(id)!;
};

const shell = () => ({ device: { touch: true }, sfx: { preloadSounds() {}, stopAmbience() {}, play() {} }, toast() {}, sendGame() {} }) as never;
const init = () =>
  ({
    t: 'init',
    tankId: 1,
    reclaimed: false,
    config: DEFAULT_CONFIG,
    snapshot: {
      tick: 0,
      terrain: generateTerrain(DEFAULT_CONFIG, 5).toData(),
      terrainRev: 0,
      wind: 7,
      tanks: [{ id: 1, color: 0, name: 'Liz', controller: 'human', kills: 0, level: 0, deaths: 0, shellsInFlight: 0, protectedUntil: 0 }],
      dyn: [[1, 100, 100, 45, PHASES.indexOf('carried'), 0]],
      helis: [],
      shells: [],
      match: { state: 'playing' },
    },
  }) as never;

beforeEach(() => {
  els = new Map();
  Object.assign(art, { ready: null, load: () => new Promise(() => {}), renderers: 0 });
  vi.stubGlobal('document', { getElementById: el });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
  vi.stubGlobal('requestAnimationFrame', (f: (now: number) => void) => ((frame = f), 1));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the Tanks screen', () => {
  it('starts without the last game’s Move buttons, badge or Drop', () => {
    el('spread-badge').textContent = 'TRIPLE READY';
    el('fire-btn').classes.add('spread').add('drop');
    el('fire-btn').disabled = true;
    const view = new TankView(shell());
    expect(el('move-row').hidden).toBe(true);
    expect(el('spread-badge').hidden).toBe(true);
    expect([...el('fire-btn').classes]).toEqual([]);
    expect([el('fire-btn').textContent, el('fire-btn').disabled]).toEqual(['Fire', false]);
    view.dispose();
  });

  it('shows hearts, wind and Drop while the pictures are still downloading', () => {
    const view = new TankView(shell());
    view.onGameMessage(init());
    frame(performance.now());
    expect(el('hearts').innerHTML).toContain('heart.png');
    expect(el('wind-speed').textContent).toBe('7');
    expect(el('fire-btn').textContent).toBe('Drop');
    view.dispose();
  });

  it('on a sideways phone, shows messages one at a time in the status spot', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-height') }));
    vi.stubGlobal('document', { getElementById: el, documentElement: { classList: { add() {}, remove() {}, contains: () => false } } });
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, scrollTo() {}, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
    const view = new TankView({ ...(shell() as object), device: { touch: true, small: true } } as never);
    expect(view.showNote('Your mic is on.')).toBe(true);
    view.showNote('Liz is here.');
    view.showNote('Your mic is on.'); // already showing: not again
    expect([el('status').hidden, el('status').innerHTML]).toEqual([false, 'Your mic is on.']);
    vi.advanceTimersByTime(2200);
    expect(el('status').innerHTML).toBe('Liz is here.');
    vi.advanceTimersByTime(2200);
    expect(el('status').hidden).toBe(true);
    view.dispose();
  });

  it('elsewhere, leaves messages to pop up as usual', () => {
    const view = new TankView(shell());
    expect(view.showNote('Your mic is on.')).toBe(false);
    view.dispose();
  });

  it('a retry for the pictures stops when the screen closes', async () => {
    vi.useFakeTimers();
    art.load = () => Promise.reject(new Error('offline'));
    const view = new TankView(shell());
    view.onGameMessage(init());
    await vi.advanceTimersByTimeAsync(0);
    view.dispose();
    art.ready = {};
    await vi.advanceTimersByTimeAsync(20_000);
    expect(art.renderers).toBe(0);
  });
});
