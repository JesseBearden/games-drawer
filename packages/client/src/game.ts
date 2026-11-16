import { deathsAllowed, moveSpeed, spreadReady, type ChatMessage, type ServerMessage } from '@tank/shared';
import { Camera } from './camera';
import { Input } from './input';
import type { Net } from './net';
import { Renderer } from './renderer';
import type { Sprites } from './sprites';
import { colorCss, escapeHtml, GameState } from './state';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const EMPTY_HEART =
  '<svg viewBox="0 0 64 58" aria-hidden="true"><path d="M32 52 C14 40 5 30 5 18 C5 10 11 5 18 5 C24 5 29 9 32 13 C35 9 40 5 46 5 C53 5 59 10 59 18 C59 30 50 40 32 52 Z" fill="rgba(20,26,74,0.35)" stroke="#fff" stroke-width="5" stroke-linejoin="round"/></svg>';

export interface Device {
  touch: boolean;
  small: boolean;
}

export class GameApp {
  state: GameState;
  private renderer: Renderer;
  readonly camera: Camera;
  private input: Input;
  private raf = 0;
  private lastFrame = performance.now();
  private lastAimSent = 0;
  private aimDirty = false;
  private pingTimer: number;
  private hud = { hearts: '', level: '', angle: '', power: '', wind: '', status: '', spread: false, move: false, drop: false, fire: '' };
  private scoresOpen = false;
  private chatOpen: boolean;
  private unread = 0;
  private disposed = false;
  private bannerTimer: number | undefined;

  constructor(
    welcome: Welcome,
    private net: Net,
    private sprites: Sprites,
    private device: Device,
    private onLeave: () => void,
  ) {
    const gameEl = $('game');
    gameEl.classList.toggle('phone', device.small);
    this.chatOpen = !device.small;
    gameEl.classList.toggle('chat-collapsed', !this.chatOpen);
    $('touch').hidden = !device.touch;
    $('chat-log').innerHTML = '';

    this.state = this.makeState(welcome);
    this.camera = new Camera(welcome.config);
    this.camera.mode = device.small ? 'follow' : 'overview';
    this.renderer = new Renderer($<HTMLCanvasElement>('canvas'), sprites, welcome.config);
    this.input = new Input(
      {
        gameplayPress: () => this.tryDrop(),
        fire: () => this.fire(),
        setMove: (dir) => this.net.send({ t: 'move', dir }),
        aimChanged: () => (this.aimDirty = true),
      },
      $('touch'),
    );
    this.adoptServerAim();

    this.bindUi(welcome);
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.pingTimer = window.setInterval(() => this.net.send({ t: 'ping', at: performance.now() }), 2000);
    this.raf = requestAnimationFrame(this.frame);
    if (welcome.reclaimed) this.toast('Welcome back! You reclaimed your tank.');
  }

  private makeState(w: Welcome) {
    return new GameState(w, {
      feed: (html) => this.feed(html),
      toast: (t) => this.toast(t),
      banner: (html) => this.banner(html),
      chat: (m) => this.addChat(m),
      resync: (reason) => {
        console.warn('Resyncing:', reason);
        this.net.resync();
      },
      infoChanged: () => {
        if (this.scoresOpen) this.renderScores();
      },
    });
  }

  /** After a reconnect the server sends a fresh snapshot. */
  rewelcome(w: Welcome) {
    $('chat-log').innerHTML = '';
    this.state = this.makeState(w);
    this.adoptServerAim();
    $('reconnect').hidden = true;
    this.toast(w.reclaimed ? 'Reconnected. Your tank is back under your control.' : 'Reconnected.');
    this.updateRoomInfo(w);
  }

  private adoptServerAim() {
    const me = this.state.me;
    const last = me?.samples.at(-1);
    if (last) this.input.angle = last.angle;
  }

  onMessage(msg: ServerMessage) {
    if (msg.t === 'welcome') {
      this.rewelcome(msg);
      return;
    }
    if (msg.t === 'name') {
      ($<HTMLInputElement>('menu-name')).value = msg.name;
      try {
        localStorage.setItem('tank.name', msg.name);
      } catch {
        /* ignore */
      }
    }
    this.state.onMessage(msg);
  }

  showReconnecting() {
    $('reconnect').hidden = false;
  }

  // ------------------------------------------------------------------ actions

  private latestPhase() {
    return this.state.me?.samples.at(-1)?.phase;
  }

  private tryDrop(): boolean {
    if (this.latestPhase() === 'carried') {
      this.net.send({ t: 'drop' });
      return true;
    }
    return false;
  }

  private fire() {
    this.net.send({ t: 'fire', angle: this.input.angle, power: this.input.power });
    this.aimDirty = false;
  }

  // ------------------------------------------------------------------ frame

