import { GAME_NAMES, type ChatMessage, type GameId, type MemberInfo, type ServerMessage } from '@tank/shared';
import { SOUND_NAMES, type PlayOptions, type Sfx, type SoundName } from './audio';
import { HeartsTable } from './heartsView';
import { LobbyView } from './lobby';
import type { Net } from './net';
import type { Sprites } from './sprites';
import { colorCss, escapeHtml } from './state';
import { TankView } from './tankView';
import type { Device, ShellApi, View } from './views';
import { Voice } from './voice';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Everything about being in a room that isn't the game: chat, voice, invites, the menu, and
 * the view on screen (the lobby or a game). Chat and voice keep going when the game changes.
 */
export class RoomApp {
  view: View | null = null;
  gameId: GameId | null = null;
  voice: Voice;
  private alias: string;
  private room: Welcome['room'];
  private membersList: MemberInfo[];
  private chatOpen: boolean;
  private unread = 0;
  private liveChat = false;
  private pingTimer: number;
  private voicePanelOpen = false;
  private speaking = new Set<string>();
  /** Players you muted in this room (alias -> name): their chat is hidden and voice silenced. */
  private mutedPlayers = new Map<string, string>();
  private cleanups: (() => void)[] = [];
  private api: ShellApi;

  constructor(
    welcome: Welcome,
    private net: Net,
    private sprites: Sprites,
    private sfx: Sfx,
    private device: Device,
    private onLeave: () => void,
  ) {
    const gameEl = $('game');
    gameEl.classList.toggle('phone', device.small);
    this.chatOpen = !device.small;
    gameEl.classList.toggle('chat-collapsed', !this.chatOpen);
    $('chat-log').innerHTML = '';
    this.alias = welcome.alias;
    this.room = welcome.room;
    this.membersList = welcome.members;
    this.voice = this.makeVoice(welcome);
    this.api = this.makeApi();
    this.bindUi(welcome);
    for (const m of welcome.chat) this.addChat(m);
    this.liveChat = true;
    this.updateRoomInfo();
    this.renderVoicePanel();
    this.showGame(welcome.game);
    this.pingTimer = window.setInterval(() => this.net.send({ t: 'ping', at: performance.now() }), 2000);
  }

  private makeApi(): ShellApi {
    const shell = this;
    return {
      device: this.device,
      sfx: this.sfx,
      get alias() {
        return shell.alias;
      },
      get roomCode() {
        return shell.room.code;
      },
      get isPrivate() {
        return shell.room.kind === 'private';
      },
      members: () => this.membersList,
      sendGame: (m) => this.net.send({ t: 'g', m }),
      pickGame: (game) => this.net.send({ t: 'pick', game }),
      toLobby: () => this.net.send({ t: 'lobby' }),
      toast: (t) => this.toast(t),
      share: () => void this.share(),
      play: (name, opts) => this.play(name, opts),
      voice: {
        get available() {
          return shell.voice.available;
        },
        get inVoice() {
          return shell.voice.inVoice;
        },
        join: () => void shell.voice.join(),
      },
    };
  }

  private play(name: SoundName | string, opts?: PlayOptions) {
    if ((SOUND_NAMES as string[]).includes(name)) this.sfx.play(name as SoundName, opts);
  }

  // ------------------------------------------------------------------ views

  private showGame(id: GameId | null) {
    this.view?.dispose();
    this.view = null;
    this.gameId = id;
    const gameEl = $('game');
    if (id === 'tanks') this.view = new TankView(this.api, this.sprites);
    else if (id === 'hearts') this.view = new HeartsTable(this.api);
    else this.view = new LobbyView(this.api);
    gameEl.classList.toggle('landscape-only', this.view.landscape);
    gameEl.dataset.view = id ?? 'lobby';
    this.view.onMembers?.(this.membersList);
    this.view.onSpeaking?.(this.speaking);
    $('menu-help').innerHTML = this.view.helpHtml;
    $('menu-lobby').hidden = !(this.room.kind === 'private' && id !== null);
    if (!$('menu').hidden) this.openMenu(false);
    requestAnimationFrame(() => this.view?.resize?.());
  }

  // ------------------------------------------------------------------ messages

  onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome':
        this.rewelcome(msg);
        return;
      case 'game':
        if (msg.game !== this.gameId) this.showGame(msg.game);
        return;
      case 'g':
        this.view?.onGameMessage?.(msg.m);
        return;
      case 'members':
        this.membersList = msg.members;
        this.view?.onMembers?.(msg.members);
        return;
      case 'voice':
        this.voice.onPeers(msg.peers);
        return;
      case 'rtc':
        void this.voice.onSignal(msg.from, msg.data);
        return;
      case 'chat':
        this.addChat(msg.msg);
        return;
      case 'pong':
        this.view?.onPong?.(msg.at);
        return;
      case 'name':
        ($<HTMLInputElement>('menu-name')).value = msg.name;
        try {
          localStorage.setItem('tank.name', msg.name);
        } catch {
          /* ignore */
        }
        return;
      default:
        return;
    }
  }

  /** After a reconnect the server sends a fresh welcome; the game resends its own state. */
  private rewelcome(w: Welcome) {
    $('chat-log').innerHTML = '';
    this.liveChat = false;
    for (const m of w.chat) this.addChat(m);
    this.liveChat = true;
    this.alias = w.alias;
    this.room = w.room;
    this.membersList = w.members;
    $('reconnect').hidden = true;
    this.toast(w.reclaimed ? 'Reconnected. You have your place back.' : 'Reconnected.');
    // Voice rejoins by itself (the mic is still open).
    this.voice.rejoin(w.voice);
    this.renderVoicePanel();
    this.updateRoomInfo();
    // Always rebuild the view: the game will send a fresh start-up message.
    this.showGame(w.game);
  }

  showReconnecting() {
    $('reconnect').hidden = false;
  }

  // ------------------------------------------------------------------ voice chat

  private makeVoice(w: Welcome) {
    const v = new Voice(w.alias, w.voice, {
      send: (m) => this.net.send(m),
      toast: (t) => this.toast(t),
      changed: () => this.renderVoicePanel(),
      speaking: (aliases) => {
        this.speaking = aliases;
        this.view?.onSpeaking?.(aliases);
        if (this.voicePanelOpen) this.renderVoicePanel();
      },
    });
    for (const alias of this.mutedPlayers.keys()) v.setPeerMuted(alias, true);
    return v;
  }

  private renderVoicePanel() {
    const v = this.voice;
    const btn = $('btn-voice');
    const panel = $('voice-panel');
    if (!v.available) {
      btn.hidden = true;
      panel.hidden = true;
      return;
    }
    btn.hidden = false;
    const others = v.peers.filter((p) => p.id !== v.alias);
    btn.classList.toggle('active', v.inVoice);
    btn.textContent = v.inVoice ? (v.selfMuted ? '🎙️🚫' : '🎙️') : '🎙️';
    btn.title = v.inVoice ? 'Voice chat' : 'Join voice chat';
    const count = v.peers.length;
    if (count) btn.textContent += ` ${count}`;
    panel.hidden = !this.voicePanelOpen;
    // The lobby shows voice state too.
    this.view?.onMembers?.(this.membersList);
    if (!this.voicePanelOpen) return;
    let html = '<h3>Voice chat</h3>';
    if (!v.supported) {
      html += '<p>Voice needs a secure (https) page. It will work on the hosted game; for local testing use <b>npm run dev:https</b>.</p>';
    } else if (!v.inVoice) {
      html += `<p>${others.length ? `${others.length} in voice now.` : 'Nobody is in voice yet.'} Headphones stop game sound from leaking into your mic.</p>`;
      html += '<div class="voice-actions"><button class="btn btn-primary" data-v="join">Join voice</button></div>';
    } else {
      html += `<div class="voice-actions"><button class="btn btn-secondary" data-v="self">${v.selfMuted ? 'Unmute me' : 'Mute me'}</button><button class="btn btn-secondary" data-v="leave">Leave voice</button></div>`;
      if (!others.length) html += '<p>Nobody else is in voice yet. Invite friends with the Invite button.</p>';
      html += '<ul class="voice-peers">';
      for (const p of others) {
        const muted = v.isPeerMuted(p.id);
        const route = v.routeTo(p.id);
        const state = route === 'connecting' ? ' <small>(connecting…)</small>' : route === 'failed' ? ' <small>(couldn’t connect)</small>' : route === 'relayed' ? ' <small>(relayed)</small>' : '';
        const speaking = this.speaking.has(p.id);
        html += `<li><span class="speak-dot${speaking ? ' on' : ''}"></span>${escapeHtml(p.name)}${state}<button class="btn btn-secondary" data-v="mute" data-alias="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">${muted ? 'Unmute' : 'Mute'}</button></li>`;
      }
      html += '</ul>';
      if (v.relayOnly) html += '<p class="hint">Relay test mode: all voice goes through the relay server.</p>';
    }
    panel.innerHTML = html;
  }

  private onVoicePanelClick = (e: Event) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
    const v = this.voice;
    if (!el) return;
    const action = el.dataset.v;
    if (action === 'join') void v.join();
    else if (action === 'leave') v.leave();
    else if (action === 'self') v.setSelfMuted(!v.selfMuted);
    else if (action === 'mute') {
      const alias = el.dataset.alias!;
      this.mutePlayer(alias, el.dataset.name ?? 'player', !v.isPeerMuted(alias));
    }
    this.renderVoicePanel();
  };

  // ------------------------------------------------------------------ chat

  private addChat(m: ChatMessage) {
    if (m.speaker && this.mutedPlayers.has(m.speaker)) return;
    const li = document.createElement('li');
    const time = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (m.system) {
      li.className = 'system';
      li.innerHTML = `<span class="time">${time}</span>${escapeHtml(m.text)}`;
    } else {
      li.innerHTML = `<span class="time">${time}</span><span class="who" style="color:${colorCss(m.color)}">${escapeHtml(m.from)}:</span> ${escapeHtml(m.text)}`;
      if (m.speaker && m.speaker !== this.alias) {
        // Tap someone else's message for Mute / Report.
        li.classList.add('reportable');
        li.dataset.speaker = m.speaker;
        li.addEventListener('click', () => this.toggleChatActions(li, m));
      }
    }
    const log = $('chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(li);
    while (log.children.length > 200) log.firstElementChild!.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
    if (this.liveChat && !m.system && m.speaker !== this.alias) this.sfx.play('chat');
    if (this.liveChat && !this.chatOpen && !m.system) {
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
    // The play area changes size on desktop.
    requestAnimationFrame(() => this.view?.resize?.());
  }

  private toggleChatActions(li: HTMLElement, m: ChatMessage) {
    const open = li.querySelector('.chat-actions');
    document.querySelectorAll('#chat-log .chat-actions').forEach((el) => el.remove());
    if (open) return;
    const row = document.createElement('div');
    row.className = 'chat-actions';
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.textContent = `Mute ${m.from}`;
    const report = document.createElement('button');
    report.type = 'button';
    report.textContent = 'Report';
    mute.addEventListener('click', (e) => {
      e.stopPropagation();
      this.mutePlayer(m.speaker!, m.from, true);
    });
    report.addEventListener('click', (e) => {
      e.stopPropagation();
      this.net.send({ t: 'report', msgId: m.id });
      report.textContent = 'Reported';
      report.disabled = true;
    });
    row.append(mute, report);
    li.append(row);
  }

  mutePlayer(alias: string, name: string, muted: boolean) {
    if (muted) {
      this.mutedPlayers.set(alias, name);
      document.querySelectorAll<HTMLElement>(`#chat-log li[data-speaker="${CSS.escape(alias)}"]`).forEach((el) => el.remove());
      this.toast(`Muted ${name}`);
    } else {
      this.mutedPlayers.delete(alias);
      this.toast(`Unmuted ${name}`);
    }
    this.voice.setPeerMuted(alias, muted);
    this.renderMutedList();
    this.renderVoicePanel();
  }

  private renderMutedList() {
    const box = $('menu-muted');
    box.innerHTML = '';
    if (!this.mutedPlayers.size) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const title = document.createElement('span');
    title.textContent = 'Muted players';
    box.append(title);
    for (const [alias, name] of this.mutedPlayers) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-secondary';
      b.textContent = `Unmute ${name}`;
      b.addEventListener('click', () => this.mutePlayer(alias, name, false));
      box.append(b);
    }
  }

  // ------------------------------------------------------------------ toolbar, menu, keys

  toast(text: string) {
    const el = document.createElement('div');
    el.textContent = text;
    const box = $('toasts');
    box.append(el);
    while (box.children.length > 3) box.firstElementChild!.remove();
    setTimeout(() => el.remove(), 3500);
  }

  private updateSoundButton() {
    const btn = $('btn-sound');
    btn.textContent = this.sfx.muted ? '🔇' : '🔊';
    btn.setAttribute('aria-label', this.sfx.muted ? 'Sound off' : 'Sound on');
    ($<HTMLInputElement>('menu-volume')).value = String(Math.round(this.sfx.volume * 100));
  }

  private updateRoomInfo() {
    const priv = this.room.kind === 'private';
    $('btn-share').hidden = !priv;
    $('menu-room').textContent = priv ? `Private room ${this.room.code}. Share the invite link to bring friends.` : 'Public room.';
    const path = priv ? `/r/${this.room.code}` : '/';
    if (location.pathname !== path) history.replaceState(null, '', path + location.search);
  }

  private bindUi(w: Welcome) {
    ($<HTMLInputElement>('menu-name')).value = w.name;
    const on = (id: string, fn: (e: Event) => void) => {
      const el = $(id);
      el.addEventListener('click', fn);
      this.cleanups.push(() => el.removeEventListener('click', fn));
    };
    on('btn-chat', () => this.setChatOpen(true));
    on('chat-collapse', () => this.setChatOpen(false));
    on('btn-fullscreen', () => this.toggleFullscreen());
    on('btn-share', () => void this.share());
    on('btn-menu', () => this.openMenu(true));
    on('btn-voice', () => {
      this.voicePanelOpen = !this.voicePanelOpen;
      this.renderVoicePanel();
    });
    const vp = $('voice-panel');
    vp.addEventListener('click', this.onVoicePanelClick);
    this.cleanups.push(() => vp.removeEventListener('click', this.onVoicePanelClick));
    on('btn-sound', () => {
      this.sfx.unlock();
      this.sfx.toggleMute();
      this.updateSoundButton();
    });
    const volume = $<HTMLInputElement>('menu-volume');
    const onVolume = () => {
      this.sfx.unlock();
      this.sfx.setVolume(Number(volume.value) / 100);
      this.updateSoundButton();
    };
    volume.addEventListener('input', onVolume);
    this.cleanups.push(() => volume.removeEventListener('input', onVolume));
    // Browsers (iPhone especially) only start audio after a tap or key press.
    const unlock = () => this.sfx.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) {
      window.addEventListener(ev, unlock, { passive: true });
      this.cleanups.push(() => window.removeEventListener(ev, unlock));
    }
    this.updateSoundButton();
    on('menu-close', () => this.openMenu(false));
    on('menu-leave', () => this.onLeave());
    on('menu-lobby', () => {
      this.net.send({ t: 'lobby' });
      this.openMenu(false);
    });
    on('menu-name-save', () => {
      const name = ($<HTMLInputElement>('menu-name')).value;
      this.net.send({ t: 'name', name });
    });

    const form = $<HTMLFormElement>('chat-form');
    const submit = (e: Event) => {
      e.preventDefault();
      const input = $<HTMLInputElement>('chat-input');
      const text = input.value.trim();
      if (text) this.net.send({ t: 'chat', text });
      input.value = '';
      if (this.device.small) input.blur();
    };
    form.addEventListener('submit', submit);
    this.cleanups.push(() => form.removeEventListener('submit', submit));

    const keys = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') {
          target.blur();
          if (this.device.small) this.setChatOpen(false);
        }
        return;
      }
      if (this.view?.onKey?.(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!this.chatOpen) this.setChatOpen(true);
        $<HTMLInputElement>('chat-input').focus();
      } else if (e.code === 'KeyM') {
        this.sfx.toggleMute();
        this.updateSoundButton();
      } else if (e.code === 'KeyF') {
        this.toggleFullscreen();
      } else if (e.key === 'Escape') {
        this.openMenu($('menu').hidden);
      }
    };
    window.addEventListener('keydown', keys);
    this.cleanups.push(() => window.removeEventListener('keydown', keys));
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
          if (!this.view?.landscape) return;
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
    const url = `${location.origin}/r/${this.room.code}`;
    const playing = this.gameId ? ` We're playing ${GAME_NAMES[this.gameId]}.` : '';
    const data = { title: 'Tank You For Being A Friend', text: `Come hang out.${playing} Tap to join my room:`, url };
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
    this.view?.setPaused?.(open);
    if (open) this.renderMutedList();
  }

  dispose() {
    this.view?.dispose();
    this.view = null;
    this.voice.teardown();
    this.voicePanelOpen = false;
    $('voice-panel').hidden = true;
    clearInterval(this.pingTimer);
    for (const c of this.cleanups) c();
    this.cleanups = [];
    $('menu').hidden = true;
    $('reconnect').hidden = true;
    $('game').classList.remove('landscape-only');
  }
}
