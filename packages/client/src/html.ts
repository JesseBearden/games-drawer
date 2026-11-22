import { TANK_COLORS } from '@tank/shared';

// The small helpers every screen uses. (Apart from state.ts, which is the Tanks game and only
// downloads with it.)

export function colorCss(i: number) {
  return TANK_COLORS[i]?.css ?? '#fff';
}

/** A name inside a sentence: escaped, and never split across two lines ("Aunt Mary" stays together). */
export function nameHtml(name: string) {
  return `<span class="pc-nw">${escapeHtml(name)}</span>`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
