/**
 * Game controllers (Xbox, PlayStation, Switch Pro...) through the browser's Gamepad API. Every
 * browser maps them to the same "standard" layout; names here are Xbox's. Browsers only reveal
 * a controller after one of its buttons is pressed with the page open.
 *
 * Any connected controller drives the game. Presses are reported once (and repeat while a
 * direction is held, for menus and card cursors). The left stick also counts as a direction
 * pad for menus; games that want it analog read `state.lx` / `state.ly` every frame.
 */

export type PadButton = 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'view' | 'menu' | 'ls' | 'rs' | 'up' | 'down' | 'left' | 'right';

/** Index order of the standard mapping (https://w3c.github.io/gamepad/#remapping). */
const STANDARD: PadButton[] = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'menu', 'ls', 'rs', 'up', 'down', 'left', 'right'];
const DIRECTIONS = new Set<PadButton>(['up', 'down', 'left', 'right']);

export interface PadPress {
  button: PadButton;
  /** A held direction repeating, not a fresh press. */
  repeat: boolean;
  /** The left stick pushed past halfway, not the d-pad. */
  stick: boolean;
}

export interface PadState {
  /** Left stick, -1..1 (up is negative), with a small dead zone. */
  lx: number;
  ly: number;
  held: Set<PadButton>;
}

const DEAD_ZONE = 0.22;
const STICK_AS_DPAD = 0.6;
const REPEAT_FIRST_MS = 380;
const REPEAT_MS = 110;

export interface PadHandlers {
  press(p: PadPress): void;
  release(button: PadButton): void;
  connected?(name: string): void;
}

export class Gamepads {
  state: PadState = { lx: 0, ly: 0, held: new Set() };
  /** Which held directions come from the stick (so games can tell them apart). */
  private fromStick = new Set<PadButton>();
  private repeatAt = new Map<PadButton, number>();
  private raf = 0;
  private seen = false;

  constructor(private h: PadHandlers) {
    window.addEventListener('gamepadconnected', this.onConnect);
    const loop = (now: number) => {
      this.poll(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** True once any controller has been used on this page. */
  get active() {
    return this.seen;
  }

  private onConnect = (e: Event) => {
    this.seen = true;
    this.h.connected?.((e as GamepadEvent).gamepad.id);
  };

  poll(now: number) {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const held = new Set<PadButton>();
    const stickDirs = new Set<PadButton>();
    let lx = 0;
    let ly = 0;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      STANDARD.forEach((name, i) => {
        const b = p.buttons[i];
        if (b && (b.pressed || b.value > 0.5)) held.add(name);
      });
      const axis = (i: number) => {
        const v = p.axes[i] ?? 0;
        return Math.abs(v) < DEAD_ZONE ? 0 : v;
      };
      if (Math.abs(axis(0)) > Math.abs(lx)) lx = axis(0);
      if (Math.abs(axis(1)) > Math.abs(ly)) ly = axis(1);
    }
    for (const [dir, on] of [
      ['left', lx < -STICK_AS_DPAD],
      ['right', lx > STICK_AS_DPAD],
      ['up', ly < -STICK_AS_DPAD],
      ['down', ly > STICK_AS_DPAD],
    ] as const) {
      if (on && !held.has(dir)) {
        held.add(dir);
        stickDirs.add(dir);
      }
    }
    if (held.size) this.seen = true;

    for (const b of held) {
      if (this.state.held.has(b)) continue;
      this.h.press({ button: b, repeat: false, stick: stickDirs.has(b) });
      if (DIRECTIONS.has(b)) this.repeatAt.set(b, now + REPEAT_FIRST_MS);
    }
    for (const b of this.state.held) {
      if (held.has(b)) continue;
      this.h.release(b);
      this.repeatAt.delete(b);
    }
    for (const [b, at] of this.repeatAt) {
      if (held.has(b) && now >= at) {
        this.h.press({ button: b, repeat: true, stick: stickDirs.has(b) });
        this.repeatAt.set(b, now + REPEAT_MS);
      }
    }
    this.fromStick = stickDirs;
    this.state = { lx, ly, held };
  }

  /** Whether a held direction is coming from the stick rather than the d-pad. */
  isStick(b: PadButton) {
    return this.fromStick.has(b);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('gamepadconnected', this.onConnect);
  }
}

// ------------------------------------------------------------------ moving between buttons

const FOCUSABLE = 'button, a[href], input, select, [tabindex="0"]';

/**
 * Where an element is on screen. A choice tile's radio button is hidden inside its label (the
 * whole tile is what you see), so it's placed by the tile.
 */
function box(el: HTMLElement) {
  const label = el.tagName === 'INPUT' ? el.closest('label') : null;
  return (label ?? el).getBoundingClientRect();
}

function visible(el: HTMLElement) {
  if ((el as HTMLButtonElement).disabled || el.closest('[hidden]')) return false;
  const r = box(el);
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/**
 * Move focus to the nearest button in a direction, like a TV menu. Starts from the focused
 * element, or from `from` (a point) when nothing in `scope` is focused.
 */
export function moveFocus(scope: HTMLElement, dir: 'up' | 'down' | 'left' | 'right', from?: { x: number; y: number }): boolean {
  const items = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  if (!items.length) return false;
  const active = document.activeElement as HTMLElement | null;
  const current = active && scope.contains(active) && items.includes(active) ? active : null;
  if (!current && !from) {
    focusForPad(items[0]);
    return true;
  }
  const rc = current ? box(current) : undefined;
  const ox = rc ? rc.left + rc.width / 2 : from!.x;
  const oy = rc ? rc.top + rc.height / 2 : from!.y;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === current) continue;
    const r = box(el);
    const dx = r.left + r.width / 2 - ox;
    const dy = r.top + r.height / 2 - oy;
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 4) continue;
    // Prefer things straight ahead over things off to the side.
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return false;
  focusForPad(best);
  return true;
}

/** Focus an element and show a controller-style highlight on it. */
export function focusForPad(el: HTMLElement) {
  document.body.classList.add('pad-mode');
  el.focus({ preventScroll: false });
  el.scrollIntoView({ block: 'nearest' });
}

/** Mouse, touch or typing hides the controller highlight again. */
export function watchPadMode() {
  const off = () => document.body.classList.remove('pad-mode');
  window.addEventListener('pointerdown', off, true);
  window.addEventListener('keydown', off, true);
}
