import { expect, test } from './fixtures';
import { createTable, ready, watchErrors } from './helpers';

test('Mahjong: choose points, roll the dice, then pick a tile and throw it away @smoke', async ({ page }) => {
  const errors = watchErrors(page);
  await createTable(page, 'Tess', 'mahjong');
  // Game type: Learning, No points (the first choice) or Points.
  await expect(page.locator('[data-mj-type="plain"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('[data-mj-type="points"]').click();
  await expect(page.locator('[data-mj-full="0"]')).toHaveAttribute('aria-checked', 'true');
  await ready(page);
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'mahjong');
  const view = page.locator('#mahjong-view');
  // The first person at the table sits East and deals: the dice wait for them.
  await expect(view.locator('[data-act="roll"]')).toBeVisible({ timeout: 10_000 });
  await view.locator('[data-act="roll"]').click();
  await expect(view.locator('.mj-dice.rolled .mj-die')).toHaveCount(3);
  // The dealer starts with 14 tiles and throws one away first.
  const tiles = view.locator('.mj-row .mj-h');
  await expect(tiles).toHaveCount(14, { timeout: 10_000 });
  // Your turn shows on your tag (yellow), with Discard; the status line only carries news.
  await expect(view.locator('.mj-head .ht-seat')).toHaveClass(/turn/, { timeout: 10_000 });
  await expect(view.locator('[data-act="discard"]')).toBeVisible();
  await expect(view.locator('.mj-left')).toContainText('tiles left');
  // Tap a tile to lift it, then Discard.
  const tile = tiles.last();
  const name = (await tile.getAttribute('aria-label'))!;
  await tile.click();
  await expect(tile).toHaveClass(/raised/);
  await view.locator('[data-act="discard"]').click();
  await expect(view.locator('.mj-pond-0 [role="img"]').last()).toHaveAttribute('aria-label', name.replace(' (new)', ''));
  await expect(tiles).toHaveCount(13);
  // Everyone else's discards and sets: See all discards lists them.
  await view.locator('[data-act="discards"]').click();
  await expect(view.locator('.mj-hist')).toHaveCount(4);
  await view.locator('[data-act="close"]').click();
  expect(errors).toEqual([]);
});
