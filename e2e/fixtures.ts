import { test as base, expect, type Browser, type Page } from '@playwright/test';

/** Every test starts in a fresh browser session (no remembered name). */
export const test = base;

/** A second player in their own browser session, with the same screen as the test's. */
export async function newPlayer(browser: Browser, like: Page) {
  const viewport = like.viewportSize()!;
  const touch = await like.evaluate(() => navigator.maxTouchPoints > 0);
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 3 : 1 });
  return context.newPage();
}

export { expect };
