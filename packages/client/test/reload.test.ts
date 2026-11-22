import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadIfSiteAnswers } from '../src/reload';

let reloads: number;

beforeEach(() => {
  reloads = 0;
  const kept = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
  vi.stubGlobal('location', { reload: () => void reloads++ });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a game screen that won’t download', () => {
  it('reloads the page when the site answers', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true }));
    expect(await reloadIfSiteAnswers(() => true)).toBe(true);
    expect(reloads).toBe(1);
  });

  it('never reloads into a dead network', async () => {
    vi.stubGlobal('fetch', async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await reloadIfSiteAnswers(() => true)).toBe(false);
    vi.stubGlobal('fetch', async () => ({ ok: false }));
    expect(await reloadIfSiteAnswers(() => true)).toBe(false);
    expect(reloads).toBe(0);
  });

  it('counts no answer in 5 seconds as no network', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const tried = reloadIfSiteAnswers(() => true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await tried).toBe(false);
    expect(reloads).toBe(0);
  });

  it('doesn’t reload if the table has moved on meanwhile', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true }));
    expect(await reloadIfSiteAnswers(() => false)).toBe(false);
    expect(reloads).toBe(0);
  });
});
