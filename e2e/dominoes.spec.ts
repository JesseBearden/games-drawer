import { expect, test } from './fixtures';
import { createRoom, watchErrors } from './helpers';

test('Dominoes in a private room: pick a tile and play it where it glows', async ({ page }) => {
  const errors = watchErrors(page);
  await createRoom(page, 'Dot', 'dominoes');
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'dominoes');
  const view = page.locator('#dominoes-view');
  await expect(view.locator('.dm-mine')).toHaveCount(7);
  await expect(view.locator('.dm-info')).toContainText('Ends add up to');
  // All 28 tiles are dealt, so there's no boneyard and never a Draw button.
  await expect(view.locator('.dm-info')).not.toContainText('Boneyard');

  // Play two of our turns (bots play theirs), drawing whenever nothing fits.
  let played = 0;
  let drew = 0;
  const deadline = Date.now() + 70_000;
  while (played < 2 && Date.now() < deadline) {
    if (await view.locator('.ht-overlay:not([hidden])').count()) break; // someone went out
    const draw = view.locator('.dm-draw:not([hidden])');
    if (await draw.count()) {
      await draw.click();
      drew++;
      await page.waitForTimeout(250);
      continue;
    }
    const legal = view.locator('.dm-hand.my-turn .dm-mine.legal');
    if (await legal.count()) {
      // Tiles that don't fit are greyed by recolouring the tile, never with a CSS filter: Safari
      // on iPad drew filtered tiles in the wrong place, cut off.
      const looks = await view.locator('.dm-hand.my-turn .dm-mine').evaluateAll((tiles) =>
        tiles.map((t) => ({
          legal: t.classList.contains('legal'),
          filter: getComputedStyle(t).filter,
          face: getComputedStyle(t.querySelector('.dm-face')!).fill,
        })),
      );
      for (const look of looks) {
        expect(look.filter).toBe('none');
        // Playable tiles are ceramic (a shared gradient); the others a flat, darker ceramic.
        if (look.legal) expect(look.face).toContain('url(');
        else expect(look.face).toBe('rgb(205, 197, 183)');
      }
      const placedBefore = await view.locator('.dm-placed').count();
      await legal.first().click();
      await expect(legal.first().or(view.locator('.dm-mine.raised'))).toBeVisible();
      await expect(view.locator('.dm-ghost').first()).toBeVisible();
      await view.locator('.dm-ghost').first().click();
      await expect.poll(() => view.locator('.dm-placed').count()).toBeGreaterThan(placedBefore);
      played++;
      continue;
    }
    await page.waitForTimeout(250);
  }
  expect(played + (await view.locator('.ht-overlay:not([hidden])').count())).toBeGreaterThan(0);
  expect(drew).toBeGreaterThanOrEqual(0);
  // The board shows the tiles everyone has played.
  expect(await view.locator('.dm-placed').count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the board zooms with the mouse wheel; you play by tapping the spot, not the tile again', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await createRoom(page, 'Dot', 'dominoes');
  const view = page.locator('#dominoes-view');
  await expect(view.locator('.dm-mine')).toHaveCount(7);
  // No zoom buttons: pinch on a phone or tablet, the mouse wheel on a computer.
  await expect(view.locator('[data-zoom]')).toHaveCount(0);
  // Our first play: tapping the picked tile again puts it back; tapping its spot plays it.
  const status = view.locator('.ht-status');
  const deadline = Date.now() + 60_000;
  while ((await view.locator('.dm-mine').count()) === 7 && Date.now() < deadline) {
    const legal = view.locator('.dm-hand.my-turn .dm-mine.legal');
    if (await legal.count()) {
      const tile = await legal.first().getAttribute('data-tile');
      const mine = view.locator(`.dm-mine[data-tile="${tile}"]`);
      await mine.click();
      await expect(mine).toHaveClass(/raised/);
      await expect(view.locator('.dm-ghost').first()).toBeVisible();
      // Whose turn it is shows on the yellow tag and where it goes on the board: no line of text.
      await expect(status).toBeHidden();
      await mine.click();
      await expect(mine).not.toHaveClass(/raised/);
      await expect(view.locator('.dm-ghost')).toHaveCount(0);
      await expect(status).toBeHidden();
      await mine.click();
      await view.locator('.dm-ghost').first().click();
      await expect(view.locator('.dm-mine')).toHaveCount(6);
    }
    await page.waitForTimeout(250);
  }
  await expect(view.locator('.dm-mine')).toHaveCount(6);

  // The mouse wheel over the board zooms around the pointer, in and back out.
  const layout = view.locator('.dm-layout');
  const scale = () => layout.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform.replace('none', '')).a);
  const box = (await view.locator('.dm-board').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(scale).toBeGreaterThan(1.2);
  await expect(view.locator('.dm-board')).toHaveClass(/zoomed/);
  await page.mouse.wheel(0, 1200);
  await expect.poll(scale).toBe(1);
  expect(errors).toEqual([]);
});

test('after a hand you can look back at the board, and the next hand waits until you’re ready', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = watchErrors(page);
  await createRoom(page, 'Dot', 'dominoes');
  const view = page.locator('#dominoes-view');
  await expect(view.locator('.dm-mine')).toHaveCount(7);

  // Play the whole hand (bots play theirs).
  const overlay = view.locator('.ht-overlay');
  const deadline = Date.now() + 120_000;
  while (!(await overlay.isVisible()) && Date.now() < deadline) {
    const legal = view.locator('.dm-hand.my-turn .dm-mine.legal');
    if (await legal.count()) {
      const placedBefore = await view.locator('.dm-placed').count();
      await legal.first().click();
      const ghost = view.locator('.dm-ghost').first();
      if (await ghost.isVisible()) await ghost.click();
      else await legal.first().click();
      await expect.poll(async () => (await view.locator('.dm-placed').count()) > placedBefore || (await overlay.isVisible())).toBe(true);
      continue;
    }
    await page.waitForTimeout(250);
  }
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('Hand 1 done');
  const ready = overlay.locator('[data-act="ready"]');
  await expect(ready).toHaveText('Ready for hand 2');

  // Nothing moves on by itself.
  await page.waitForTimeout(8000);
  await expect(overlay).toContainText('Hand 1 done');
  const placed = await view.locator('.dm-placed').count();

  // Look at the board, then come back to the scores: the one button by your name says so.
  const scoresBtn = view.locator('.ht-scores-btn');
  await overlay.locator('[data-act="board"]').click();
  await expect(overlay).toBeHidden();
  await expect(view.locator('.dm-placed')).toHaveCount(placed);
  await expect(view.locator('.ht-status')).toHaveText('Hand 1 is over. Everyone else is ready.');
  await expect(scoresBtn).toHaveText('Back to scores');
  await scoresBtn.click();
  await expect(overlay).toBeVisible();
  await expect(scoresBtn).toHaveText('Scores');

  // Ready: with only bots at the table, the next hand starts straight away.
  await ready.click();
  await expect(overlay).toBeHidden();
  await expect(view.locator('.dm-mine')).toHaveCount(7);
  await expect(view.locator('.ht-status')).not.toContainText('over');
  expect(errors).toEqual([]);
});
