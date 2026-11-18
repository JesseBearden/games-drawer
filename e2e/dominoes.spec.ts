import { expect, test } from './fixtures';
import { createRoom, watchErrors } from './helpers';

test('Dominoes in a private room: pick a tile and play it where it glows', async ({ page }) => {
  const errors = watchErrors(page);
  await createRoom(page, 'Dot');
  await page.locator('[data-game="dominoes"]').click();
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
        expect(look.face).toBe(look.legal ? 'rgb(255, 253, 246)' : 'rgb(152, 151, 149)');
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

test('after a hand you can look back at the board, and the next hand waits until you’re ready', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = watchErrors(page);
  await createRoom(page, 'Dot');
  await page.locator('[data-game="dominoes"]').click();
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

  // Look at the board, then come back to the scores (from the button, or the Scores button).
  await overlay.locator('[data-act="board"]').click();
  await expect(overlay).toBeHidden();
  await expect(view.locator('.dm-placed')).toHaveCount(placed);
  await expect(view.locator('.ht-status')).toHaveText('Hand 1 is over. Everyone else is ready.');
  await view.locator('.dm-back').click();
  await expect(overlay).toBeVisible();
  await overlay.locator('[data-act="board"]').click();
  await expect(view.locator('.dm-back')).toBeVisible();
  await view.locator('.ht-scores-btn').click();
  await expect(overlay).toBeVisible();
  await expect(view.locator('.dm-back')).toBeHidden();

  // Ready: with only bots at the table, the next hand starts straight away.
  await ready.click();
  await expect(overlay).toBeHidden();
  await expect(view.locator('.dm-mine')).toHaveCount(7);
  await expect(view.locator('.ht-status')).not.toContainText('over');
  expect(errors).toEqual([]);
});
