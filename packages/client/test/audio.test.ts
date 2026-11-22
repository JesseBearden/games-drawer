import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sfx } from '../src/audio';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sounds', () => {
  it('one that failed to download is tried again a little later', async () => {
    vi.useFakeTimers();
    let asked = 0;
    vi.stubGlobal('fetch', async () => {
      asked++;
      return { ok: false, status: 503 };
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    vi.stubGlobal('document', { addEventListener: () => {} });
    const sfx = new Sfx();
    Object.assign(sfx, { ctx: {} });
    expect(await sfx.load('sfx/a.wav')).toBeNull();
    await sfx.load('sfx/a.wav');
    expect(asked).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await sfx.load('sfx/a.wav');
    expect(asked).toBe(2);
  });
});
