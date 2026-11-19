import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createRoom, passThree } from './helpers';

test.skip(({ isMobile }) => !isMobile, 'phone layout only');

/** Every card in the hand is fully on screen, and the hand is centred under the table. */
async function expectHandFits(page: Page) {
  const { width } = page.viewportSize()!;
  // Cards slide into place, so wait for them to settle rather than measuring mid-slide.
  await expect
    .poll(
      async () => {
        const boxes = await page.locator('.ht-hand .card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
        if (!boxes.length) return 'no cards';
        const left = Math.min(...boxes.map((b) => b.left));
        const right = Math.max(...boxes.map((b) => b.right));
        const hand = (await page.locator('.ht-hand').boundingBox())!;
        if (left < 0 || right > width) return `off screen: ${left}-${right} of ${width}`;
        const offCentre = Math.abs((left + right) / 2 - (hand.x + hand.width / 2));
        return offCentre < 4 ? 'ok' : `off centre by ${offCentre}`;
      },
      { timeout: 5000 },
    )
    .toBe('ok');
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('Hearts fits a phone held either way, and turning it keeps the hand centred', async ({ page }) => {
  await createRoom(page, 'Pip', 'hearts');
  await passThree(page);
  await expect(page.locator('.ht-slot .card').first()).toBeVisible({ timeout: 30_000 });
  await expectHandFits(page);

  // Sideways: the hand re-centres, and the cards in the middle stay clear of the player across.
  await page.setViewportSize({ width: 711, height: 340 });
  await expect.poll(async () => (await page.locator('.ht-hand').boundingBox())!.width).toBeGreaterThan(400);
  await page.waitForTimeout(300);
  await expectHandFits(page);
  const across = await page.locator('.ht-pos-2').boundingBox();
  for (const slot of await page.locator('.ht-slot .card').all()) {
    const box = await slot.boundingBox();
    if (box) expect(overlaps(box, across!)).toBe(false);
  }

  // And back upright.
  await page.setViewportSize({ width: 393, height: 711 });
  await page.waitForTimeout(300);
  await expectHandFits(page);
});
