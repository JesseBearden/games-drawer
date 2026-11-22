/** The Dominoes screen, on stand-in elements. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/dom', () => ({ patchHtml: () => false, syncKeyed: () => {} }));
vi.mock('../src/dominoLayout', async (original) => {
  const real = await original<typeof import('../src/dominoLayout')>();
  return { ...real, limitsFor: vi.fn(real.limitsFor) };
});

import { limitsFor } from '../src/dominoLayout';
import { DominoesTable } from '../src/dominoesView';

type Handler = (e: object) => void;
let parts: Map<string, ReturnType<typeof element>>;
let boardHeight: number;

function element(rect = () => ({ left: 0, top: 0, right: 0, width: 0, height: 0 })) {
  const on = new Map<string, Handler>();
  return {
    hidden: false,
    innerHTML: '',
    textContent: '',
    offsetWidth: 0,
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    on,
    addEventListener: (type: string, f: Handler) => void on.set(type, f),
    removeEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect: rect,
    closest: () => null,
    querySelector: (sel: string) => part(sel),
    querySelectorAll: () => [],
  };
}
function part(sel: string): ReturnType<typeof element> {
  if (!parts.has(sel)) {
    const size = (w: number, h: () => number) => () => ({ left: 0, top: 0, right: w, width: w, height: h() });
    parts.set(sel, sel === '.dm-board' ? element(size(375, () => boardHeight)) : sel === '.ht-center' ? element(size(375, () => 500)) : element());
  }
  return parts.get(sel)!;
}

function make() {
  const table = new DominoesTable({ sfx: { preloadSounds() {} }, play() {} } as never);
  // Reaching in: these are the screen's own parts, driven as its messages and pointers would.
  return table as unknown as {
    view: object;
    pointers: Map<number, object>;
    renderBoard(): void;
    popPoints(points: number, seat: number): void;
    dispose(): void;
  };
}

beforeEach(() => {
  parts = new Map();
  boardHeight = 500;
  vi.mocked(limitsFor).mockClear();
  vi.stubGlobal('document', { getElementById: () => element(), querySelector: () => null });
  vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the Dominoes screen', () => {
  it('folds the same whether or not "Nothing fits" and Draw are under the board', () => {
    const t = make();
    t.view = { layout: { root: null, arms: [] }, moves: [], seat: 0 };
    t.renderBoard();
    boardHeight = 330; // the line and the button take their room from the board
    t.renderBoard();
    const [before, after] = vi.mocked(limitsFor).mock.results.map((r) => r.value);
    expect(after).toEqual(before);
    t.dispose();
  });

  it('a mouse let go of off the board doesn’t keep hold of it', () => {
    const t = make();
    const board = part('.dm-board');
    const mouse = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 5, clientY: 5 };
    board.on.get('pointerdown')!({ ...mouse, buttons: 1 });
    expect(t.pointers.size).toBe(1);
    board.on.get('pointermove')!({ ...mouse, buttons: 0, clientX: 40 }); // back over it, nothing held
    expect(t.pointers.size).toBe(0);
    t.dispose();
  });

  it('a second "+10" gets its whole time on screen', () => {
    vi.useFakeTimers();
    const t = make();
    t.view = { seat: 0 };
    t.popPoints(10, 0);
    vi.advanceTimersByTime(1000);
    t.popPoints(15, 0);
    vi.advanceTimersByTime(700); // the first one's time is up
    expect(part('.dm-pop').hidden).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(part('.dm-pop').hidden).toBe(true);
    t.dispose();
  });
});
