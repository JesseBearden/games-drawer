import { canPlayPrivately, CHAT_FILTER_LABELS, GAMES, isGameId, type GameId, type MemberInfo } from '@tank/shared';
import { escapeHtml } from './state';
import type { ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Each game's paper colour and the order they're listed (the same as the start page). */
const GAME_PAPER: Record<GameId, string> = { jigsaw: 'sky', dominoes: 'mint', hearts: 'butter', spades: 'lilac', tanks: 'peach' };
const ORDER: GameId[] = ['jigsaw', 'dominoes', 'hearts', 'spades', 'tanks'];

/** Games a table can pick: everything not switched off (see games.ts). */
const pickable = () => GAMES.filter((g) => canPlayPrivately(g.id)).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

/** Between games (Menu, Switch game): who's at the table, and a game picker anyone can use. */
export class LobbyView implements View {
  readonly landscape = false;
  readonly helpHtml = '<p>Pick a game to start it for everyone at the table. Messages and mics keep going between games.</p>';
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
    for (const li of this.el.querySelectorAll<HTMLElement>('[data-alias]')) li.classList.toggle('is-talking', aliases.has(li.dataset.alias!));
  }

  private render() {
    const s = this.shell;
    let html = '<div class="lobby-paper"><h1 class="pc-h2">Pick a game</h1>';
    html += '<p>Anyone at the table can pick. Messages and mics keep going between games.</p>';
    html += '<div class="pc-choices lobby-games">';
    for (const g of pickable()) {
      html += `<button class="pc-choice paper-${GAME_PAPER[g.id] ?? 'sky'}" data-game="${g.id}" type="button"><img src="/art/games/${g.id}.webp" alt="" width="52" height="52" /><span>${escapeHtml(g.name)}${g.underConstruction ? '<small>Work in Progress</small>' : ''}</span></button>`;
    }
    html += '</div><h2 class="pc-h3">At the table</h2><ul class="lobby-people">';
    for (const m of this.members) {
      const notes = [m.id === s.alias ? 'You' : '', m.connected ? '' : 'Away'].filter(Boolean).join(' · ');
      html += `<li data-alias="${escapeHtml(m.id)}" class="pc-tag${m.connected ? '' : ' is-away'}${this.speaking.has(m.id) ? ' is-talking' : ''}"><b><span class="pc-talk"><i></i><i></i><i></i></span>${escapeHtml(m.name)}</b>${notes ? `<span class="pc-note">${notes}</span>` : ''}</li>`;
    }
    html += '</ul>';
    if (s.voice.available && !s.voice.inVoice) {
      const why =
        s.voice.micProblem === 'blocked'
          ? 'Your browser is blocking the mic.'
          : s.voice.micProblem === 'missing'
            ? 'No microphone found on this device.'
            : 'Everyone here can talk while you play.';
      html += `<div class="pc-alert"><span style="flex: 1">Your mic is off. ${why}</span><button class="pc-btn pc-btn-plain" data-act="voice" type="button">Turn on mic</button></div>`;
    }
    const filter = CHAT_FILTER_LABELS[s.chatFilter];
    // (The table code is in the Invite sheet, for reading out over the phone.)
    html += `<div class="lobby-bottom"><button class="pc-btn pc-btn-plain" data-act="invite" type="button">Invite someone</button></div>`;
    html += `<p class="lobby-filter pc-small">Message filter: <b>${filter.name}</b> (${filter.detail}). Change it in the Menu.</p></div>`;
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
