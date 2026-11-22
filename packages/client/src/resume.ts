import type { RoomRequest } from '@tank/shared';

/** How you had things at your table: what a reload brings back. */
export interface AsItWas {
  mic: boolean;
  /** The mic was on but muted. */
  muted: boolean;
  /** People you muted just for you: [alias, name]. */
  mutedPeople: [string, string][];
}

/** The table this tab is at (kept for the life of the tab), and how you had it. */
export interface Active extends AsItWas {
  room: RoomRequest;
}

/** Reads back what was kept, also as older pages wrote it (just the room, or the room and the mic). */
export function readActive(raw: string | null): Active | null {
  try {
    const a = raw ? JSON.parse(raw) : null;
    const room = a?.kind ? a : a?.room;
    if (!room?.kind) return null;
    const pair = (x: unknown): x is [string, string] => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string';
    const mutedPeople = Array.isArray(a.mutedPeople) ? a.mutedPeople.filter(pair) : [];
    return { room, mic: a.mic === true, muted: a.muted === true, mutedPeople };
  } catch {
    return null;
  }
}

/**
 * After a reload (or a phone discarding the tab), a tab goes straight back to the table it was
 * at, with the mic as it was. Only from that table's own address, though, which is what a reload
 * or a restored tab has. Any other address means the person asked for something else: another
 * table's invite link, the home page after pressing Back, the privacy page. Going back to the old
 * table then would ignore the link someone just sent, or turn a mic on with no tap.
 */
export function resumesTable(page: { kind: string; code?: string }, tableCode: string): boolean {
  return page.kind === 'join' && page.code === tableCode;
}
