import { CHAT_FILTER_LABELS, checkChat, GAME_NAMES, gameInfo, type ChatFilterMode, type ChatMessage, type GameId, type MemberInfo, type ServerMessage, type TableSetup, type VoicePeer } from '@tank/shared';
import { SOUND_NAMES, type PlayOptions, type Sfx, type SoundName } from './audio';
import { SpadesTable } from './spadesView';
import { DominoesTable } from './dominoesView';
import { ThreeThirteenTable } from './threeThirteenView';
import { JigsawTable } from './jigsawView';
import { HeartsTable } from './heartsView';
import { LobbyView } from './lobby';
import type { Net } from './net';
import type { Sprites } from './sprites';
import { colorCss, escapeHtml } from './state';
import { TankView } from './tankView';
import type { Device, ShellApi, View } from './views';
import { Voice } from './voice';
import { moveFocus, type Gamepads, type PadButton, type PadPress } from './gamepad';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/**
 * How you came in: with the mic on or off. With it on, the mic was already asked for during the
 * tap on "with mic on" (and an audio context made in that tap), so iPhones and iPads allow both.
 */
export interface EntryChoice {
  mic: boolean;
  /** Back after a reload: the mic is asked for again without a tap. */
  resumed: boolean;
  micStream: Promise<MediaStream> | null;
  audioCtx: AudioContext | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The sheets that can open over the table (one at a time). */
const SHEETS = ['menu', 'invite', 'mic-help', 'help', 'home-help', 'idle'] as const;
/** Tell the server we're still here at most this often (more often while it's warning us). */
const ACTIVE_EVERY_MS = 60_000;
type Sheet = (typeof SHEETS)[number];

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
  /** Between games: what's picked, who sits where, who's ready. */
  private tableState: TableSetup;
  private chatOpen: boolean;
  /** You opened or closed Messages yourself: it's left as you put it. */
  private chatChosen = false;
  /** Whether Messages starts open waits for who's on the mic (just after the welcome). */
  private chatStartPending = true;
  /** You came to the table with your mic on. */
  private micAtStart = false;
  private unread = 0;
  private liveChat = false;
  private pingTimer: number;
  private speaking = new Set<string>();
  /** Waiting for the server to make an invite link (resolved by its 'invite' message). */
  private inviteWaiting: ((token: string) => void) | null = null;
  /** Players you muted in this room (alias -> name): their chat is hidden and voice silenced. */
  private mutedPlayers = new Map<string, string>();
  private cleanups: (() => void)[] = [];
  /** When we last told the server we're still here, and whether it's warning that the table will close. */
  private lastActiveSent = 0;
  private idleWarning = false;
  private api: ShellApi;
  /** How swearing in chat is handled here (the server has the final say). */
  chatFilter: ChatFilterMode;
  /** Chat is paused until then (ms, page clock) after too many caught messages. */
  private chatPausedUntil = 0;
  private pauseTimer: number | undefined;

