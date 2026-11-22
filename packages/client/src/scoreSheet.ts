/* The card games' score sheet, as HTML (kept apart from the views so it can be tested on its own). */

/**
 * A score sheet: one row per player, name on the left (one line), the points each hand scored
 * across, and the running total at the end. `history` is the running totals after each hand, one
 * array per row. With no room for every hand the oldest drop off: phones show the last 3,
 * anything else the last 8. `fresh` picks out the hand that just ended. `unit` heads each column
 * (Three Thirteen plays rounds, not hands); phones show only its number, leaving room for the names.
 */
export function scoreSheetHtml(rows: { label: string; history: number[]; total: number }[], fresh: boolean, unit = 'Hand'): string {
  const n = rows[0]?.history.length ?? 0;
  const cls = (i: number) => {
    const back = n - 1 - i;
    return `ht-h${back >= 8 ? ' ht-older' : back >= 3 ? ' ht-old' : ''}${fresh && back === 0 ? ' ht-fresh' : ''}`;
  };
  const num = (x: number) => (x < 0 ? `−${-x}` : String(x));
  let html = '<table class="ht-table ht-sheet"><thead><tr><th class="ht-who"></th>';
  for (let i = 0; i < n; i++) html += `<th class="${cls(i)}"><span class="ht-unit">${unit} </span>${i + 1}</th>`;
  html += '<th class="ht-tot">Total</th></tr></thead><tbody>';
  for (const r of rows) {
    html += `<tr><th class="ht-who" scope="row"><span class="pc-nm">${r.label}</span></th>`;
    r.history.forEach((t, i) => (html += `<td class="${cls(i)}">${num(t - (i ? r.history[i - 1] : 0))}</td>`));
    html += `<td class="ht-tot">${num(r.total)}</td></tr>`;
  }
  return html + '</tbody></table>';
}
