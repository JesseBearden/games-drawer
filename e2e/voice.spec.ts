import { expect, test } from './fixtures';
import { createRoom, joinByInvite, newPlayer, toLobby, tapBar } from './helpers';

// Browsers with fake microphones on this machine; deployed copies are tested by hand.
test.skip(({ isMobile }) => isMobile, 'one screen size is enough');
test.skip(() => !!process.env.E2E_BASE_URL, 'local only');

test('two people who join with their mics on can hear each other', async ({ page: host, browser }) => {
  const friend = await newPlayer(browser, host);
  const code = await createRoom(host, 'Vera', 'jigsaw', 'on');
  await joinByInvite(friend, code, 'Vic', 'on');
  for (const p of [host, friend]) await expect(p.locator('#btn-mic')).toHaveText('Mute mic');

  await tapBar(host, '#btn-menu');
  const peer = host.locator('#menu-mic li[data-peer]', { hasText: 'Vic' });
  await expect(peer).toBeVisible({ timeout: 20_000 });
  // Connected: no "(connecting…)" or "(couldn't connect)" next to their name.
  await expect(peer).not.toContainText('connect', { timeout: 20_000 });
  await friend.context().close();
});

test('"with mic on" turns the mic on, and the bar mutes and unmutes it', async ({ page }) => {
  await createRoom(page, 'Nova', 'jigsaw', 'on');
  const btn = page.locator('#btn-mic');
  await expect(btn).toHaveText('Mute mic');
  await expect(btn).toHaveClass(/pc-btn-main/);
  await btn.click();
  // Muted is tomato, so it's hard to miss.
  await expect(btn).toHaveText('Unmute mic');
  await expect(btn).toHaveClass(/pc-btn-alert/);
  await btn.click();
  await expect(btn).toHaveText('Mute mic');

  // Turning it off completely is in the menu.
  await tapBar(page, '#btn-menu');
  await page.locator('#menu-mic [data-v="leave"]').click();
  await expect(btn).toHaveText('Turn on mic');
});

test('"with mic off" leaves it off, with an easy way to turn it on', async ({ page }) => {
  await createRoom(page, 'Nash', 'jigsaw', 'off');
  const btn = page.locator('#btn-mic');
  await expect(btn).toHaveText('Turn on mic');
  await expect(btn).toHaveClass(/pc-btn-alert/);
  // Between games the picker says so too.
  await toLobby(page);
  await expect(page.locator('.lobby-view .pc-alert')).toContainText('Your mic is off');
  await page.locator('.lobby-view [data-act="voice"]').click();
  await expect(btn).toHaveText('Mute mic');
  await expect(page.locator('.lobby-view .pc-alert')).toHaveCount(0);
});

test('a microphone the browser blocks explains how to allow it', async ({ page }) => {
  // The browser says no to the mic (as if you'd tapped Don't Allow).
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await createRoom(page, 'Bea', 'jigsaw', 'on');
  const btn = page.locator('#btn-mic');
  await expect(btn).toHaveText('Turn on mic');
  await btn.click();
  const help = page.locator('#mic-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('Your mic is blocked');
  // Allowed now: Try again turns it on.
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = (c) => MediaDevices.prototype.getUserMedia.call(navigator.mediaDevices, c);
  });
  await page.locator('#mic-help-retry').click();
  await expect(help).toBeHidden();
  await expect(btn).toHaveText('Mute mic');
});
