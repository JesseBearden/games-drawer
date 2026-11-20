import { deathsAllowed, moveSpeed, spreadReady, spreadSize, type GameServerMessage, type TankServerMessage } from '@tank/shared';
import type { PlayOptions, SoundName } from './audio';
import { Camera } from './camera';
import { Input } from './input';
import { Renderer } from './renderer';
import type { Sprites } from './sprites';
import { colorCss, escapeHtml, GameState, type TankInit } from './state';
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

const EMPTY_HEART =
  '<svg viewBox="0 0 64 58" aria-hidden="true"><path d="M32 52 C14 40 5 30 5 18 C5 10 11 5 18 5 C24 5 29 9 32 13 C35 9 40 5 46 5 C53 5 59 10 59 18 C59 30 50 40 32 52 Z" fill="rgba(17,40,117,0.12)" stroke="#112875" stroke-opacity=".45" stroke-width="4" stroke-dasharray="6 5" stroke-linejoin="round"/></svg>';

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
  private bannerTimer: number | undefined;
  private speaking = new Set<string>();
  private lastTick = { angle: NaN, power: NaN };
  private cleanups: (() => void)[] = [];

  constructor(
    private shell: ShellApi,
    private sprites: Sprites,
  ) {
    $('tank-view').hidden = false;
    $('touch').hidden = !shell.device.touch;
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
    // Tapping the battlefield while on the helicopter also drops (phones).
    const canvas = $('canvas');
    const tap = () => {
      if (this.shell.device.touch) this.tryDrop();
    };
    canvas.addEventListener('pointerdown', tap);
    this.cleanups.push(() => canvas.removeEventListener('pointerdown', tap));
    const scores = $('scores');
    const toggle = () => this.toggleScores();
    scores.addEventListener('click', toggle);
    this.cleanups.push(() => scores.removeEventListener('click', toggle));
    window.addEventListener('resize', this.onResize);
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
    if (!this.renderer) {
      this.camera = new Camera(init.config);
      this.camera.zoomIndex = 0;
      this.renderer = new Renderer($<HTMLCanvasElement>('canvas'), this.sprites, init.config);
      this.renderer.resize();
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

  private onResize = () => this.renderer?.resize();

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
    if (g && this.camera && this.renderer) {
      g.update(now);
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
      // On touch screens the corner control pads cover roughly the bottom 70px.
      this.camera.update(this.renderer.viewW, this.renderer.viewH, target, deepest, dt, this.shell.device.touch ? 70 : 0, Number.isFinite(highest) ? highest : deepest);
      this.renderer.draw(g, this.camera, { angle: this.input.angle, power: this.input.power }, now);
      this.updateAmbience();
      this.updateHud(g);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  // ------------------------------------------------------------------ HUD

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
      let status = '';
      if (phase === 'carried') status = this.shell.device.touch ? '' : 'Press any key to drop';
      else if (phase === 'chute') status = 'Parachuting in (protected)';
      else if (phase === 'dead') status = g.match.state === 'won' ? '' : 'Respawning…';
      else if (info.protectedUntil > g.renderTick) {
        const secs = Math.min(cfg.spawnProtectionSeconds, Math.ceil((info.protectedUntil - g.renderTick) / cfg.tickRate));
        status = `Protected ${secs}s (ends when you fire)`;
      } else if (info.away) status = 'A bot is driving';
      this.set('status', status, () => {
        $('status').hidden = !status;
        $('status').textContent = status;
      });
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
    const el = document.createElement('div');
    el.innerHTML = html;
    const feed = $('feed');
    feed.prepend(el);
    while (feed.children.length > 5) feed.lastElementChild!.remove();
    setTimeout(() => el.remove(), 6000);
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
    this.shell.sfx.setAmbience(0, 0);
    clearTimeout(this.bannerTimer);
    $('scores').hidden = true;
    $('banner').hidden = true;
    $('status').hidden = true;
    $('feed').innerHTML = '';
    $('tank-view').hidden = true;
    const canvas = $<HTMLCanvasElement>('canvas');
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }
}
