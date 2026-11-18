import { test as base, expect, type Browser, type Page } from '@playwright/test';

export type VoicePref = 'on' | 'off' | null;

/** Set this browser's remembered voice choice before any page loads (null = never chosen). */
export async function rememberVoice(page: Page | { addInitScript: Page['addInitScript'] }, pref: VoicePref) {
  if (pref) await page.addInitScript((v) => localStorage.setItem('gd.voice', v), pref);
}

/**
 * Voice is on by default, which pops up a prompt in every private room. Most tests aren't about
 * voice, so they start as someone who already said "No thanks"; voice tests pick their own.
 */
export const test = base.extend<{ voicePref: VoicePref }>({
  voicePref: ['off', { option: true }],
  context: async ({ context, voicePref }, use) => {
    await rememberVoice(context, voicePref);
    await use(context);
  },
});

/** A second player in their own browser session, with the same screen as the test's. */
export async function newPlayer(browser: Browser, like: Page, voicePref: VoicePref = 'off') {
  const viewport = like.viewportSize()!;
  const touch = await like.evaluate(() => navigator.maxTouchPoints > 0);
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 3 : 1 });
  await rememberVoice(context, voicePref);
  return context.newPage();
}

export { expect };
