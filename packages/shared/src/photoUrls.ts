/**
 * The addresses of a table's photos. They live in the memory of the box the table is on, so like
 * the table's other requests they say which box that is (?slot=): without it the web server sends
 * them to the box taking new tables, which doesn't have the table during a canary or while an old
 * box finishes its games.
 */
import { slotOfCode } from './protocol';

/** Where a photo at a table is shown from. */
export const photoUrl = (table: string, id: string) => `/api/photo/${table}/${id}.jpg?slot=${slotOfCode(table)}`;

/** Where someone at a table sends a photo to add it. */
export const photoUploadUrl = (table: string) => `/api/photo?table=${encodeURIComponent(table)}&slot=${slotOfCode(table)}`;
