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
