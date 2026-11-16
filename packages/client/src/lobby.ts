import type { MemberInfo } from '@tank/shared';
import { colorCss, escapeHtml } from './state';
import type { ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const GAMES = [
  { id: 'tanks', name: 'Tanks', icon: '💥', blurb: 'Drop in by helicopter and blow each other up. Bots fill the empty spots.', players: '1–4 players' },
  { id: 'hearts', name: 'Hearts', icon: '♥️', blurb: 'The classic trick-taking card game. Avoid hearts and the queen of spades.', players: '4 seats, bots fill in' },
] as const;

/** The private room's home: who's here, voice, and a game picker anyone can use. */
export class LobbyView implements View {
  readonly landscape = false;
  readonly helpHtml = '<p>Pick a game to start it for everyone in the room. Chat and voice keep going between games.</p>';
  private el = $('lobby-view');
  private members: MemberInfo[] = [];
  private speaking = new Set<string>();

  constructor(private shell: ShellApi) {
    this.el.hidden = false;
    this.el.addEventListener('click', this.onClick);
    this.render();
  }

  onMembers(members: MemberInfo[]) {
    this.members = members;
    this.render();
  }

  onSpeaking(aliases: Set<string>) {
    this.speaking = aliases;
    for (const li of this.el.querySelectorAll<HTMLElement>('[data-alias]')) li.classList.toggle('speaking', aliases.has(li.dataset.alias!));
  }

  private render() {
    const s = this.shell;
    let html = `<div class="lobby-card"><div class="lobby-head"><h2>Room <span class="room-code">${escapeHtml(s.roomCode)}</span></h2>`;
    html += '<button class="btn btn-secondary" data-act="invite" type="button">Invite friends</button></div>';
    html += '<ul class="lobby-members">';
    for (const m of this.members) {
      const you = m.id === s.alias ? ' <small>(you)</small>' : '';
      const away = m.connected ? '' : ' <small>(away)</small>';
      html += `<li data-alias="${escapeHtml(m.id)}" class="${this.speaking.has(m.id) ? 'speaking' : ''}"><span class="dot" style="background:${colorCss(m.color)}"></span>${escapeHtml(m.name)}${you}${away}</li>`;
    }
    html += '</ul>';
    if (s.voice.available && !s.voice.inVoice) {
      html += '<button class="btn btn-secondary voice-cta" data-act="voice" type="button">🎙️ Join voice chat</button>';
    }
    html += '<h3>Pick a game</h3><div class="game-cards">';
    for (const g of GAMES) {
      html += `<button class="game-card" data-game="${g.id}" type="button"><span class="game-icon">${g.icon}</span><span class="game-name">${g.name}</span><span class="game-blurb">${g.blurb}</span><span class="game-players">${g.players}</span></button>`;
    }
    html += '</div><p class="hint">Anyone in the room can pick. Chat and voice keep going between games.</p></div>';
    this.el.innerHTML = html;
  }

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const game = t.closest<HTMLElement>('[data-game]')?.dataset.game;
    if (game === 'tanks' || game === 'hearts') {
      this.shell.play('lobbyJoin');
      this.shell.pickGame(game);
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'invite') this.shell.share();
    else if (act === 'voice') this.shell.voice.join();
  };

  dispose() {
    this.el.removeEventListener('click', this.onClick);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}