  private frame = (now: number) => {
    if (this.disposed) return;
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    this.input.update(dt);
    if (this.aimDirty && now - this.lastAimSent > 80) {
      this.net.send({ t: 'aim', angle: this.input.angle, power: this.input.power });
      this.lastAimSent = now;
      this.aimDirty = false;
    }
    const g = this.state;
    g.update(now);
    const me = g.me;
    let target = null;
    if (me) {
      if (me.phase === 'dead') {
        target = null;
      } else {
        target = { x: me.x, y: me.y };
      }
    }
    let deepest = 0;
    for (const c of g.terrain.cols) if (c[0] > deepest) deepest = c[0];
    this.camera.update(this.renderer.viewW, this.renderer.viewH, target, deepest, dt);
    this.renderer.draw(g, this.camera, { angle: this.input.angle, power: this.input.power }, now);
    this.updateHud();
    this.raf = requestAnimationFrame(this.frame);
  };

  private onResize = () => {
    this.renderer.resize();
  };

  // ------------------------------------------------------------------ HUD

  private set<K extends keyof GameApp['hud']>(key: K, value: GameApp['hud'][K], apply: () => void) {
    if (this.hud[key] === value) return;
    this.hud[key] = value;
    apply();
  }

  private updateHud() {
    const g = this.state;
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
        $('level-line').textContent = `LV ${info.level} · ${info.kills} ${info.kills === 1 ? 'kill' : 'kills'}`;
      });
      this.set('spread', spreadReady(info), () => {
        $('spread-badge').hidden = !spreadReady(info);
        $('fire-btn').classList.toggle('spread', spreadReady(info));
      });
      const canMove = moveSpeed(cfg, info.level) > 0;
      this.set('move', canMove, () => ($('move-row').hidden = !canMove));

      const phase = me.phase;
      let status = '';
      if (phase === 'carried') status = this.device.touch ? '' : 'Press any key to drop';
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
      const showDrop = this.device.touch && phase === 'carried';
      this.set('drop', showDrop, () => ($('drop-btn').hidden = !showDrop));
      const fireState = phase === 'carried' ? 'drop' : info.shellsInFlight > 0 || !(phase === 'ground' || phase === 'slide') ? 'busy' : 'ready';
      this.set('fire', fireState, () => {
        const btn = $<HTMLButtonElement>('fire-btn');
        btn.textContent = fireState === 'drop' ? 'DROP' : 'FIRE';
        btn.disabled = fireState === 'busy';
      });
    }
    this.set('angle', `${Math.round(this.input.angle)}`, () => ($('aim-angle').textContent = `${Math.round(this.input.angle)}°`));
    this.set('power', `${Math.round(this.input.power)}`, () => ($('aim-power').textContent = `${Math.round(this.input.power)}%`));
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

  toast(text: string) {
    const el = document.createElement('div');
    el.textContent = text;
    const box = $('toasts');
    box.append(el);
    while (box.children.length > 3) box.firstElementChild!.remove();
    setTimeout(() => el.remove(), 3500);
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

  // ------------------------------------------------------------------ chat

  private addChat(m: ChatMessage) {
    const li = document.createElement('li');
    const time = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (m.system) {
      li.className = 'system';
      li.innerHTML = `<span class="time">${time}</span>${escapeHtml(m.text)}`;
    } else {
      li.innerHTML = `<span class="time">${time}</span><span class="who" style="color:${colorCss(m.color)}">${escapeHtml(m.from)}:</span> ${escapeHtml(m.text)}`;
    }
    const log = $('chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(li);
    while (log.children.length > 200) log.firstElementChild!.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
    if (!this.chatOpen && !m.system) {
      this.unread++;
      $('chat-unread').hidden = false;
    }
  }

  private setChatOpen(open: boolean) {
    this.chatOpen = open;
    $('game').classList.toggle('chat-collapsed', !open);
    if (open) {
      this.unread = 0;
      $('chat-unread').hidden = true;
      const log = $('chat-log');
      log.scrollTop = log.scrollHeight;
    }
    // The arena changes size on desktop.
    requestAnimationFrame(() => this.renderer.resize());
  }

  // ------------------------------------------------------------------ UI wiring

  private updateRoomInfo(w: Welcome) {
    const priv = w.room.kind === 'private';
    $('btn-share').hidden = !priv;
    $('menu-room').textContent = priv ? `Private room ${w.room.code} — share the invite link to bring friends.` : 'Public room.';
    const path = priv ? `/r/${w.room.code}` : '/';
    if (location.pathname !== path) history.replaceState(null, '', path);
  }

  private bindUi(w: Welcome) {
    this.updateRoomInfo(w);
    ($<HTMLInputElement>('menu-name')).value = w.name;

    const on = (id: string, fn: (e: Event) => void) => {
      const el = $(id);
      el.addEventListener('click', fn);
      this.cleanups.push(() => el.removeEventListener('click', fn));
    };
    on('btn-chat', () => this.setChatOpen(true));
    on('chat-collapse', () => this.setChatOpen(false));
    on('btn-zoom', () => this.toggleZoom());
    on('btn-fullscreen', () => this.toggleFullscreen());
    on('btn-scores', () => this.toggleScores());
    on('btn-share', () => this.share());
    on('btn-menu', () => this.openMenu(true));
    on('menu-close', () => this.openMenu(false));
    on('menu-leave', () => this.onLeave());
    on('menu-name-save', () => {
      const name = ($<HTMLInputElement>('menu-name')).value;
      this.net.send({ t: 'name', name });
    });
    on('drop-btn', () => this.tryDrop());
    on('scores', () => this.toggleScores());

    const form = $<HTMLFormElement>('chat-form');
    const submit = (e: Event) => {
      e.preventDefault();
      const input = $<HTMLInputElement>('chat-input');
      const text = input.value.trim();
      if (text) this.net.send({ t: 'chat', text });
      input.value = '';
      if (this.device.small) {
        input.blur();
      }
    };
    form.addEventListener('submit', submit);
    this.cleanups.push(() => form.removeEventListener('submit', submit));

    const keys = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT';
      if (typing) {
        if (e.key === 'Escape') {
          target.blur();
          if (this.device.small) this.setChatOpen(false);
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!this.chatOpen) this.setChatOpen(true);
        $<HTMLInputElement>('chat-input').focus();
      } else if (e.code === 'Tab') {
        e.preventDefault();
        this.toggleScores();
      } else if (e.code === 'KeyZ') {
        this.toggleZoom();
      } else if (e.code === 'KeyF') {
        this.toggleFullscreen();
      } else if (e.key === 'Escape') {
        if (this.scoresOpen) this.toggleScores();
        else this.openMenu($('menu').hidden);
      }
    };
    window.addEventListener('keydown', keys);
    this.cleanups.push(() => window.removeEventListener('keydown', keys));

    // Tapping the battlefield while on the helicopter also drops (phones).
    const canvas = $('canvas');
    const tap = () => {
      if (this.device.touch) this.tryDrop();
    };
    canvas.addEventListener('pointerdown', tap);
    this.cleanups.push(() => canvas.removeEventListener('pointerdown', tap));
  }

  private cleanups: (() => void)[] = [];

  private toggleZoom() {
    this.camera.mode = this.camera.mode === 'follow' ? 'overview' : 'follow';
    this.toast(this.camera.mode === 'follow' ? 'Zoomed in on your tank' : 'Whole battlefield');
  }

  private toggleFullscreen() {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document);
      return;
    }
    if (el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).then(
        () => {
          const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
          o.lock?.('landscape').catch(() => {});
        },
        () => this.fullscreenHelp(),
      );
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    } else {
      this.fullscreenHelp();
    }
  }

  private fullscreenHelp() {
    this.toast('On iPhone: tap Share, then "Add to Home Screen" to play fullscreen.');
  }

  private async share() {
    const url = location.href;
    const data = { title: 'Tank You For Being A Friend', text: 'Come blow me up. Tap to join my tank battle:', url };
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share && (!nav.canShare || nav.canShare(data))) {
      try {
        await nav.share(data);
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Invite link copied!');
    } catch {
      this.toast(`Invite link: ${url}`);
    }
  }

  private openMenu(open: boolean) {
    $('menu').hidden = !open;
    this.input.enabled = !open;
    if (open) this.input.releaseAll();
  }

  private toggleScores() {
    this.scoresOpen = !this.scoresOpen;
    $('scores').hidden = !this.scoresOpen;
    if (this.scoresOpen) this.renderScores();
  }

  private renderScores() {
    const rows = [...this.state.tanks.values()].sort((a, b) => b.info.level - a.info.level || b.info.kills - a.info.kills);
    const cfg = this.state.cfg;
    let html = '<table><thead><tr><th>Tank</th><th>LV</th><th>Kills</th><th>Lives</th></tr></thead><tbody>';
    for (const t of rows) {
      const i = t.info;
      const lives = deathsAllowed(cfg, i) - i.deaths;
      const who = i.controller === 'bot' ? (i.away ? ' <small>(away)</small>' : ' <small>(bot)</small>') : '';
      html += `<tr class="${i.id === this.state.myTankId ? 'me' : ''}"><td><span class="dot" style="background:${colorCss(i.color)}"></span>${escapeHtml(i.name)}${who}</td><td>${i.level}</td><td>${i.kills}</td><td>${'♥'.repeat(Math.max(0, lives))}</td></tr>`;
    }
    html += '</tbody></table>';
    $('scores').innerHTML = html;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.pingTimer);
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    for (const c of this.cleanups) c();
    this.cleanups = [];
    $('menu').hidden = true;
    $('scores').hidden = true;
    $('reconnect').hidden = true;
    $('banner').hidden = true;
  }
}
