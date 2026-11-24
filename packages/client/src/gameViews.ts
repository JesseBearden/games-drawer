import type { GameId } from '@tank/shared';
import type { ShellApi, View } from './views';

type ViewClass = new (shell: ShellApi) => View;

/** Each game's screen is its own download, fetched when a table picks that game. */
const FETCH: Record<GameId, () => Promise<ViewClass>> = {
  tanks: () => import('./tankView').then((m) => m.TankView),
  hearts: () => import('./heartsView').then((m) => m.HeartsTable),
  spades: () => import('./spadesView').then((m) => m.SpadesTable),
  dominoes: () => import('./dominoesView').then((m) => m.DominoesTable),
  threethirteen: () => import('./threeThirteenView').then((m) => m.ThreeThirteenTable),
  mahjong: () => import('./mahjongView').then((m) => m.MahjongTable),
  jigsaw: () => import('./jigsawView').then((m) => m.JigsawTable),
};

const fetched = new Map<GameId, ViewClass>();
const fetching = new Map<GameId, Promise<ViewClass>>();

/** A game's screen, if it's already here. */
export function gameViewNow(id: GameId): ViewClass | undefined {
  return fetched.get(id);
}

/** Fetch a game's screen (one fetch however many ask). A failed fetch is forgotten, to try again. */
export function fetchGameView(id: GameId): Promise<ViewClass> {
  const ready = fetched.get(id);
  if (ready) return Promise.resolve(ready);
  let p = fetching.get(id);
  if (!p) {
    p = FETCH[id]()
      .then((view) => {
        fetched.set(id, view);
        return view;
      })
      .finally(() => fetching.delete(id));
    fetching.set(id, p);
  }
  return p;
}
