import { expect, test } from './fixtures';
import { setName, watchErrors } from './helpers';

test('Play drops you into a public tank battle @smoke', async ({ page }) => {
  const errors = watchErrors(page);
  await setName(page, 'Tess');
  // Straight from the home page's list of games.
  await page.locator('[data-play="tanks"]').click();
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'tanks');
  await expect(page.locator('#landing')).toBeHidden();
  const phone = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (phone) {
    // Held upright, phones are asked to turn sideways; turn it and the battle shows.
    await expect(page.locator('#rotate')).toBeVisible();
    await page.setViewportSize({ width: 711, height: 393 });
  }
  await expect(page.locator('#canvas')).toBeVisible();
  await expect(page.locator('#wind-speed')).not.toBeEmpty();
  // The address becomes the game's own page, so it can be shared.
  await expect(page).toHaveURL(/\/tanks(\?|$)/);
  expect(errors).toEqual([]);
});
