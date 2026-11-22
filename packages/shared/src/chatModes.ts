// The chat filter's settings, apart from the filter itself: every page knows these, and only a
// table needs the word lists.

export type ChatFilterMode = 'none' | 'hide' | 'block';
export const CHAT_FILTER_MODES: ChatFilterMode[] = ['none', 'hide', 'block'];
export const MAX_CHAT_LENGTH = 200;

export function isChatFilterMode(v: unknown): v is ChatFilterMode {
  return v === 'none' || v === 'hide' || v === 'block';
}

/** What each setting does, for the menu and for the announcement in chat. */
export const CHAT_FILTER_LABELS: Record<ChatFilterMode, { name: string; detail: string }> = {
  none: { name: 'None', detail: 'swearing shows as typed (slurs are still blocked)' },
  hide: { name: 'Hide', detail: 'swear words show as ****' },
  block: { name: 'Block', detail: 'messages with swearing aren’t sent' },
};