  constructor(
    welcome: Welcome,
    private net: Net,
    private sprites: Sprites,
    private sfx: Sfx,
    private device: Device,
    private onLeave: () => void,
    private pads: Gamepads | null = null,
    entry: EntryChoice = { mic: false, resumed: false, micStream: null, audioCtx: null },
  ) {
    const gameEl = $('game');
    gameEl.classList.toggle('phone', device.small);
    // "Turn your phone sideways", or iPad, or tablet: whatever they're holding.
    $('rotate').querySelector('.overlay-card')!.textContent = `Turn your ${deviceWord(device)} sideways to play`;
    $('chat-log').innerHTML = '';
    this.alias = welcome.alias;
    this.room = welcome.room;
    this.membersList = welcome.members;
    this.tableState = welcome.table;
    this.chatFilter = welcome.chatFilter;
    this.voice = this.makeVoice(welcome);
    this.micAtStart = entry.mic && this.voice.available && this.voice.supported;
    this.chatOpen = this.chatStartsOpen(null);
    gameEl.classList.toggle('chat-collapsed', !this.chatOpen);
    this.api = this.makeApi();
    this.bindUi(welcome);
    for (const m of welcome.chat) this.addChat(m);
    this.liveChat = true;
    this.updateRoomInfo();
    this.renderMic();
    this.showGame(welcome.game);
    this.pingTimer = window.setInterval(() => this.net.send({ t: 'ping', at: performance.now() }), 2000);
    // "With mic on": the mic was asked for in that tap; join with it now.
    if (entry.mic && this.voice.available && this.voice.supported) void this.voice.join({ auto: true, stream: entry.micStream, ctx: entry.audioCtx });
    else {
      void entry.micStream?.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      void entry.audioCtx?.close().catch(() => {});
    }
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
      table: () => this.tableState,
      pickGame: (game) => this.net.send({ t: 'pick', game }),
      sit: (seat) => this.net.send({ t: 'sit', seat }),
      setPlayers: (n) => this.net.send({ t: 'players', n }),
      setReady: (ready) => this.net.send({ t: 'ready', ready }),
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
        get micProblem() {
          return shell.voice.micProblem;
        },
        join: () => void shell.voice.join(),
      },
      pads: this.pads,
      get chatFilter() {
        return shell.chatFilter;
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
    else if (id === 'spades') this.view = new SpadesTable(this.api);
    else if (id === 'dominoes') this.view = new DominoesTable(this.api);
    else if (id === 'threethirteen') this.view = new ThreeThirteenTable(this.api);
    else if (id === 'jigsaw') this.view = new JigsawTable(this.api);
    else this.view = new LobbyView(this.api);
    gameEl.classList.toggle('landscape-only', this.view.landscape);
    gameEl.dataset.view = id ?? 'lobby';
    this.setBarOpen(false);
    this.view.onMembers?.(this.membersList);
    this.view.onSpeaking?.(this.speaking);
    // Help: how to play what's on screen (the game picker has its own few words).
    $('help-title').textContent = id ? `How to play ${gameInfo(id).name}` : 'At the table';
    $('help-body').innerHTML = this.view.helpHtml;
    $('menu-lobby').hidden = !(this.room.kind === 'private' && id !== null);
    if (!$('menu').hidden) this.openSheet(null);
    this.updateRoomInfo();
    document.title = id ? `${gameInfo(id).title} · Games Drawer` : `Table ${this.room.code} · Games Drawer`;
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
      case 'table':
        this.tableState = msg.table;
        this.view?.onTable?.(msg.table);
        return;
      case 'voice':
        this.voice.onPeers(msg.peers);
        // The first word of who's on the mic: now it's known whether Messages starts open.
        if (this.chatStartPending) {
          this.chatStartPending = false;
          if (!this.chatChosen) this.setChatOpen(this.chatStartsOpen(msg.peers), false);
        }
        return;
      case 'idle':
        // Nobody's played or talked for a while: a minute's warning, and any tap keeps the table.
        this.idleWarning = msg.closesInMs !== null;
        if (this.idleWarning) this.openSheet('idle');
        else if (!$('idle').hidden) this.openSheet(null);
        return;
      case 'rtc':
        void this.voice.onSignal(msg.from, msg.data);
        return;
      case 'chat':
        this.addChat(msg.msg);
        return;
      case 'filter':
        this.chatFilter = msg.mode;
        this.renderFilterSetting();
        this.updateChatInput();
        return;
      case 'chatPaused':
        this.chatPausedUntil = Date.now() + msg.ms;
        clearInterval(this.pauseTimer);
        this.pauseTimer = window.setInterval(() => {
          this.updateChatInput();
          if (Date.now() >= this.chatPausedUntil) clearInterval(this.pauseTimer);
        }, 1000);
        this.updateChatInput();
        return;
      case 'pong':
        this.view?.onPong?.(msg.at);
        return;
      case 'invite':
        this.inviteWaiting?.(msg.token);
        this.inviteWaiting = null;
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
    this.tableState = w.table;
    this.chatFilter = w.chatFilter;
    this.renderFilterSetting();
    this.updateChatInput();
    $('reconnect').hidden = true;
    this.toast(w.reclaimed ? 'Reconnected. You have your place back.' : 'Reconnected.');
    // Voice rejoins by itself (the mic is still open).
    this.voice.rejoin(w.voice);
    this.renderMic();
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
      changed: () => this.renderMic(),
      speaking: (aliases) => {
        this.speaking = aliases;
        if (aliases.has(this.alias)) this.markActive();
        this.view?.onSpeaking?.(aliases);
        for (const li of document.querySelectorAll<HTMLElement>('#menu-mic [data-peer]')) li.classList.toggle('is-talking', aliases.has(li.dataset.peer!));
      },
    });
    for (const alias of this.mutedPlayers.keys()) v.setPeerMuted(alias, true);
    return v;
  }

  /**
   * The mic button says what it will do (DESIGN.md): Mute mic, Unmute mic, or Turn on mic.
   * Muted or off is tomato, so it's hard to miss: talking is the point of a table. The menu's
   * Mic part has who's on the mic (each can be muted just for you) and turning yours off.
   */
  private renderMic() {
    const v = this.voice;
    const btn = $('btn-mic');
    const part = $('menu-mic');
    if (!v.available) {
      btn.hidden = true;
      part.hidden = true;
      return;
    }
    btn.hidden = false;
    part.hidden = false;
    const label = !v.inVoice ? 'Turn on mic' : v.selfMuted ? 'Unmute mic' : 'Mute mic';
    btn.textContent = label;
    btn.classList.toggle('pc-btn-main', v.inVoice && !v.selfMuted);
    btn.classList.toggle('pc-btn-alert', !v.inVoice || v.selfMuted);
    // The lobby shows mic state too.
    this.view?.onMembers?.(this.membersList);
    const others = v.peers.filter((p) => p.id !== v.alias);
    let html = '<h3 class="pc-h3">Mic</h3>';
    if (!v.supported) {
      html += '<p>The mic needs a secure (https) page. It works on the hosted site; for local testing use <b>npm run dev:https</b>.</p>';
    } else if (!v.inVoice) {
      if (v.micProblem === 'blocked') html += '<p>Your browser is blocking the mic. <button class="pc-link" type="button" data-v="help">Show me how to allow it</button></p>';
      else if (v.micProblem === 'missing') html += '<p>No microphone found. Plug one in (or use headphones with a mic), then tap Turn on mic.</p>';
      else html += `<p>Your mic is off. ${others.length ? `${others.length === 1 ? 'One person is' : `${others.length} people are`} talking.` : ''}</p>`;
      html += '<button class="pc-btn pc-btn-main pc-btn-wide" type="button" data-v="join">Turn on mic</button>';
    } else {
      if (others.length) {
        html += '<ul class="mic-people">';
        for (const p of others) {
          const muted = v.isPeerMuted(p.id);
          const route = v.routeTo(p.id);
          const state = route === 'connecting' ? ' <small>(connecting…)</small>' : route === 'failed' ? ' <small>(couldn’t connect)</small>' : '';
          html += `<li data-peer="${escapeHtml(p.id)}" class="${this.speaking.has(p.id) ? 'is-talking' : ''}"><span class="pc-talk"><i></i><i></i><i></i></span><span class="mic-name"><span class="pc-nm">${escapeHtml(p.name)}</span>${state}</span><button class="pc-btn pc-btn-plain" type="button" data-v="mute" data-alias="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">${muted ? `Hear ${escapeHtml(p.name)}` : 'Mute for me'}</button></li>`;
        }
        html += '</ul>';
      } else {
        html += '<p>Nobody else has their mic on yet.</p>';
      }
      html += '<button class="pc-btn pc-btn-plain pc-btn-wide" type="button" data-v="leave">Turn my mic off</button>';
      html += '<p class="pc-small">Headphones keep game sounds out of your mic.</p>';
      if (v.relayOnly) html += '<p class="pc-small">Relay test mode: all voice goes through the relay server.</p>';
    }
    part.innerHTML = html;
  }

  private onMicMenuClick = (e: Event) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
    const v = this.voice;
    if (!el) return;
    const action = el.dataset.v;
    if (action === 'join') void v.join();
    else if (action === 'leave') v.leave();
    else if (action === 'help') this.openSheet('mic-help');
    else if (action === 'mute') {
      const alias = el.dataset.alias!;
      this.mutePlayer(alias, el.dataset.name ?? 'player', !v.isPeerMuted(alias));
    }
    this.renderMic();
  };

  /** The bar's mic button: mute or unmute, or turn the mic on (or explain why it's blocked). */
  private onMicButton = () => {
    const v = this.voice;
    if (v.inVoice) v.setSelfMuted(!v.selfMuted);
    else if (v.micProblem === 'blocked') this.openSheet('mic-help');
    else void v.join();
    this.renderMic();
  };

  // ------------------------------------------------------------------ chat

  /** Grey out Send (with a reminder) when the message would be caught, or while chat is paused. */
  private updateChatInput() {
    const input = $<HTMLInputElement>('chat-input');
    const send = $<HTMLButtonElement>('chat-send');
    const hint = $('chat-hint');
    const pausedFor = Math.ceil((this.chatPausedUntil - Date.now()) / 1000);
    if (pausedFor > 0) {
      input.disabled = true;
      send.disabled = true;
      input.placeholder = `Messages paused for ${pausedFor} seconds`;
      hint.hidden = true;
      return;
    }
    input.disabled = false;
    input.placeholder = this.room.kind === 'public' ? 'Write a message (keep it family friendly)' : 'Write a message';
    const r = checkChat(input.value, this.chatFilter);
    const caught = !r.ok && r.reason !== 'empty' && r.reason !== 'too-long';
    send.disabled = !r.ok;
    hint.hidden = !caught;
    input.classList.toggle('caught', caught);
  }

  /** The None / Hide / Block switch in the menu (private rooms only). */
  private renderFilterSetting() {
    const box = $('menu-filter');
    box.hidden = this.room.kind !== 'private';
    for (const b of box.querySelectorAll<HTMLElement>('[data-filter]')) {
      const on = b.dataset.filter === this.chatFilter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
    const detail = CHAT_FILTER_LABELS[this.chatFilter].detail;
    $('menu-filter-detail').textContent = `${detail[0].toUpperCase()}${detail.slice(1)}. Anyone at the table can change this.`;
  }

  private addChat(m: ChatMessage) {
    if (m.speaker && this.mutedPlayers.has(m.speaker)) return;
    const li = document.createElement('li');
    const time = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (m.system) {
      li.className = 'system';
      li.innerHTML = `<span class="msg-text">${escapeHtml(m.text)}</span> <span class="time">${time}</span>`;
    } else {
      // A note: the name and time on top, the message under them.
      li.innerHTML = `<span class="msg-head"><span class="who" style="color:${colorCss(m.color)}">${escapeHtml(m.from)}</span><span class="time">${time}</span></span><span class="msg-text">${escapeHtml(m.text)}</span>`;
      // Yours are cobalt notes on the right (table.css).
      if (m.speaker && m.speaker === this.alias) li.classList.add('mine');
      if (m.hidden) {
        li.classList.add('caught');
        li.insertAdjacentHTML('beforeend', ' <small class="only-you">(not sent: only you can see this)</small>');
      }
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
      $('bar-tab').querySelector<HTMLElement>('.bar-tab-dot')!.hidden = false;
      // It pops up too, so it's read without opening Messages ("Sammy: I can't hear you").
      if (m.speaker !== this.alias) this.note(m.text.length > 90 ? `${m.text.slice(0, 88).trimEnd()}…` : m.text, m.from);
    }
    // Someone arriving pops up (in Messages it's only a grey line), with the table's join sound.
    // Arrivals and leavings don't count as unread.
    if (this.liveChat && m.notice?.kind === 'arrive' && m.notice.alias !== this.alias) {
      this.note(m.text);
      this.play('lobbyJoin');
    }
  }

  /**
   * Whether Messages starts open: only where there's room beside the game (a laptop, an iPad on
   * its side), and not when everyone at the table has their mic on: talking, they don't need it.
   * `peers` is who's on the mic, or null before the server has said (then it waits, closed).
   */
  private chatStartsOpen(peers: VoicePeer[] | null) {
    if (this.device.small || window.innerWidth < 1100) return false;
    if (!this.micAtStart) return true;
    if (!peers) return false;
    const onMic = new Set(peers.map((p) => p.id));
    return this.membersList.some((m) => m.id !== this.alias && m.connected && !onMic.has(m.id));
  }

  private setBarOpen(open: boolean) {
    $('game').classList.toggle('bar-open', open);
    const tab = $('bar-tab');
    tab.setAttribute('aria-expanded', String(open));
    tab.setAttribute('aria-label', open ? 'Hide the bar' : 'Show the bar');
  }

  /** Open or close Messages; `chosen` when you did it (then it's never opened or closed for you). */
  private setChatOpen(open: boolean, chosen = true) {
    if (chosen) this.chatChosen = true;
    this.chatOpen = open;
    $('game').classList.toggle('chat-collapsed', !open);
    if (open) {
      this.unread = 0;
      $('chat-unread').hidden = true;
      $('bar-tab').querySelector<HTMLElement>('.bar-tab-dot')!.hidden = true;
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
    this.renderMic();
  }

  private renderMutedList() {
    const box = $('menu-muted');
    box.innerHTML = '';
    if (!this.mutedPlayers.size) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const title = document.createElement('h3');
    title.className = 'pc-h3';
    title.textContent = 'People you muted';
    box.append(title);
    for (const [alias, name] of this.mutedPlayers) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pc-btn pc-btn-plain';
      b.textContent = `Unmute ${name}`;
      b.addEventListener('click', () => this.mutePlayer(alias, name, false));
      box.append(b);
    }
  }

  // ------------------------------------------------------------------ toolbar, menu, keys

  toast(text: string) {
    this.note(text);
  }

  /**
   * A note that pops up over the game and goes by itself: what happened ("Reconnected."), who
   * just arrived ("Liz is here."), or, with `from`, a message while Messages is closed.
   */
  private note(text: string, from?: string) {
    const box = $('toasts');
    const el = document.createElement('div');
    if (from) {
      el.className = 'toast-chat';
      el.innerHTML = `<b>${escapeHtml(from)}:</b> ${escapeHtml(text)}`;
    } else el.textContent = text;
    // The same note again (tapping a tile that doesn't fit twice) replaces it rather than stacking.
    const last = box.lastElementChild;
    if (last?.textContent === el.textContent) last.remove();
    // A longer one stays up longer, to be read: 3.5 seconds, up to 7 for a long message.
    const ms = Math.min(7000, Math.max(3500, 1500 + el.textContent!.length * 60));
    el.style.animationDuration = `${ms}ms`;
    box.append(el);
    while (box.children.length > 3) box.firstElementChild!.remove();
    setTimeout(() => el.remove(), ms);
  }

  private updateSoundButton() {
    $('btn-sound').textContent = this.sfx.muted ? 'Turn sound on' : 'Turn sound off';
    const volume = $<HTMLInputElement>('menu-volume');
    volume.value = String(Math.round(this.sfx.volume * 100));
    // How far along the slider is filled (styles draw the filled part from this).
    volume.style.setProperty('--fill', `${volume.value}%`);
  }

  private updateRoomInfo() {
    const priv = this.room.kind === 'private';
    $('btn-share').hidden = !priv;
    $('invite-code').textContent = this.room.code;
    // A table's address is its invite link; public games show the game's own page.
    const path = priv ? `/r/${this.room.code}` : this.gameId ? `/${gameInfo(this.gameId).slug}` : '/';
    if (location.pathname !== path) history.replaceState(null, '', path);
  }

  private bindUi(w: Welcome) {
    ($<HTMLInputElement>('menu-name')).value = w.name;
    const on = (id: string, fn: (e: Event) => void) => {
      const el = $(id);
      el.addEventListener('click', fn);
      this.cleanups.push(() => el.removeEventListener('click', fn));
    };
    // Messages opens from the bar (the button hides while it's open) and closes with its own Close.
    on('btn-chat', () => this.setChatOpen(true));
    on('btn-help', () => this.openSheet($('help').hidden ? 'help' : null));
    on('help-close', () => this.openSheet(null));
    on('home-help-close', () => this.openSheet(null));
    // Opened from the home screen icon, it's already full screen: no button for it.
    $('menu-fullscreen').hidden = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    on('chat-collapse', () => this.setChatOpen(false));
    on('btn-fullscreen', () => this.toggleFullscreen());
    // The button says what it will do: "Exit full screen" while the page is full screen.
    const fullscreenLabel = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      $('btn-fullscreen').textContent = document.fullscreenElement || doc.webkitFullscreenElement ? 'Exit full screen' : 'Full screen';
    };
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.addEventListener(ev, fullscreenLabel);
      this.cleanups.push(() => document.removeEventListener(ev, fullscreenLabel));
    }
    on('btn-share', () => this.share());
    on('btn-menu', () => this.openSheet($('menu').hidden ? 'menu' : null));
    on('btn-mic', this.onMicButton);
    // At the table, a pinch never zooms the whole page (Safari does that with a trackpad or an
    // iPad's mouse); the puzzle and the domino board use it to zoom themselves. The way-in pages
    // stay zoomable.
    const noPageZoom = (e: Event) => e.preventDefault();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, noPageZoom);
    this.cleanups.push(() => {
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.removeEventListener(type, noPageZoom);
    });
    // Tapping, typing or talking keeps the table open (see markActive).
    on('idle-stay', () => this.markActive(true));
    const touched = () => this.markActive();
    document.addEventListener('pointerdown', touched, true);
    document.addEventListener('keydown', touched, true);
    this.cleanups.push(() => {
      document.removeEventListener('pointerdown', touched, true);
      document.removeEventListener('keydown', touched, true);
    });
    // Tanks on a phone held sideways: the tab pulls the folded bar down and pushes it back up.
    // Using the bar folds it again (Mute mic a moment later, so you see it change), and so does
    // touching the battlefield.
    on('bar-tab', () => this.setBarOpen(!$('game').classList.contains('bar-open')));
    // Turning the phone folds it too: it was laid out for the way the phone was held.
    const upright = matchMedia('(orientation: portrait)');
    const foldOnTurn = () => this.setBarOpen(false);
    upright.addEventListener('change', foldOnTurn);
    this.cleanups.push(() => upright.removeEventListener('change', foldOnTurn));
    const toolbar = $('game').querySelector<HTMLElement>('.toolbar')!;
    const foldAfterUse = (e: Event) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (btn) window.setTimeout(() => this.setBarOpen(false), btn.id === 'btn-mic' ? 700 : 0);
    };
    toolbar.addEventListener('click', foldAfterUse);
    this.cleanups.push(() => toolbar.removeEventListener('click', foldAfterUse));
    const arena = $('game').querySelector<HTMLElement>('.arena')!;
    const foldOnPlay = (e: Event) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.toolbar, #bar-tab')) this.setBarOpen(false);
    };
    arena.addEventListener('pointerdown', foldOnPlay);
    this.cleanups.push(() => arena.removeEventListener('pointerdown', foldOnPlay));
    on('menu-mic', this.onMicMenuClick);
    on('invite-send', () => void this.sendInvite());
    on('invite-close', () => this.openSheet(null));
    on('mic-help-close', () => this.openSheet(null));
    on('mic-help-retry', () => {
      this.openSheet(null);
      void this.voice.join();
    });
    // Tapping the dimmed table around a sheet closes it.
    for (const id of SHEETS) {
      on(id, (e) => {
        if (e.target === $(id)) this.openSheet(null);
      });
    }
    const inviteName = $<HTMLInputElement>('invite-name');
    const inviteEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') void this.sendInvite();
    };
    inviteName.addEventListener('keydown', inviteEnter);
    this.cleanups.push(() => inviteName.removeEventListener('keydown', inviteEnter));
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
    on('menu-close', () => this.openSheet(null));
    on('menu-game', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-menu-item]')?.dataset.menuItem;
      if (!id) return;
      this.openSheet(null);
      this.view?.onMenuItem?.(id);
    });
    on('menu-leave', () => this.onLeave());
    on('menu-lobby', () => {
      this.net.send({ t: 'lobby' });
      this.openSheet(null);
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
      // Caught messages never leave the browser: Send stays greyed out with a reminder.
      if (!text || Date.now() < this.chatPausedUntil || !checkChat(text, this.chatFilter).ok) {
        this.updateChatInput();
        return;
      }
      this.net.send({ t: 'chat', text });
      input.value = '';
      this.updateChatInput();
      if (this.device.small) input.blur();
    };
    form.addEventListener('submit', submit);
    this.cleanups.push(() => form.removeEventListener('submit', submit));
    const typed = () => this.updateChatInput();
    $('chat-input').addEventListener('input', typed);
    this.cleanups.push(() => $('chat-input').removeEventListener('input', typed));
    const filterPick = (e: Event) => {
      const mode = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]')?.dataset.filter;
      if (mode && mode !== this.chatFilter) this.net.send({ t: 'filter', mode: mode as ChatFilterMode });
    };
    $('menu-filter').addEventListener('click', filterPick);
    this.cleanups.push(() => $('menu-filter').removeEventListener('click', filterPick));
    this.renderFilterSetting();
    this.updateChatInput();

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
        // A game's own sheet (Scores) closes first, and never gets the Menu stacked on top of it.
        const gameSheet = document.querySelector<HTMLElement>('#game .view:not([hidden]) .ht-overlay:not([hidden])');
        if (gameSheet && !this.openSheetName()) {
          gameSheet.querySelector<HTMLElement>('[data-act="close-scores"]')?.click();
          return;
        }
        this.openSheet(this.openSheetName() ? null : 'menu');
      }
    };
    window.addEventListener('keydown', keys);
    this.cleanups.push(() => window.removeEventListener('keydown', keys));
  }

  private toggleFullscreen() {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void; webkitFullscreenEnabled?: boolean };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    // iPhones (and some other phones) can't put a web page full screen: explain the home screen icon.
    if (!document.fullscreenEnabled && !doc.webkitFullscreenEnabled) {
      this.fullscreenHelp();
      return;
    }
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

  /** Steps for adding Games Drawer to the home screen (it opens full screen from there). */
  private fullscreenHelp() {
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    for (const li of document.querySelectorAll<HTMLElement>('#home-help [data-for]')) {
      li.hidden = (ios && li.dataset.for !== 'ios') || (android && li.dataset.for !== 'android');
    }
    this.openSheet('home-help');
  }

  /** Invite: open the sheet (an optional name, then send the link). */
  private share() {
    $<HTMLInputElement>('invite-name').value = '';
    this.openSheet('invite');
    // On a computer, straight into the name box; on a phone that would cover the sheet with the keyboard.
    if (!this.device.touch) $('invite-name').focus();
  }

  /** Ask the server for a link from you (and for the named person), then share or copy it. */
  private async sendInvite() {
    const btn = $<HTMLButtonElement>('invite-send');
    if (btn.disabled) return;
    const forName = $<HTMLInputElement>('invite-name').value.trim() || null;
    btn.disabled = true;
    const token = await new Promise<string | null>((resolve) => {
      this.inviteWaiting = resolve;
      this.net.send({ t: 'invite', for: forName });
      setTimeout(() => resolve(null), 4000);
    });
    btn.disabled = false;
    const url = `${location.origin}/r/${this.room.code}${token ? `?i=${token}` : ''}`;
    const playing = this.gameId ? ` We're playing ${GAME_NAMES[this.gameId]}.` : '';
    const hi = forName ? `${forName}, come` : 'Come';
    const data = { title: 'Games Drawer', text: `${hi} play a game with us!${playing} Tap the link to join:`, url };
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share && (!nav.canShare || nav.canShare(data))) {
      try {
        await nav.share(data);
        this.openSheet(null);
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.toast(forName ? `Link for ${forName} copied. Paste it into a text or email.` : 'Invite link copied. Paste it into a text or email.');
      this.openSheet(null);
    } catch {
      this.toast(`Invite link: ${url}`);
    }
  }

  // ------------------------------------------------------------------ sheets

  private openSheetName(): Sheet | null {
    return SHEETS.find((id) => !$(id).hidden) ?? null;
  }

  /**
   * Tell the server someone's here (tapped, typed, used a controller or talked), so it doesn't
   * close the table as idle. At most once a minute, or right away while it's warning us.
   */
  private markActive(now = false) {
    const t = Date.now();
    if (!now && !this.idleWarning && t - this.lastActiveSent < ACTIVE_EVERY_MS) return;
    this.lastActiveSent = t;
    this.net.send({ t: 'active' });
  }

  /** Open one sheet over the table (or none). Games pause while the menu is open. */
  private openSheet(which: Sheet | null) {
    for (const id of SHEETS) $(id).hidden = id !== which;
    this.view?.setPaused?.(which === 'menu');
    if (which === 'menu') {
      this.renderMenuGame();
      this.renderMutedList();
      this.renderMic();
    }
    // Always open at the top, not wherever it was scrolled to last time.
    if (which) $(which).querySelector<HTMLElement>('.sheet')!.scrollTop = 0;
  }

  /** The game's own menu actions, above Switch game. */
  private renderMenuGame() {
    const items = this.view?.menuItems?.() ?? [];
    $('menu-game').innerHTML = items
      .map((i) => `<button class="pc-btn pc-btn-plain pc-btn-wide" type="button" data-menu-item="${escapeHtml(i.id)}">${escapeHtml(i.label)}</button>`)
      .join('');
  }

  // ------------------------------------------------------------------ controller

  /** What the controller should stay inside: a sheet on top, if one is open. */
  private padScope(): HTMLElement | null {
    const sheet = this.openSheetName();
    if (sheet) return $(sheet);
    return this.view?.padScope?.() ?? null;
  }

  /** A controller button went down. Menu always opens the menu; the rest go to what's on top. */
  onPad(p: PadPress) {
    this.markActive();
    const b = p.button;
    if (b === 'menu') {
      this.openSheet($('menu').hidden ? 'menu' : null);
      return;
    }
    const scope = this.padScope();
    if (!scope && this.view?.onPad?.(p, true)) return;
    const area = scope ?? $('game');
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') {
      // From the highlighted card if there is one; otherwise the first press lands on the first button.
      moveFocus(area, b, scope ? undefined : (this.view?.padOrigin?.() ?? undefined));
    } else if (b === 'a') {
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && area.contains(el)) el.click();
      else moveFocus(area, 'down');
    } else if (b === 'b') {
      // Back: close whatever is open, or let go of the highlighted button.
      if (this.openSheetName()) this.openSheet(null);
      else (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }

  onPadRelease(b: PadButton) {
    this.view?.onPad?.({ button: b, repeat: false, stick: false }, false);
  }

  dispose() {
    this.view?.dispose();
    this.view = null;
    this.voice.teardown();
    clearInterval(this.pingTimer);
    for (const c of this.cleanups) c();
    this.cleanups = [];
    for (const id of SHEETS) $(id).hidden = true;
    $('reconnect').hidden = true;
    $('game').classList.remove('landscape-only');
  }
}

/** What they're holding, for "Turn your … sideways": phone, iPad (which says it's a Mac), or tablet. */
function deviceWord(device: Device): string {
  if (device.small) return 'phone';
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  return 'tablet';
}
