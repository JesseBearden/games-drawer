import { expect, test } from './fixtures';
import { createRoom, joinByInvite, newPlayer } from './helpers';

// Two browsers with fake microphones on this machine; deployed copies are tested by hand.
test.skip(({ isMobile }) => isMobile, 'one screen size is enough');
test.skip(() => !!process.env.E2E_BASE_URL, 'local only');

test('two people in a room can join voice and connect to each other', async ({ page: host, browser }) => {
  const friend = await newPlayer(browser, host);
  const code = await createRoom(host, 'Vera');
  await joinByInvite(friend, code, 'Vic');

  for (const p of [host, friend]) await p.locator('.voice-cta').click();
  await host.locator('#btn-voice').click();
  const peer = host.locator('#voice-panel .voice-peers li', { hasText: 'Vic' });
  await expect(peer).toBeVisible({ timeout: 20_000 });
  // Connected: no "(connecting…)" or "(couldn't connect)" next to their name.
  await expect(peer).not.toContainText('connect', { timeout: 20_000 });
  await expect(host.locator('#btn-voice')).toContainText('2');
  await friend.context().close();
});

test.describe('voice is on by default', () => {
  test.use({ voicePref: null });

  async function leaveRoom(page: import('@playwright/test').Page) {
    await page.locator('#btn-menu').click();
    await page.locator('#menu-leave').click();
    await expect(page.locator('#home-head')).toBeVisible();
  }

  test('a new player is asked once; yes turns voice on and is remembered, leaving voice turns it off for good', async ({ page }) => {
    await createRoom(page, 'Nova');
    const prompt = page.locator('.voice-prompt');
    await expect(prompt).toContainText('Games Drawer is better with conversation');
    await prompt.locator('[data-vp="on"]').click();
    await expect(prompt).toBeHidden();
    await expect(page.locator('#btn-voice')).toHaveClass(/active/);
    expect(await page.evaluate(() => localStorage.getItem('gd.voice'))).toBe('on');

    // Next room: no question, straight into voice.
    await leaveRoom(page);
    await createRoom(page, 'Nova');
    await expect(page.locator('#btn-voice')).toHaveClass(/active/);
    await expect(prompt).toHaveCount(0);

    // Turning voice off is remembered too.
    await page.locator('#btn-voice').click();
    await page.locator('#voice-panel [data-v="leave"]').click();
    expect(await page.evaluate(() => localStorage.getItem('gd.voice'))).toBe('off');
    await leaveRoom(page);
    await createRoom(page, 'Nova');
    await expect(prompt).toHaveCount(0);
    await expect(page.locator('#btn-voice')).not.toHaveClass(/active/);
  });

  test('"No thanks" keeps voice off and isn’t asked again', async ({ page }) => {
    await createRoom(page, 'Nash');
    await page.locator('.voice-prompt [data-vp="off"]').click();
    await expect(page.locator('.voice-prompt')).toHaveCount(0);
    await expect(page.locator('#btn-voice')).not.toHaveClass(/active/);
    // Out of voice is hard to miss: a red, crossed-out mic, and a big "join" in the lobby.
    await expect(page.locator('#btn-voice')).toHaveClass(/voice-off/);
    await expect(page.locator('.voice-cta')).toContainText('You’re not in voice chat');
    await leaveRoom(page);
    await createRoom(page, 'Nash');
    await expect(page.locator('.voice-prompt')).toHaveCount(0);
  });

  test('a microphone the browser blocks shows up red, with how to fix it', async ({ page }) => {
    // The browser says no to the mic (as if you'd tapped Don't Allow).
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await createRoom(page, 'Bea');
    await page.locator('.voice-prompt [data-vp="on"]').click();
    const btn = page.locator('#btn-voice');
    await expect(btn).toHaveClass(/voice-off/);
    await expect(btn).not.toHaveClass(/active/);
    await expect(page.locator('.voice-cta')).toContainText('blocked the microphone');
    await btn.click();
    await expect(page.locator('#voice-panel .voice-problem')).toContainText('blocked the microphone');
    // Once in voice, it's back to normal.
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = (c) => MediaDevices.prototype.getUserMedia.call(navigator.mediaDevices, c);
    });
    await page.locator('#voice-panel [data-v="join"]').click();
    await expect(btn).toHaveClass(/active/);
    await expect(btn).not.toHaveClass(/voice-off/);
    await expect(page.locator('.voice-cta')).toHaveCount(0);
  });

  test('public games don’t ask (voice is for private rooms)', async ({ page }) => {
    await page.goto('/jigsaw');
    await page.locator('#play-public').click();
    await expect(page.locator('#game')).toHaveAttribute('data-view', 'jigsaw');
    await page.waitForTimeout(500);
    await expect(page.locator('.voice-prompt')).toHaveCount(0);
  });
});
