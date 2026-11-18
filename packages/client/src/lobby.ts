import { canPlayPrivately, CHAT_FILTER_LABELS, GAMES, isGameId, type MemberInfo } from '@tank/shared';
import { MIC_OFF_SVG } from './icons';
import { colorCss, escapeHtml } from './state';
import type { ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Games a private room can pick: everything not switched off (see games.ts). */
const pickable = () => GAMES.filter((g) => canPlayPrivately(g.id));

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

  onChatFilter() {
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
    const filter = CHAT_FILTER_LABELS[s.chatFilter];
    html += `<p class="lobby-filter">Chat filter: <b>${filter.name}</b> (${filter.detail}). Change it in the ☰ menu.</p>`;
    if (s.voice.available && !s.voice.inVoice) {
      const why =
        s.voice.micProblem === 'blocked'
          ? 'Your browser blocked the microphone. Allow it for this site in the browser’s settings, then tap here.'
          : s.voice.micProblem === 'missing'
            ? 'No microphone found. Plug one in, then tap here.'
            : 'Everyone here can talk while you play.';
      html += `<button class="voice-cta" data-act="voice" type="button"><span class="vc-icon">${MIC_OFF_SVG}</span><span><b>You’re not in voice chat</b><small>${why}</small></span><span class="vc-join">Join</span></button>`;
    }
    html += '<h3>Pick a game</h3><div class="game-cards">';
    for (const g of pickable()) {
      html += `<button class="game-card" data-game="${g.id}" type="button"><span class="game-icon">${g.icon}</span><span class="game-name">${g.name}${g.underConstruction ? ' <span class="uc-chip">🚧 Under construction</span>' : ''}</span><span class="game-blurb">${g.blurb}</span><span class="game-players">${g.players}</span></button>`;
    }
    html += '</div><p class="hint">Anyone in the room can pick. Chat and voice keep going between games.</p></div>';
    this.el.innerHTML = html;
  }

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const game = t.closest<HTMLElement>('[data-game]')?.dataset.game;
    if (isGameId(game) && canPlayPrivately(game)) {
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
