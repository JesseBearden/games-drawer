import { deathsAllowed, moveSpeed, spreadReady, spreadSize, type GameServerMessage, type TankServerMessage } from '@tank/shared';
import type { PlayOptions, SoundName } from './audio';
import { Camera } from './camera';
import { Input } from './input';
import { Renderer } from './renderer';
import { tankSprites, tankSpritesNow, type Sprites } from './sprites';
import { TANK_SOUNDS } from './audio';
import { colorCss, escapeHtml } from './html';
import { GameState, type TankInit } from './state';
import type { ShellApi, View } from './views';
import type { PadButton, PadPress } from './gamepad';
import type { Action } from './input';

const PAD_ACTIONS: Partial<Record<PadButton, Action>> = {
  a: 'fire',
  left: 'angle-left',
  right: 'angle-right',
  up: 'power-up',
  down: 'power-down',
  lb: 'move-left',
  lt: 'move-left',
  rb: 'move-right',
  rt: 'move-right',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** A lost life: the felt heart's outline. */
const EMPTY_HEART = '<img src="/sprites/heart-empty.png" alt="" />';

/** The artillery game: battlefield canvas, HUD and controls. */
export class TankView implements View {
  readonly landscape = true;
  readonly helpHtml =
    '<p>Aim, set your power and fire. The wind bends every shot, so watch the windsock. Each knock-out levels you up; level 10 wins.</p><p><b>Phone or tablet:</b> the buttons on screen aim, set power and fire.</p><p><b>Computer:</b> ←/→ aim, ↑/↓ power, Space fire, A/D move (from level 4), Tab scores.</p><p><b>Controller:</b> left stick or d-pad aims and sets power, A fires, bumpers or triggers drive, View shows scores.</p><p><b>Drop:</b> any game key or button releases you from the helicopter.</p>';
  state: GameState | null = null;
  private renderer: Renderer | null = null;
  camera: Camera | null = null;
  private input: Input;
  private raf = 0;
  private lastFrame = performance.now();
  private lastAimSent = 0;
  private aimDirty = false;
  private hud = { hearts: '', level: '', angle: '', power: '', wind: '', status: '', spread: '', move: false, fire: '' };
  private scoresOpen = false;
  private disposed = false;
  private artTimer: number | undefined;
  private bannerTimer: number | undefined;
  private speaking = new Set<string>();
  private lastTick = { angle: NaN, power: NaN };
  private cleanups: (() => void)[] = [];

  constructor(private shell: ShellApi) {
    shell.sfx.preloadSounds(TANK_SOUNDS);
    $('tank-view').hidden = false;
    // The control strip shows on every device (a computer can use it with the mouse, or the keys).
    $('touch').hidden = false;
    this.resetHud();
    this.input = new Input(
      {
        gameplayPress: () => this.tryDrop(),
        fire: () => this.fire(),
        setMove: (dir) => this.shell.sendGame({ t: 'move', dir }),
        aimChanged: () => {
          this.aimDirty = true;
          this.aimTick();
        },
      },
      $('touch'),
    );
    // On a touch screen you drop with the Drop button itself, not a tap on the battlefield: a
    // swipe there tucks the browser's bars away, and that mustn't drop you too (user, 2026-11-23).
    const scores = $('scores');
    const toggle = () => this.toggleScores();
    scores.addEventListener('click', toggle);
    this.cleanups.push(() => scores.removeEventListener('click', toggle));
    window.addEventListener('resize', this.onResize);
    // A phone held sideways: the lives tag sits in the top row beside your mic tab, so it needs to
    // know how wide that is (its words change).
    const mic = document.getElementById('btn-mic');
    if (mic && 'ResizeObserver' in window) {
      const view = $('tank-view');
      const ro = new ResizeObserver(() => {
        view.style.setProperty('--mic-w', `${mic.offsetWidth}px`);
        this.inset = -1;
      });
      ro.observe(mic);
      this.cleanups.push(() => ro.disconnect());
    }
    // In a phone's browser (not opened from the home screen icon), a swipe on the battlefield
    // scrolls the page a little, so the browser tucks its tabs and address bar away (user,
    // 2026-11-23; styles.css "tuck-bars", and main.ts leaves that scroll alone).
    const homeScreen = () => matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (shell.device.small && !homeScreen()) {
      document.documentElement.classList.add('tuck-bars');
      this.cleanups.push(() => {
        document.documentElement.classList.remove('tuck-bars');
        window.scrollTo(0, 0);
      });
      this.hintTimer = window.setTimeout(() => this.maybeHint(), 700);
    }
    // Turning a sideways phone right round swaps which side the notch is on (no resize then).
    if (shell.device.small) {
      const turned = () =>
        window.setTimeout(() => {
          if (this.disposed) return;
          this.onResize();
          this.maybeHint();
        }, 300);
      window.addEventListener('orientationchange', turned);
      this.cleanups.push(() => window.removeEventListener('orientationchange', turned));
      this.fitSides();
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------ messages

  onGameMessage(m: GameServerMessage) {
    if (m.t === 'init') {
      this.start(m);
      return;
    }
    if (m.t === 'hearts') return;
    this.state?.onMessage(m as TankServerMessage);
  }

  private start(init: TankInit) {
    if (!this.camera) {
      this.camera = new Camera(init.config);
      this.camera.zoomIndex = 0;
      this.loadArt(init);
    }
    this.state = new GameState(init, {
      feed: (html) => this.feed(html),
      toast: (t) => this.shell.toast(t),
      banner: (html) => this.banner(html),
      resync: (reason) => {
        console.warn('Resyncing:', reason);
        this.shell.sendGame({ t: 'resync' });
      },
      infoChanged: () => {
        this.applySpeaking();
        if (this.scoresOpen) this.renderScores();
      },
      sound: (name, at, opts) => this.playAt(name, at, opts),
    });
    this.state.touch = this.shell.device.touch;
    this.applySpeaking();
    const last = this.state.me?.samples.at(-1);
    if (last) this.input.angle = last.angle;
    if (init.reclaimed) this.shell.toast('Welcome back! You reclaimed your tank.');
  }

  /**
   * The battlefield draws once its pictures are in (the game itself starts right away). If they
   * can't be fetched, say so and try again shortly instead of leaving a blank field.
   */
  private loadArt(init: TankInit, tries = 0) {
    if (this.disposed) return;
    const ready = tankSpritesNow();
    if (ready) {
      this.useArt(ready, init);
      return;
    }
    tankSprites().then(
      (sprites) => {
        if (this.disposed || this.renderer) return;
        this.useArt(sprites, init);
        // The ground was textured before its felt pictures were in: texture it again with them.
        const g = this.state;
        if (g) g.terrainView.reset(g.terrain);
      },
      () => {
        if (this.disposed) return;
        if (tries === 0) this.shell.toast('Still loading the battlefield…');
        this.artTimer = window.setTimeout(() => this.loadArt(init, tries + 1), Math.min(10_000, 1000 * 2 ** tries));
      },
    );
  }

  private useArt(sprites: Sprites, init: TankInit) {
    this.renderer = new Renderer($<HTMLCanvasElement>('canvas'), sprites, init.config);
    this.renderer.resize();
  }

  onSpeaking(aliases: Set<string>) {
    this.speaking = aliases;
    this.applySpeaking();
  }

  private applySpeaking() {
    const g = this.state;
    if (!g) return;
    const ids = new Set<number>();
    for (const t of g.tanks.values()) if (t.info.ownerAlias && this.speaking.has(t.info.ownerAlias)) ids.add(t.info.id);
    g.speaking = ids;
  }

  onPong(at: number) {
    this.state?.onPong(at);
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.code === 'Tab') {
      e.preventDefault();
      this.toggleScores();
      return true;
    }
    if (e.key === 'Escape' && this.scoresOpen) {
      this.toggleScores();
      return true;
    }
    return false;
  }

  /** Controller: A fires, d-pad aims and sets power, bumpers or triggers drive, View shows scores. */
  onPad(p: PadPress, down: boolean): boolean {
    if (p.button === 'view') {
      if (down) this.toggleScores();
      return true;
    }
    if (p.repeat) return true;
    // The stick is read every frame as an analog aim (see frame); pushing it also drops you.
    if (p.stick) {
      if (down) this.input.anyPress();
      return true;
    }
    const act = PAD_ACTIONS[p.button];
    if (act) {
      if (down) this.input.press(act);
      else this.input.release(act);
      return true;
    }
    if (down && p.button !== 'menu') this.input.anyPress();
    return p.button !== 'menu';
  }

  setPaused(paused: boolean) {
    this.input.enabled = !paused;
    if (paused) this.input.releaseAll();
  }

  resize() {
    this.renderer?.resize();
  }

  private onResize = () => {
    this.renderer?.resize();
    this.inset = -1;
    this.camera?.snap();
    this.fitSides();
    // They swiped the bars away while the hint was up: it's done its job.
    if (this.hintShowing && !this.barsShowing()) this.hideHint();
  };

  /**
   * An iPhone held sideways in Safari, with its tabs and address bar showing: say once, briefly,
   * that a swipe up tucks them away (user, 2026-11-23). Faint, across the middle, and taps go
   * straight through it. Held upright at first, it waits for the phone to be turned.
   */
  private hinted = false;
  private hintShowing = false;
  private hintTimer: number | undefined;
  private barsShowing() {
    // iPhones report the screen's size held upright, so its width is the height there is to fill.
    return window.innerHeight < Math.min(screen.width, screen.height) - 30;
  }
  private maybeHint() {
    if (this.hinted || this.disposed || !document.documentElement.classList.contains('tuck-bars')) return;
    if (!/iPhone|iPod/.test(navigator.userAgent) || !matchMedia('(orientation: landscape)').matches) return;
    this.hinted = true;
    const el = document.getElementById('swipe-hint');
    if (!el || !this.barsShowing()) return;
    el.hidden = false;
    el.classList.remove('gone');
    this.hintShowing = true;
    this.hintTimer = window.setTimeout(() => this.hideHint(), 2800);
  }
  private hideHint() {
    const el = document.getElementById('swipe-hint');
    clearTimeout(this.hintTimer);
    this.hintShowing = false;
    if (!el) return;
    el.classList.add('gone');
    this.hintTimer = window.setTimeout(() => (el.hidden = true), 450);
  }

  /**
   * How much of the battlefield the control strip covers: from the bottom, or from the right when
   * it runs down the side (a phone held sideways). Measured, then kept until a resize.
   */
  private inset = -1;
  private insetRight = 0;
  /** With the strip down the side, the row of tags along the top (lives, wind) is kept clear too. */
  private insetTop = 0;
  private stripInset() {
    if (this.inset < 0) {
      const strip = $('touch').getBoundingClientRect();
      const canvas = $('canvas').getBoundingClientRect();
      const side = strip.height > strip.width;
      this.inset = strip.height && !side ? Math.max(0, canvas.bottom - strip.top + 6) : 0;
      this.insetRight = strip.height && side ? Math.max(0, canvas.right - strip.left + 6) : 0;
      this.insetTop = 0;
      // The swipe hint centres on the battlefield, not on the strip beside it.
      document.getElementById('tank-view')?.style?.setProperty('--field-r', `${this.insetRight}px`);
      if (strip.height && side) {
        const lives = document.querySelector('#tank-view .hud-top-left')?.getBoundingClientRect();
        const wind = $('wind').getBoundingClientRect();
        for (const r of [lives, wind]) if (r && r.height) this.insetTop = Math.max(this.insetTop, r.bottom - canvas.top + 4);
        // Messages show one at a time in the top row, centred in the gap between the lives tag
        // and the wind (table.css; user, 2026-11-23).
        const arena = $('arena');
        const a = arena.getBoundingClientRect();
        if (lives?.width && wind.width && wind.left > lives.right) {
          arena.style?.setProperty('--pop-x', `${(lives.right + wind.left) / 2 - a.left}px`);
          arena.style?.setProperty('--pop-w', `${Math.max(160, wind.left - lives.right - 12)}px`);
        }
      }
    }
    return this.inset;
  }

  // ------------------------------------------------------------------ sound

  /** Play a sound, panned by where it happens on screen and quieter when off-screen. */
  private playAt(name: SoundName, at?: { x: number; y: number }, opts: PlayOptions = {}) {
    if (!this.camera || !this.renderer) return;
    let pan = 0;
    let volume = 1;
    if (at) {
      const p = this.camera.toScreen(at);
      const vw = this.renderer.viewW;
      const vh = this.renderer.viewH;
      pan = Math.max(-1, Math.min(1, (p.x / vw) * 2 - 1)) * 0.8;
      const dx = p.x < 0 ? -p.x : p.x > vw ? p.x - vw : 0;
      const dy = p.y < 0 ? -p.y : p.y > vh ? p.y - vh : 0;
      volume = Math.max(0.15, 1 - (Math.hypot(dx, dy) / Math.max(vw, vh)) * 1.6);
    }
    this.shell.sfx.play(name, { ...opts, pan: opts.pan ?? pan, volume: (opts.volume ?? 1) * volume });
  }

  /** A soft click for each whole degree or half percent while aiming. */
  private aimTick() {
    const angle = Math.round(this.input.angle);
    const power = Math.round(this.input.power * 2);
    if (angle === this.lastTick.angle && power === this.lastTick.power) return;
    this.lastTick = { angle, power };
    this.shell.sfx.play('tick');
  }

  /** Helicopter rotors get louder the closer they are to the screen; wind follows wind speed. */
  private updateAmbience() {
    if (!this.state || !this.camera || !this.renderer) return;
    const vw = this.renderer.viewW;
    const vh = this.renderer.viewH;
    let rotor = 0;
    for (const h of this.state.helis.values()) {
      const p = this.camera.toScreen(h);
      const dx = p.x < 0 ? -p.x : p.x > vw ? p.x - vw : 0;
      const dy = p.y < 0 ? -p.y : p.y > vh ? p.y - vh : 0;
      rotor = Math.max(rotor, 1 - (Math.hypot(dx, dy) / Math.max(vw, vh)) * 2.5);
    }
    this.shell.sfx.setAmbience(rotor, Math.abs(this.state.wind) / this.state.cfg.windMaxSpeed);
  }

  // ------------------------------------------------------------------ actions

  private tryDrop(): boolean {
    if (this.state?.me?.samples.at(-1)?.phase === 'carried') {
      this.shell.sendGame({ t: 'drop' });
      return true;
    }
    return false;
  }

  private fire() {
    this.shell.sendGame({ t: 'fire', angle: this.input.angle, power: this.input.power });
    this.aimDirty = false;
  }

  // ------------------------------------------------------------------ frame

  private frame = (now: number) => {
    if (this.disposed) return;
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    this.input.update(dt);
    const pad = this.shell.pads?.state;
    if (pad) this.input.analog(pad.lx, pad.ly, dt);
    if (this.aimDirty && now - this.lastAimSent > 80) {
      this.shell.sendGame({ t: 'aim', angle: this.input.angle, power: this.input.power });
      this.lastAimSent = now;
      this.aimDirty = false;
    }
    const g = this.state;
    if (g) {
      // The game runs, and the hearts, wind and Drop show, while the pictures are still downloading.
      g.update(now);
      if (this.camera && this.renderer) {
        const me = g.me;
        const target = me && me.phase !== 'dead' ? { x: me.x, y: me.y } : null;
        let deepest = 0;
        let highest = Infinity;
        for (const c of g.terrain.cols) {
          if (c[0] > deepest) deepest = c[0];
          if (c[0] < highest) highest = c[0];
        }
        // Riding in the helicopter (or floating down): keep it in view, to see where you'll land.
        if (me && (me.phase === 'carried' || me.phase === 'chute')) highest = Math.min(highest, me.y);
        // The screen changed size (Safari's bars tucking away grow it over a few frames): follow
        // it frame by frame, without easing, so the battlefield doesn't stretch or wobble.
        if (this.renderer.syncSize()) {
          this.inset = -1;
          this.camera.snap();
        }
        // On touch screens the corner control pads cover roughly the bottom 70px.
        this.camera.update(this.renderer.viewW, this.renderer.viewH, target, deepest, dt, this.stripInset(), Number.isFinite(highest) ? highest : deepest, this.insetRight, this.insetTop);
        this.renderer.draw(g, this.camera, { angle: this.input.angle, power: this.input.power }, now);
        this.updateAmbience();
      }
      this.updateHud(g);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  // ------------------------------------------------------------------ HUD

  /** Every Tanks screen uses the same elements: start them as the empty `hud` says they are. */
  private resetHud() {
    $('move-row').hidden = true;
    $('spread-badge').hidden = true;
    $('spread-badge').textContent = '';
    const fire = $<HTMLButtonElement>('fire-btn');
    fire.classList.remove('spread', 'drop');
    fire.textContent = 'Fire';
    fire.disabled = false;
  }

  private set<K extends keyof TankView['hud']>(key: K, value: TankView['hud'][K], apply: () => void) {
    if (this.hud[key] === value) return;
    this.hud[key] = value;
    apply();
  }

  private updateHud(g: GameState) {
    const me = g.me;
    const cfg = g.cfg;
    if (me) {
      const info = me.info;
      const total = deathsAllowed(cfg, info);
      const left = Math.max(0, total - info.deaths);
      this.set('hearts', `${left}/${total}`, () => {
        let html = '';
        for (let i = 0; i < total; i++) html += i < left ? `<img src="/sprites/heart.png" alt="" />` : EMPTY_HEART;
        $('hearts').innerHTML = html;
        $('hearts').setAttribute('aria-label', `${left} of ${total} lives left`);
      });
      this.set('level', `${info.level}|${info.kills}`, () => {
        $('level-line').textContent = `LV ${info.level} / ${cfg.winLevel} · ${info.kills} ${info.kills === 1 ? 'kill' : 'kills'}`;
        this.inset = -1; // the lives tag's width changed: measure the pop-up gap again
      });
      const ready = spreadReady(info) ? (spreadSize(info.level) === 5 ? 'QUINTUPLE READY' : 'TRIPLE READY') : '';
      this.set('spread', ready, () => {
        if (ready) this.shell.sfx.play('spreadReady');
        $('spread-badge').hidden = !ready;
        $('spread-badge').textContent = ready;
        $('fire-btn').classList.toggle('spread', !!ready);
      });
      const canMove = moveSpeed(cfg, info.level) > 0;
      this.set('move', canMove, () => ($('move-row').hidden = !canMove));

      const phase = me.phase;
      // (No "Protected" line: the bubble round your tank says it, and blinks as it runs out. User,
      // 2026-11-23.)
      let status = '';
      if (phase === 'carried') status = this.shell.device.touch ? '' : 'Press any key to drop';
      else if (phase === 'dead') status = g.match.state === 'won' ? '' : 'Respawning…';
      else if (info.away && phase !== 'chute') status = 'A bot is driving';
      this.set('status', status, () => this.paintSlot());
      const fireState = phase === 'carried' ? 'drop' : info.shellsInFlight > 0 || !(phase === 'ground' || phase === 'slide') ? 'busy' : 'ready';
      this.set('fire', fireState, () => {
        const btn = $<HTMLButtonElement>('fire-btn');
        btn.textContent = fireState === 'drop' ? 'Drop' : 'Fire';
        btn.classList.toggle('drop', fireState === 'drop');
        btn.disabled = fireState === 'busy';
      });
    }
    this.set('angle', `${Math.round(this.input.angle)}`, () => ($('aim-angle').textContent = `${Math.round(this.input.angle)}°`));
    const pw = Math.round(this.input.power * 2) / 2;
    this.set('power', `${pw}`, () => ($('aim-power').textContent = `${pw % 1 ? pw.toFixed(1) : pw}%`));
    const w = g.wind;
    this.set('wind', `${w}`, () => {
      const img = $<HTMLImageElement>('windsock');
      img.src = w === 0 ? '/sprites/windsock-calm.png' : '/sprites/windsock.png';
      img.classList.toggle('left', w < 0);
      $('wind-speed').textContent = `${Math.abs(w)}`;
      const dir = w === 0 ? 'calm' : w > 0 ? 'blowing right' : 'blowing left';
      $('wind').setAttribute('aria-label', `Wind ${Math.abs(w)}, ${dir}`);
      $('wind').title = `Wind ${Math.abs(w)}, ${dir}`;
    });
  }

  private feed(html: string) {
    if (this.sideways()) {
      this.queueNote(html);
      return;
    }
    const el = document.createElement('div');
    el.innerHTML = html;
    const feed = $('feed');
    feed.prepend(el);
    while (feed.children.length > 5) feed.lastElementChild!.remove();
    setTimeout(() => el.remove(), 6000);
  }

  // ------------------------------------------------------------------ messages on a sideways phone

  /**
   * On a phone held sideways, every message (who knocked out whom, "Your mic is on", a chat
   * message) waits its turn and shows by itself for a couple of seconds, in the top row between
   * the lives tag and the wind (user, 2026-11-23). In between, that spot shows the status, if any.
   */
  private notes: string[] = [];
  private noteShowing = '';
  private noteTimer: number | undefined;

  /**
   * An iPhone held sideways reports the notch's margin on both sides, but the notch is only on one.
   * When it's on the left, the controls down the right edge only need to clear the rounded corner,
   * so they move out to it (user, 2026-11-23; tanks.css). Android reports only the real side.
   */
  private fitSides() {
    const view = document.getElementById('tank-view');
    if (!view?.style) return;
    view.style.removeProperty('--strip-safe-r');
    if (!this.sideways()) return;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    const left = parseFloat(cs.paddingLeft) || 0;
    const right = parseFloat(cs.paddingRight) || 0;
    probe.remove();
    // 90: turned to the left, so the top of the phone (with the notch) is on the left.
    const angle = (window as { orientation?: number }).orientation ?? screen.orientation?.angle;
    if (left > 20 && Math.abs(left - right) < 1 && angle === 90) view.style.setProperty('--strip-safe-r', '12px');
  }

  private sideways() {
    return this.shell.device.small && matchMedia('(max-height: 500px)').matches;
  }

  showNote(html: string): boolean {
    if (!this.sideways()) return false;
    this.queueNote(html);
    return true;
  }

  private queueNote(html: string) {
    if (html === this.noteShowing || this.notes.includes(html)) return;
    this.notes.push(html);
    // A burst (a nuke's knock-outs) keeps only the latest few waiting.
    while (this.notes.length > 4) this.notes.shift();
    if (!this.noteShowing) this.nextNote();
  }

  private nextNote() {
    this.noteShowing = this.notes.shift() ?? '';
    this.paintSlot();
    if (!this.noteShowing) return;
    // A couple of seconds each; a long message stays up long enough to read.
    const length = $('status').textContent?.length ?? 0;
    this.noteTimer = window.setTimeout(() => this.nextNote(), Math.min(6000, Math.max(2200, 900 + length * 55)));
  }

  /** The status spot: the message showing, or else the status. */
  private paintSlot() {
    const el = $('status');
    const note = this.noteShowing;
    el.hidden = !note && !this.hud.status;
    el.classList.toggle('note', !!note);
    if (note) {
      el.innerHTML = note;
      el.animate?.([{ opacity: 0, transform: 'translate(-50%, -4px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 200, easing: 'ease-out' });
    } else el.textContent = this.hud.status;
  }

  private banner(html: string | null) {
    const el = $('banner');
    clearTimeout(this.bannerTimer);
    if (!html) {
      el.hidden = true;
      return;
    }
    el.innerHTML = html;
    el.hidden = false;
    this.bannerTimer = window.setTimeout(() => (el.hidden = true), 12000);
  }

  private toggleScores() {
    this.scoresOpen = !this.scoresOpen;
    $('scores').hidden = !this.scoresOpen;
    if (this.scoresOpen) this.renderScores();
  }

  private renderScores() {
    const g = this.state;
    if (!g) return;
    const rows = [...g.tanks.values()].sort((a, b) => b.info.level - a.info.level || b.info.kills - a.info.kills);
    let html = '<table><thead><tr><th>Tank</th><th>Level</th><th>Kills</th><th>Lives</th></tr></thead><tbody>';
    for (const t of rows) {
      const i = t.info;
      const lives = deathsAllowed(g.cfg, i) - i.deaths;
      const who = i.controller === 'bot' && i.away ? ' <small>(away)</small>' : '';
      html += `<tr class="${i.id === g.myTankId ? 'me' : ''}"><td><span class="dot" style="background:${colorCss(i.color)}"></span><span class="pc-nm">${escapeHtml(i.name)}</span>${who}</td><td>${i.level}</td><td>${i.kills}</td><td>${Math.max(0, lives)}</td></tr>`;
    }
    html += '</tbody></table>';
    $('scores').innerHTML = html;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.shell.sfx.stopAmbience();
    clearTimeout(this.bannerTimer);
    clearTimeout(this.artTimer);
    clearTimeout(this.hintTimer);
    const hint = document.getElementById('swipe-hint');
    if (hint) hint.hidden = true;
    document.getElementById('tank-view')?.style?.removeProperty('--field-r');
    $('scores').hidden = true;
    $('banner').hidden = true;
    $('status').hidden = true;
    $('feed').innerHTML = '';
    for (const v of ['--pop-x', '--pop-w']) document.getElementById('arena')?.style?.removeProperty(v);
    clearTimeout(this.noteTimer);
    this.notes = [];
    this.noteShowing = '';
    $('status').classList.remove('note');
    $('tank-view').hidden = true;
    const canvas = $<HTMLCanvasElement>('canvas');
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }
}
