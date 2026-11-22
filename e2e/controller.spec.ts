import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createRoom } from './helpers';

// A pretend Xbox controller (standard mapping) the page reads through navigator.getGamepads().
test.skip(({ isMobile }) => isMobile, 'controllers are tested on the desktop layout');
test.skip(() => !!process.env.E2E_BASE_URL, 'local only');

const BUTTON = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, view: 8, menu: 9, up: 12, down: 13, left: 14, right: 15 };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const pad = {
      id: 'Test controller (STANDARD GAMEPAD)',
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    (window as unknown as { __pad: typeof pad }).__pad = pad;
    navigator.getGamepads = () => [pad as unknown as Gamepad];
  });
});

async function press(page: Page, name: keyof typeof BUTTON) {
  const set = (down: boolean) =>
    page.evaluate(
      ([i, d]) => {
        const b = (window as unknown as { __pad: { buttons: { pressed: boolean; value: number }[] } }).__pad.buttons[i as number];
        b.pressed = d as boolean;
        b.value = d ? 1 : 0;
      },
      [BUTTON[name], down],
    );
  // About as long as a person holds a button, and never less than two frames: the page checks the
  // controller once a frame, and on a busy machine a frame can take longer than that.
  const frames = () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await set(true);
  await page.waitForTimeout(90);
  await frames();
  await set(false);
  await page.waitForTimeout(60);
  await frames();
}

/** Press a direction until the highlighted element matches. */
async function moveUntil(page: Page, dir: 'up' | 'down' | 'left' | 'right', selector: string, tries = 12) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate((sel) => !!document.activeElement?.matches(sel), selector)) return;
    await press(page, dir);
  }
  expect(await page.evaluate((sel) => !!document.activeElement?.matches(sel), selector)).toBe(true);
}

test('a controller gets you from the home page into Hearts and plays a hand', async ({ page }) => {
  await page.goto('/');
  await moveUntil(page, 'down', '#home-start');
  await press(page, 'a');
  await expect(page.locator('#page-start')).toBeVisible();
  // Typing a name is for the keyboard; the d-pad starts the table…
  await page.locator('#start-name').fill('Pad');
  await moveUntil(page, 'down', '#start-form button[value="off"]');
  await press(page, 'a');
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'lobby');
  // …then picks Hearts at the table and says it's ready.
  await moveUntil(page, 'down', '[data-game]', 20);
  await moveUntil(page, 'right', '[data-game="hearts"]', 6);
  await press(page, 'a');
  await expect(page.locator('[data-game="hearts"]')).toHaveAttribute('aria-pressed', 'true');
  await moveUntil(page, 'down', '.tb-go [data-act="ready"]', 20);
  await press(page, 'a');
  await expect(page.locator('#hearts-view .ht-hand .card')).toHaveCount(13);
  // Let the card pictures finish loading, as they would before a person picks up the controller.
  await page.waitForTimeout(800);

  // Left/right highlights a card, A picks it, Y passes the three.
  for (let i = 0; i < 3; i++) {
    await press(page, 'right');
    await press(page, 'a');
  }
  await expect(page.locator('#hearts-view .card.raised')).toHaveCount(3);
  await press(page, 'y');
  await expect(page.locator('#hearts-view .ht-action')).toBeHidden();

  // When it's our turn, A plays the highlighted card (straight away: no second tap needed).
  await expect(page.locator('#hearts-view .ht-hand.my-turn')).toBeVisible({ timeout: 30_000 });
  const before = await page.locator('#hearts-view .ht-hand .card').count();
  await press(page, 'right');
  await press(page, 'left');
  const cursor = page.locator('#hearts-view .card.pad-cursor');
  await expect(cursor).toHaveCount(1);
  if (!(await cursor.evaluate((el) => el.classList.contains('legal')))) {
    // Walk to a card we're allowed to play.
    for (let i = 0; i < 13 && !(await page.locator('#hearts-view .card.pad-cursor.legal').count()); i++) await press(page, 'right');
  }
  await press(page, 'a');
  await expect(page.locator('#hearts-view .ht-hand .card')).toHaveCount(before - 1);

  // Menu opens the menu; B closes it.
  await press(page, 'menu');
  await expect(page.locator('#menu')).toBeVisible();
  await press(page, 'b');
  await expect(page.locator('#menu')).toBeHidden();
});

test('in Tanks the left stick aims and sets power', async ({ page }) => {
  await createRoom(page, 'Stick', 'tanks');
  const angle = page.locator('#aim-angle');
  await expect(angle).not.toBeEmpty();
  const start = parseInt((await angle.textContent())!, 10);
  await page.evaluate(() => {
    (window as unknown as { __pad: { axes: number[] } }).__pad.axes[0] = -1;
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    (window as unknown as { __pad: { axes: number[] } }).__pad.axes[0] = 0;
  });
  await expect.poll(async () => parseInt((await angle.textContent())!, 10)).toBeGreaterThan(start + 10);
});
