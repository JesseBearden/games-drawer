/**
 * Keyboard and touch input. Angle and power are kept locally (so aiming feels instant) and
 * streamed to the server; they persist between shots and across respawns.
 *
 * Tap = one fine step. Hold = continuous, accelerating.
 */
export type Action = 'angle-left' | 'angle-right' | 'power-up' | 'power-down' | 'move-left' | 'move-right' | 'fire';

export interface InputSink {
  /** Called on any gameplay press. Return true to consume it (e.g. used as the helicopter drop). */
  gameplayPress(): boolean;
  fire(): void;
  setMove(dir: -1 | 0 | 1): void;
  aimChanged(): void;
}

const KEYMAP: Record<string, Action> = {
  ArrowLeft: 'angle-left',
  ArrowRight: 'angle-right',
  ArrowUp: 'power-up',
  ArrowDown: 'power-down',
  KeyA: 'move-left',
  KeyD: 'move-right',
  Space: 'fire',
};

const HOLD_DELAY = 260;

export class Input {
  angle = 60;
  power = 55;
  private held = new Map<Action, number>();
  private moveDir: -1 | 0 | 1 = 0;
  enabled = true;

  constructor(
    private sink: InputSink,
    private touchRoot: HTMLElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.releaseAll();
    });
    for (const btn of touchRoot.querySelectorAll<HTMLElement>('[data-act]')) {
      const act = btn.dataset.act as Action;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        btn.classList.add('held');
        this.press(act);
      });
      const up = (e: PointerEvent) => {
        e.preventDefault();
        btn.classList.remove('held');
        this.release(act);
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      // iOS sometimes drops pointerup; losing capture always means the finger is gone.
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  private typingInField(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || this.typingInField(e)) return;
    const act = KEYMAP[e.code];
    if (!act) return;
    e.preventDefault();
    if (e.repeat) return;
    this.press(act);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const act = KEYMAP[e.code];
    if (act) this.release(act);
  };

  press(act: Action) {
    if (this.sink.gameplayPress()) return;
    if (act === 'fire') {
      this.sink.fire();
      return;
    }
    this.held.set(act, performance.now());
    // One tap = 1 degree, or half a percent of power (power is the touchier control).
    this.step(act, act === 'power-up' || act === 'power-down' ? 0.5 : 1);
    this.updateMove();
  }

  release(act: Action) {
    this.held.delete(act);
    this.updateMove();
  }

  releaseAll() {
    this.held.clear();
    this.updateMove();
  }

  private updateMove() {
    const l = this.held.has('move-left');
    const r = this.held.has('move-right');
    const dir: -1 | 0 | 1 = l && !r ? -1 : r && !l ? 1 : 0;
    if (dir !== this.moveDir) {
      this.moveDir = dir;
      this.sink.setMove(dir);
    }
  }

  private step(act: Action, amount: number) {
    switch (act) {
      case 'angle-left':
        this.angle = Math.min(180, this.angle + amount);
        break;
      case 'angle-right':
        this.angle = Math.max(0, this.angle - amount);
        break;
      case 'power-up':
        this.power = Math.min(100, this.power + amount);
        break;
      case 'power-down':
        this.power = Math.max(5, this.power - amount);
        break;
      default:
        return;
    }
    this.sink.aimChanged();
  }

  /** Any controller button that isn't a game action still drops you from the helicopter. */
  anyPress() {
    if (this.enabled) this.sink.gameplayPress();
  }

  /**
   * A controller's left stick, every frame: sideways turns the barrel, up and down set the
   * power. Squared, so small pushes make fine adjustments.
   */
  analog(x: number, y: number, dtMs: number) {
    if (!this.enabled || (x === 0 && y === 0)) return;
    const curve = (v: number) => Math.sign(v) * v * v;
    if (x) this.angle = Math.min(180, Math.max(0, this.angle - (curve(x) * 75 * dtMs) / 1000));
    if (y) this.power = Math.min(100, Math.max(5, this.power - (curve(y) * 45 * dtMs) / 1000));
    this.sink.aimChanged();
  }

  /** Call every frame: applies continuous adjustment for held buttons. */
  update(dtMs: number) {
    const now = performance.now();
    for (const [act, since] of this.held) {
      const heldFor = now - since;
      if (heldFor < HOLD_DELAY) continue;
      // Accelerate from 25 to 80 units per second over the first second of holding.
      const rate = 25 + Math.min(1, (heldFor - HOLD_DELAY) / 1000) * 55;
      this.step(act, (rate * dtMs) / 1000);
    }
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
