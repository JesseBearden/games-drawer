/**
 * Mahjong's Learning Mode (user, 2026-11-24): every discard asks each person what they'd do with
 * it, and anything that can't be done is explained in a line or two, with the tiles in their hand
 * that matter lit up. These read only the player's own tiles and what everyone can see.
 */
import { mjIndex, mjTileName, MJ_KINDS, type MjClaimKind, type MjMeld, type MjOptions, type MjTile } from './mahjong';

export type MjLearnChoice = 'pung' | 'chow' | 'kong' | 'win';

/** Why a choice can't be made: a short explanation, and the tiles in your hand it's about. */
export interface MjWhyNot {
  text: string;
  help: MjTile[];
}

const NUMBER_WORDS = ['none', 'one', 'two', 'three', 'four'];
const SUIT_WORDS = ['dots', 'bamboo', 'characters'];

/** "5 dots", "East winds", "Red dragons": more than one of a tile. */
export function mjTilesName(t: MjTile): string {
  const name = mjTileName(t);
  return /(wind|dragon)$/.test(name) ? `${name}s` : name;
}

const countIn = (tiles: readonly MjTile[], t: MjTile) => tiles.filter((x) => x === t).length;
const suitedIndex = (i: number) => i < 27;

/** The pairs that make a run with a suited tile: for the 5 dots, 3-4, 4-6 and 6-7. */
function runPairs(t: MjTile): [MjTile, MjTile][] {
  const i = mjIndex(t);
  const n = i % 9;
  const out: [MjTile, MjTile][] = [];
  for (let lo = n - 2; lo <= n; lo++) {
    if (lo < 0 || lo > 6) continue;
    const others = [lo, lo + 1, lo + 2].filter((k) => k !== n).map((k) => MJ_KINDS[i - n + k]);
    out.push([others[0], others[1]]);
  }
  return out;
}

