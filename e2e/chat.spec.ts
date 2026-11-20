import { expect, test } from './fixtures';
import { createRoom, joinByInvite, newPlayer, tapBar } from './helpers';

test.skip(({ isMobile }) => isMobile, 'one screen size is enough');

const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

test('tables star out swearing by default, and anyone can switch the filter', async ({ page: host, browser }) => {
  const friend = await newPlayer(browser, host);
  const code = await createRoom(host, 'Holly');
  await joinByInvite(friend, code, 'Fern');
  await expect(host.locator('#menu-filter [data-filter="hide"]')).toHaveAttribute('aria-checked', 'true');

  const input = host.locator('#chat-input');
  const send = host.locator('#chat-send');
  await expect(send).toBeDisabled(); // nothing typed yet
  await input.fill('well shit');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(friend.locator('#chat-log')).toContainText('well ****');

  // The friend switches to Block from the menu; everyone sees the change.
  await tapBar(friend, '#btn-menu');
  await friend.locator('#menu-filter [data-filter="block"]').click();
  await expect(friend.locator('#menu-filter [data-filter="block"]')).toHaveAttribute('aria-checked', 'true');
  await expect(host.locator('#chat-log')).toContainText('set the chat filter to Block');
  await expect(host.locator('#menu-filter [data-filter="block"]')).toHaveAttribute('aria-checked', 'true');

  // Now Send greys out for swearing, with a reminder, and comes back for clean messages.
  await input.fill('well shit');
  await expect(send).toBeDisabled();
  await expect(host.locator('#chat-hint')).toBeVisible();
  await expect(host.locator('#chat-hint')).toContainText('family friendly');
  await input.press('Enter');
  await expect(friend.locator('#chat-log')).not.toContainText('well shit');
  await input.fill('nice shot');
  await expect(send).toBeEnabled();
  await expect(host.locator('#chat-hint')).toBeHidden();

  // Slurs stay blocked even with the filter off.
  await friend.locator('#menu-filter [data-filter="none"]').click();
  await expect(host.locator('#chat-log')).toContainText('set the chat filter to None');
  await input.fill(`you ${rot13('avttre')}`);
  await expect(send).toBeDisabled();
  await input.fill('well shit');
  await expect(send).toBeEnabled();
  await friend.context().close();
});
