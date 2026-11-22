import { scoreSheetHtml } from '../packages/client/src/scoreSheet';
import { expect, test } from './fixtures';
import { createRoom, tapBar } from './helpers';

test.skip(({ isMobile }) => isMobile, 'it sets its own screen sizes');
test.skip(() => !!process.env.E2E_BASE_URL, 'local only');

test('a round’s end on a small phone: names have room, and Ready is in sight', async ({ page }) => {
  // (Before the table opens: on a computer's screen Messages would start open, over the game.)
  await page.setViewportSize({ width: 320, height: 568 });
  await createRoom(page, 'Aunt Mary Lou', 'threethirteen');
  const view = page.locator('#threethirteen-view');
  await view.locator('.ht-scores-btn').click();
  const panel = view.locator('.ht-panel');
  await expect(panel).toBeVisible();
  // A whole game's sheet with everyone's hands above it, as the last rounds show them.
  const history = Array.from({ length: 11 }, (_, i) => (i + 1) * 12);
  const sheet = scoreSheetHtml(['Aunt Mary Lou', 'Jesse', 'Sam', 'Mory'].map((label) => ({ label, history, total: 132 })), true, 'Round');
  await panel.evaluate((el, html) => {
    el.innerHTML =
      '<h2><span class="pc-nw">Aunt Mary Lou</span> &amp; <span class="pc-nw">WWWWWWWWWWWWWWW</span> win!</h2>' +
      '<div style="height:420px"></div>' +
      html +
      '<div class="actions"><button class="pc-btn pc-btn-main" type="button">Ready for round 11</button></div>';
  }, sheet);

  const who = await panel.locator('tbody .ht-who').first().boundingBox();
  expect(who!.width).toBeGreaterThan(55);
  // Nothing is wider than the sheet, however long a name in the heading.
  expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const ready = panel.getByRole('button', { name: 'Ready for round 11' });
  await expect(ready).toBeInViewport({ ratio: 1 });
  // Still there at the end of the scroll, and not on top of the last row.
  await panel.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(ready).toBeInViewport({ ratio: 1 });
  const last = (await panel.locator('tbody tr').last().boundingBox())!;
  expect(last.y + last.height).toBeLessThanOrEqual((await ready.boundingBox())!.y + 1);
});

test('three buttons on a small phone leave everyone’s score in sight', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await createRoom(page, 'Dot', 'dominoes');
  const view = page.locator('#dominoes-view');
  await view.locator('.ht-scores-btn').click();
  const panel = view.locator('.ht-panel');
  await panel.locator('.actions').evaluate((el) => {
    el.innerHTML = ['New game', 'See the board', 'Switch game'].map((t) => `<button class="pc-btn pc-btn-plain" type="button">${t}</button>`).join('');
  });
  const [first, second, third] = await Promise.all([0, 1, 2].map(async (i) => (await panel.locator('.actions button').nth(i).boundingBox())!));
  expect(first.y + first.height).toBeLessThanOrEqual(second.y);
  expect(Math.abs(second.y - third.y)).toBeLessThan(2);
  const last = (await panel.locator('tbody tr').last().boundingBox())!;
  expect(last.y + last.height).toBeLessThanOrEqual(first.y + 1);
});

test('the score sheet covers the whole hand', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await createRoom(page, 'Dee', 'hearts');
  const last = page.locator('.ht-hand .card').last();
  await expect(page.locator('.ht-hand .card')).toHaveCount(13);
  await page.locator('#hearts-view .ht-scores-btn').click();
  await expect(page.locator('#hearts-view .ht-panel')).toBeVisible();
  // What a finger on the last card would touch is the sheet's, not the card.
  const under = await last.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.ht-overlay');
  });
  expect(under).toBe(true);
});

test('Reduce motion holds at the table', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await createRoom(page, 'Cal', 'hearts');
  const card = page.locator('.ht-hand .card').first();
  await expect(card).toHaveCSS('transition-property', 'none');
  await tapBar(page, '#btn-menu');
  await expect(page.locator('#menu .sheet')).toHaveCSS('animation-name', 'none');
});
