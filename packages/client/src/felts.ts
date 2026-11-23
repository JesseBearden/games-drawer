/**
 * Each person's own felt (a trial, the user's idea, 2026-11-22): their name tag on Your table, the
 * seat they pick there, and their name tag in a game (Dominoes so far). It comes from the colour
 * number the table gives everyone as they arrive (kept if they drop out and come back; computer
 * players get the free ones), so it stays with the name and everyone sees the same.
 *
 * Only light felts the dark ink reads on, and never yellow (whose turn it is), red (something's
 * off), cobalt (a button) or grass (it would vanish into the green table). The first four are the
 * ones a table of four usually gets.
 */
export const PERSON_FELTS = ['sky', 'lilac', 'peach', 'mint', 'blush', 'kraft', 'white', 'dove'] as const;

export type PersonFelt = (typeof PERSON_FELTS)[number];

export function personFelt(color: number): PersonFelt {
  const n = PERSON_FELTS.length;
  return PERSON_FELTS[((Math.trunc(color) % n) + n) % n];
}

/**
 * The felt for each seat in a game: a person keeps their own (even while away and a computer
 * plays for them); computer players take the felts nobody at the table has, in order, so four
 * players usually get the first four. Worked out from the game's view, so everyone sees the same.
 */
export function seatFelts(seats: readonly { bot: boolean; color: number }[]): PersonFelt[] {
  const taken = new Set(seats.filter((s) => !s.bot).map((s) => personFelt(s.color)));
  const spare = PERSON_FELTS.filter((f) => !taken.has(f));
  let next = 0;
  return seats.map((s) => (s.bot ? spare[next++ % spare.length] : personFelt(s.color)));
}
