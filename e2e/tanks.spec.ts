import { expect, test } from './fixtures';
import { createRoom, watchErrors } from './helpers';

test('a table playing Tanks shows the battle @smoke', async ({ page }) => {
  const errors = watchErrors(page);
  await createRoom(page, 'Tess', 'tanks');
  await expect(page.locator('#landing')).toBeHidden();
  const phone = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (phone) {
    // Held upright, phones are asked to turn sideways; turn it and the battle shows.
    await expect(page.locator('#rotate')).toBeVisible();
    // It names what you're holding (an iPad says iPad).
    await expect(page.locator('#rotate')).toHaveText('Turn your phone sideways to play');
    await page.setViewportSize({ width: 711, height: 393 });
  }
  await expect(page.locator('#canvas')).toBeVisible();
  await expect(page.locator('#wind-speed')).not.toBeEmpty();
  const tab = page.locator('#bar-tab');
  if (phone) {
    // Sideways on a phone the bar folds away and the battlefield runs to the top of the screen;
    // a tab in the corner pulls it down, and using it folds it back up.
    await expect(tab).toBeVisible();
    await expect(page.locator('#btn-menu')).toBeHidden();
    expect((await page.locator('#canvas').boundingBox())!.y).toBe(0);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#btn-help')).toBeVisible();
    await page.locator('#btn-help').click();
    await expect(page.locator('#help')).toBeVisible();
    await expect(page.locator('#btn-help')).toBeHidden();
    await page.locator('#help-close').click();
    await tab.click();
  } else {
    await expect(tab).toBeHidden();
  }
  // The bar: mic, invite, help, menu (and Messages).
  for (const id of ['#btn-mic', '#btn-share', '#btn-help', '#btn-menu']) await expect(page.locator(id)).toBeVisible();
  // Messages: its button, or the panel itself when it's open (computers start with it open).
  await expect(page.locator('#btn-chat:visible, #chat-input:visible').first()).toBeVisible();
  expect(errors).toEqual([]);
});
