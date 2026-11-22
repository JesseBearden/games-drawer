import { canPlayPrivately, choosesPlayers, GAMES, SEAT_FILL_ORDER, gameInfo, isGameId, isSeated, SEAT_COUNT, type GameId, type MemberInfo, type TableSetup } from '@tank/shared';
import { patchHtml } from './dom';
import { escapeHtml } from './html';
import type { ShellApi, View } from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Each game's felt colour and the order they're listed (the same as home). */
const GAME_PAPER: Record<GameId, string> = { jigsaw: 'sky', dominoes: 'mint', hearts: 'butter', spades: 'lilac', threethirteen: 'blush', tanks: 'peach' };
const ORDER: GameId[] = ['jigsaw', 'dominoes', 'hearts', 'spades', 'threethirteen', 'tanks'];

/** Games a table can pick: everything not switched off (see games.ts). */
const pickable = () => GAMES.filter((g) => canPlayPrivately(g.id)).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

/** "Liz", "Liz and Sam", "Liz, Sam and Mory": each name kept on one line. */
const namesHtml = (names: string[]) => {
  const b = names.map((n) => `<b class="pc-nw">${escapeHtml(n)}</b>`);
  return b.length <= 1 ? (b[0] ?? '') : `${b.slice(0, -1).join(', ')} and ${b.at(-1)}`;
};

/** A selector that finds the same button again after a redraw. (Ready and Not ready are one place.) */
function focusKey(el: HTMLElement): string | null {
  const b = el.closest<HTMLElement>('[data-game], [data-seat], [data-act]');
  if (!b) return null;
  if (b.dataset.game) return `[data-game="${b.dataset.game}"]`;
  if (b.dataset.seat) return `[data-seat="${b.dataset.seat}"]`;
  const act = b.dataset.act!;
  return act === 'ready' || act === 'unready' ? '[data-act="ready"], [data-act="unready"]' : `[data-act="${act}"]`;
}

/** Where each seat sits around the little table: seat 0 nearest you, then on round the table the
 *  way play goes (the same way round as the game shows it). */
const SEAT_PLACE = ['s-near', 's-left', 's-far', 's-right'];

/**
 * The table, between games: where people gather before playing. Who's here (and who's ready),
 * Invite, the mic, a game anyone can pick, seats for the games where it matters, and Ready. The
 * game starts once everyone here is ready.
 */
export class LobbyView implements View {
  readonly landscape = false;
  readonly helpHtml =
    '<p>This is your table. Invite people, pick a game together and, for the card and tile games, pick where you sit.</p><p>Tap <b>I’m ready</b> when you are: the game starts once everyone here is ready. Anyone who’s away doesn’t hold it up, and the computer plays any empty seat.</p><p>Messages and mics keep going between games.</p>';
  private el = $('lobby-view');
  private members: MemberInfo[] = [];
  private speaking = new Set<string>();
  private table: TableSetup;
  /** You just picked a game with seats: bring the seats into view once the table says so. */
  private showSeats = false;

  constructor(private shell: ShellApi) {
    this.table = shell.table();
    this.el.hidden = false;
    this.el.addEventListener('click', this.onClick);
    this.render();
  }

  onMembers(members: MemberInfo[]) {
    this.members = members;
    this.render();
  }

  onVoiceChanged() {
    this.render();
  }

