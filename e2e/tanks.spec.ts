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
  // Sideways on a phone the battlefield runs to the top of the screen, under the tabs.
  if (phone) expect((await page.locator('#canvas').boundingBox())!.y).toBe(0);
  // The bar: the mic and the menu (and Messages); Invite and Help are in the menu.
  for (const id of ['#btn-mic', '#btn-menu']) await expect(page.locator(id)).toBeVisible();
  await expect(page.locator('#btn-help')).toBeHidden();
  // Messages: its button, or the panel itself when it's open (computers start with it open).
  await expect(page.locator('#btn-chat:visible, #chat-input:visible').first()).toBeVisible();
  await page.locator('#btn-menu').click();
  await page.locator('#btn-help').click();
  await expect(page.locator('#help')).toBeVisible();
  await page.locator('#help-close').click();
  expect(errors).toEqual([]);
});
