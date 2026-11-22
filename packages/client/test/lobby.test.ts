import { afterEach, describe, expect, it, vi } from 'vitest';

let html = '';
vi.mock('../src/dom', () => ({ patchHtml: (_el: unknown, next: string) => void (html = next) }));

import { LobbyView } from '../src/lobby';

afterEach(() => vi.unstubAllGlobals());

describe('how many players, at the table', () => {
  it('doesn’t count someone who has gone, so the two people here can choose 2', () => {
    const el = { hidden: true, addEventListener() {}, removeEventListener() {}, contains: () => false, innerHTML: '' };
    vi.stubGlobal('document', { getElementById: () => el, activeElement: null });
    const table = { pick: 'threethirteen', seats: [null, null, null, null], ready: [], players: 2 };
    const view = new LobbyView({ alias: 'jesse', table: () => table, voice: { available: false } } as never);
    view.onMembers([
      { id: 'jesse', name: 'Jesse', color: 0, connected: true },
      { id: 'mom', name: 'Mom', color: 1, connected: true },
      { id: 'gone', name: 'Sam', color: 2, connected: false },
    ]);
    expect(html).toMatch(/data-players="2" role="radio" aria-checked="true" type="button">2</);
    expect(html).toContain('2 players: just the people here, no computers.');
    view.dispose();
  });
});