  onTable(table: TableSetup) {
    this.table = table;
    this.render();
    if (this.showSeats && table.pick) {
      this.showSeats = false;
      this.el.querySelector('.tb-seats, .tb-go')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  onSpeaking(aliases: Set<string>) {
    this.speaking = aliases;
    for (const li of this.el.querySelectorAll<HTMLElement>('[data-alias]')) li.classList.toggle('is-talking', aliases.has(li.dataset.alias!));
  }

  private nameOf(alias: string) {
    return this.members.find((m) => m.id === alias)?.name ?? '';
  }

  private render() {
    const s = this.shell;
    const t = this.table;
    const ready = new Set(t.ready);
    let html = '<div class="lobby-paper"><h1 class="pc-h2">Your table</h1>';
    html += '<p>Invite people, pick a game together, and start when everyone’s ready.</p>';

    // Who's here, and Invite.
    // (The parts have keys, so one coming or going doesn't rebuild the buttons in the next.)
    html += '<section class="tb-here" data-key="here"><ul class="lobby-people">';
    for (const m of this.members) {
      const isReady = t.pick && ready.has(m.id);
      const notes = [m.id === s.alias ? 'You' : '', m.connected ? '' : 'Away', isReady ? 'Ready' : ''].filter(Boolean).join(' · ');
      html += `<li data-alias="${escapeHtml(m.id)}" class="pc-tag${m.connected ? '' : ' is-away'}${isReady ? ' is-ready' : ''}${this.speaking.has(m.id) ? ' is-talking' : ''}"><b><span class="pc-talk"><i></i><i></i><i></i></span><span class="pc-nm">${escapeHtml(m.name)}</span></b>${notes ? `<span class="pc-note">${notes}</span>` : ''}</li>`;
    }
    html += '</ul><button class="pc-btn pc-btn-plain tb-invite" data-act="invite" type="button">Invite someone</button></section>';

    if (s.voice.available && !s.voice.inVoice) {
      const why =
        s.voice.micProblem === 'blocked'
          ? 'Your browser is blocking the mic.'
          : s.voice.micProblem === 'missing'
            ? 'No microphone found on this device.'
            : 'Your friends won’t be able to hear you.';
      html += `<div class="pc-alert" data-key="mic"><span style="flex: 1">Your mic is off. ${why}</span><button class="pc-btn pc-btn-plain" data-act="voice" type="button">Turn on mic</button></div>`;
    }

    // The games: anyone can pick, or change the pick.
    html += `<h2 class="pc-h3">Pick a game</h2><p class="tb-sub">Anyone at the table can pick${t.pick ? ' another' : ''}.</p>`;
    html += '<div class="pc-choices lobby-games" data-key="games">';
    for (const g of pickable()) {
      const picked = g.id === t.pick;
      html += `<button class="pc-choice paper-${GAME_PAPER[g.id] ?? 'sky'}${picked ? ' is-picked' : ''}" data-game="${g.id}" type="button" aria-pressed="${picked}"><img src="/art/games/${g.id}.webp" alt="" width="52" height="52" /><span>${escapeHtml(g.name)}${g.underConstruction ? '<small>Work in Progress</small>' : ''}</span></button>`;
    }
    html += '</div>';

    if (t.pick && isSeated(t.pick)) html += this.seatsHtml(t.pick);

    if (t.pick) html += this.goHtml(t.pick);
    html += '</div>';
    // Redrawn whenever anyone moves: keep the keyboard or controller on the same button.
    const focused = document.activeElement as HTMLElement | null;
    const key = focused && this.el.contains(focused) ? focusKey(focused) : null;
    patchHtml(this.el, html);
    if (key && !this.el.contains(document.activeElement)) this.el.querySelector<HTMLElement>(key)?.focus({ preventScroll: true });
  }

  /** The seats around a little table: tap one to sit there. */
  private seatsHtml(game: GameId) {
    const t = this.table;
    const ready = new Set(t.ready);
    const away = new Set(this.members.filter((m) => !m.connected).map((m) => m.id));
    let html = `<section class="tb-seats" data-key="seats">`;
    // Games that let the table choose how many play (the server picks the seats the same way).
    const chooses = choosesPlayers(game);
    // (Counted as the server deals: someone who has gone only plays if they'd picked a seat.)
    const people = Math.min(SEAT_COUNT, this.members.filter((m) => m.connected || t.seats.includes(m.id)).length);
    const count = chooses ? Math.max(2, Math.min(SEAT_COUNT, Math.max(t.players, people))) : SEAT_COUNT;
    const inPlay = new Set(t.seats.flatMap((s, i) => (s ? [i] : [])));
    for (const i of SEAT_FILL_ORDER) if (inPlay.size < count) inPlay.add(i);
    if (chooses) {
      html += '<h2 class="pc-h3">How many players?</h2><div class="tb-count" role="radiogroup" aria-label="How many players">';
      for (let k = 2; k <= SEAT_COUNT; k++) {
        const on = k === count;
        html += `<button class="pc-btn ${on ? 'pc-btn-main' : 'pc-btn-plain'}" data-players="${k}" role="radio" aria-checked="${on}" type="button"${k < people ? ' disabled' : ''}>${k}</button>`;
      }
      const computers = count - people;
      html += `</div><p class="tb-sub">${count} players: ${computers <= 0 ? 'just the people here, no computers' : `${people === 1 ? 'you' : `the ${people} people here`} and ${computers === 1 ? 'a computer' : `${computers} computers`}`}.</p>`;
    }
    html += '<h2 class="pc-h3">Pick your seat</h2><div class="tb-ring">';
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const who = t.seats[seat] ?? null;
      const mine = who === this.shell.alias;
      const name = who ? this.nameOf(who) : '';
      const off = !who && !inPlay.has(seat);
      const note = off ? 'Not playing' : !who ? 'Tap to sit' : [mine ? 'You' : '', away.has(who) ? 'Away' : '', ready.has(who) ? 'Ready' : ''].filter(Boolean).join(' · ');
      const cls = `tb-seat ${SEAT_PLACE[seat]}${!who ? ' is-open' : ''}${off ? ' is-off' : ''}${mine ? ' is-mine' : ''}${who && ready.has(who) ? ' is-ready' : ''}`;
      const label = off ? 'Empty' : !who ? 'Open seat' : name;
      html += `<button class="${cls}" data-seat="${seat}" type="button"${who && !mine ? ' aria-disabled="true"' : ''}><span class="pc-nm">${escapeHtml(label)}</span>${note ? `<small>${note}</small>` : ''}</button>`;
    }
    html += `<div class="tb-mat" aria-hidden="true"><img src="/art/games/${game}.webp" alt="" width="52" height="52" /></div></div>`;

    const notes: string[] = [chooses ? 'Tap a seat to sit there. Anyone who doesn’t pick gets a free seat in play.' : 'Tap a seat to sit there. Anyone who doesn’t pick gets a free seat, and the computer plays the rest.'];
    if (game === 'spades') {
      // "Jesse and Mom play against Sam and the computer": people first, the computer once.
      const team = (a: number, b: number) => [a, b].map((i) => t.seats[i]).filter((x): x is string => !!x).map((x) => this.nameOf(x));
      const side = (names: string[]) => (names.length === 2 ? namesHtml(names) : names.length === 1 ? `${namesHtml(names)} and the computer` : 'the computer');
      const [one, two] = [team(0, 2), team(1, 3)].sort((x, y) => y.length - x.length);
      notes.push(`Partners sit across from each other.${one.length ? ` ${side(one)} ${one.length === 1 ? 'plays' : 'play'} against ${side(two)}.` : ''}`);
    }
    if (this.members.filter((m) => m.connected).length > SEAT_COUNT) notes.push('Only four can play: anyone without a seat watches.');
    html += notes.map((n) => `<p class="tb-sub">${n}</p>`).join('');
    return html + '</section>';
  }

  /** The strip that stays at the bottom: what's next, who we're waiting for, and Ready. */
  private goHtml(game: GameId) {
    const t = this.table;
    const ready = new Set(t.ready);
    const me = this.shell.alias;
    const others = this.members.filter((m) => m.connected && m.id !== me);
    const waiting = others.filter((m) => !ready.has(m.id));
    const amReady = ready.has(me);
    let status: string;
    if (amReady) status = waiting.length ? `Waiting for ${namesHtml(waiting.map((m) => m.name))}.` : 'Starting…';
    else if (!others.length) status = 'It starts as soon as you’re ready.';
    else if (!waiting.length) status = 'Everyone else is ready.';
    else {
      const set = others.filter((m) => ready.has(m.id));
      status = set.length ? `${namesHtml(set.map((m) => m.name))} ${set.length === 1 ? 'is' : 'are'} ready.` : 'It starts when everyone here is ready.';
    }
    const btn = amReady
      ? '<button class="pc-btn pc-btn-plain pc-btn-big" data-act="unready" type="button">Not ready</button>'
      : '<button class="pc-btn pc-btn-main pc-btn-big" data-act="ready" type="button">I’m ready</button>';
    return `<div class="tb-go" data-key="go"><p><span class="tb-next">${escapeHtml(gameInfo(game).name)}</span><span class="tb-status">${status}</span></p>${btn}</div>`;
  }

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const game = t.closest<HTMLElement>('[data-game]')?.dataset.game;
    if (isGameId(game) && canPlayPrivately(game)) {
      if (game === this.table.pick) return;
      this.shell.play('lobbyJoin');
      this.showSeats = isSeated(game);
      this.shell.pickGame(game);
      return;
    }
    const players = t.closest<HTMLElement>('[data-players]')?.dataset.players;
    if (players !== undefined) {
      this.shell.setPlayers(Number(players));
      return;
    }
    const seat = t.closest<HTMLElement>('[data-seat]')?.dataset.seat;
    if (seat !== undefined) {
      this.shell.sit(Number(seat));
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'invite') this.shell.share();
    else if (act === 'voice') this.shell.voice.join();
    else if (act === 'ready' || act === 'unready') this.shell.setReady(act === 'ready');
  };

  dispose() {
    this.el.removeEventListener('click', this.onClick);
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}