/** "3 and 4, 4 and 6, or 6 and 7 dots". */
function pairsText(t: MjTile): string {
  const suit = SUIT_WORDS[Math.floor(mjIndex(t) / 9)];
  const parts = runPairs(t).map(([a, b]) => `${(mjIndex(a) % 9) + 1} and ${(mjIndex(b) % 9) + 1}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, or ${parts.at(-1)}` : parts[0];
  return `${list} ${suit}`;
}

export interface MjOfferContext {
  /** The tile on offer. */
  tile: MjTile;
  /** Your concealed tiles. */
  hand: readonly MjTile[];
  /** It was added to a Pung (a Kong that could be robbed), not thrown away. */
  addedKong: boolean;
  /** Tiles left in the wall. */
  wallLeft: number;
  /** Your seat, and whose tile it is. */
  seat: number;
  from: number;
  /** Everyone's names, by seat. */
  names: readonly string[];
  /** What the rules say you can do with it. */
  options: MjOptions;
}

/** Someone else's tile is on offer: why you can't take it this way (null: you can). */
export function mjClaimWhyNot(choice: MjLearnChoice, c: MjOfferContext): MjWhyNot | null {
  const o = c.options;
  if (choice === 'win' ? o.win : choice === 'pung' ? o.pung : choice === 'kong' ? o.kong : o.chows.length > 0) return null;
  const name = mjTilesName(c.tile);
  const have = countIn(c.hand, c.tile);
  const same = c.hand.filter((x) => x === c.tile);
  if (choice === 'win') return { text: 'This tile doesn’t finish your hand: you need four sets and a pair.', help: [] };
  if (c.addedKong) return { text: 'A tile added to a Pung to make a Kong can only be taken for Mahjong.', help: [] };
  if (!c.wallLeft) return { text: 'That was the last tile from the wall: it can only be taken for Mahjong.', help: [] };
  if (choice === 'pung') {
    return { text: `A Pung is three of a kind: you’d need two ${name} in your hand, and you have ${NUMBER_WORDS[have]}.`, help: same };
  }
  if (choice === 'kong') {
    return { text: `A Kong is four of a kind: you’d need three ${name} in your hand, and you have ${NUMBER_WORDS[have]}.`, help: same };
  }
  // A Chow.
  const before = (c.seat + 3) % 4;
  if (c.from !== before) {
    return {
      text: `You can only make a Chow with a tile from ${c.names[before]}, the player right before you. A tile from anyone can make a Pung, a Kong or Mahjong.`,
      help: [],
    };
  }
  const i = mjIndex(c.tile);
  if (!suitedIndex(i)) return { text: 'Winds and dragons can’t make a run, so they can’t make a Chow.', help: [] };
  // Tiles of the same suit close by: the ones that would help.
  const near = new Set(runPairs(c.tile).flat());
  const help = [...new Set(c.hand.filter((x) => near.has(x)))];
  return { text: `A Chow is a run of three in one suit: with the ${mjTileName(c.tile)} you’d need ${pairsText(c.tile)} in your hand.`, help };
}

export interface MjTurnContext {
  hand: readonly MjTile[];
  melds: readonly MjMeld[];
  /** What you can declare now (from the game). */
  self: { win: boolean; kongs: MjTile[] };
  /** You drew this turn (rather than taking a tile for a set). */
  drew: boolean;
  wallLeft: number;
}

/** Your own turn: why you can't go Mahjong or make a Kong now (null: you can). */
export function mjTurnWhyNot(choice: 'win' | 'kong', c: MjTurnContext): MjWhyNot | null {
  if (choice === 'win') return c.self.win ? null : { text: 'Your tiles don’t make a finished hand yet: you need four sets and a pair.', help: [] };
  if (c.self.kongs.length) return null;
  if (!c.drew) return { text: 'Right after taking a tile for a set, you throw one away. A Kong from your own tiles waits for a turn when you draw.', help: [] };
  if (!c.wallLeft) return { text: 'The wall is empty, so there’s no tile to replace one: no more Kongs.', help: [] };
  // What's closest: three of a kind in the hand, or a Pung on the table.
  const threes = [...new Set(c.hand)].filter((t) => countIn(c.hand, t) === 3);
  const pungs = c.melds.filter((m) => m.kind === 'pung').map((m) => m.tiles[0]);
  const rule = 'On your turn a Kong is all four of a tile from your hand, or the fourth added to a Pung you’ve made.';
  if (threes.length) return { text: `${rule} You have three ${mjTilesName(threes[0])}: the fourth would make one.`, help: [threes[0], threes[0], threes[0]] };
  if (pungs.length) return { text: `${rule} The fourth ${mjTileName(pungs[0])} would go with your Pung.`, help: [] };
  return { text: rule, help: [] };
}

/** You passed on a tile you could have taken for a set: what you could have made (null: nothing). */
export function mjMissedClaim(options: MjOptions | null, tile: MjTile, hand: readonly MjTile[]): string | null {
  if (!options) return null;
  const name = mjTilesName(tile);
  const could: string[] = [];
  if (options.kong) could.push(`a Kong with your three ${name}`);
  else if (options.pung) could.push(`a Pung with your two ${name}`);
  for (const lo of options.chows) {
    const i = mjIndex(lo);
    const run = [i, i + 1, i + 2].map((k) => MJ_KINDS[k]).filter((t) => t !== tile && hand.includes(t));
    const suit = SUIT_WORDS[Math.floor(i / 9)];
    could.push(`a Chow with your ${run.map((t) => (mjIndex(t) % 9) + 1).join(' and ')} ${suit}`);
  }
  if (!could.length) return null;
  return `You could have made ${could.length > 1 ? `${could.slice(0, -1).join(', ')}, or ${could.at(-1)}` : could[0]}.`;
}

/** You threw a tile away when you could have declared a Kong: what it would have been (null: none). */
export function mjMissedKong(kongs: readonly MjTile[], melds: readonly MjMeld[]): string | null {
  const t = kongs[0];
  if (!t) return null;
  const added = melds.some((m) => m.kind === 'pung' && m.tiles[0] === t);
  return added ? `You could have added your ${mjTileName(t)} to your Pung to make a Kong.` : `You could have made a Kong with your four ${mjTilesName(t)}.`;
}

/** You asked for the tile, but someone else's claim came first: why. */
export function mjLostClaim(mine: MjClaimKind, taker: string, kind: 'pung' | 'kong' | 'chow' | 'win'): string | null {
  if (mine === 'pass' || mine === 'win') return null;
  if (kind === 'win') return `${taker} went Mahjong on it, which comes before everything else.`;
  if (mine === 'chow' && kind !== 'chow') return `${taker} took it for a ${kind === 'kong' ? 'Kong' : 'Pung'}, which comes before a Chow.`;
  return null;
}
