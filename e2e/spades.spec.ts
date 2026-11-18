import { expect, test } from './fixtures';
import { createRoom, playIfMyTurn, watchErrors } from './helpers';

test('Spades in a private room: bid, then play your cards', async ({ page }) => {
  const errors = watchErrors(page);
  await createRoom(page, 'Sid');
  await page.locator('[data-game="spades"]').click();
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'spades');
  await expect(page.locator('#spades-view .ht-hand .card')).toHaveCount(13);

  // You (seat 0) bid first: pick 3.
  const bids = page.locator('#spades-view .sp-bids');
  await expect(bids).toBeVisible();
  await expect(bids.locator('button')).toHaveCount(14);
  await bids.locator('button[data-bid="3"]').click();
  await expect(bids).toBeHidden();
  await expect(page.locator('#spades-view .ht-pos-0')).toContainText('Bid 3');

  // The bots bid, then play starts; play two of your cards when it's your turn.
  let played = 0;
  const deadline = Date.now() + 45_000;
  while (played < 2 && Date.now() < deadline) {
    if (await playIfMyTurn(page)) played++;
    else await page.waitForTimeout(200);
  }
  expect(played).toBe(2);
  await expect(page.locator('#spades-view .sp-score')).toContainText('Us');
  expect(errors).toEqual([]);
});
