import { expect, test } from './fixtures';
import { createRoom, createTable, ready, watchErrors } from './helpers';

test('Three Thirteen: take a card, drag one to rearrange, and throw one away @smoke', async ({ page }) => {
  const errors = watchErrors(page);
  await createRoom(page, 'Tess', 'threethirteen');
  const view = page.locator('#threethirteen-view');
  await expect(view.locator('.tt-round')).toContainText('Round 1 of 11');
  await expect(view.locator('.tt-round')).toContainText('3s are wild');
  const hand = view.locator('.tt-hand .card');
  await expect(hand).toHaveCount(3);
  // Round 1's dealer sits right of seat 0, so the first person at the table starts.
  await expect(view.locator('.ht-status')).toContainText('Your turn: take a card', { timeout: 20_000 });

  await view.locator('.tt-stock').click();
  await expect(hand).toHaveCount(4);
  await expect(view.locator('.ht-status')).toContainText('tap a card to throw away');

  // Drag the first card to the far right: it stays there (the server keeps your order).
  const first = await hand.first().getAttribute('data-card');
  const from = (await hand.first().boundingBox())!;
  const to = (await view.locator('.tt-hand').boundingBox())!;
  await page.mouse.move(from.x + 8, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 10, from.y + from.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(hand.last()).toHaveAttribute('data-card', first!);
  await page.waitForTimeout(400);
  await expect(hand.last()).toHaveAttribute('data-card', first!);

  // Tap a card to lift it, and again to throw it away.
  const card = hand.first();
  const id = (await card.getAttribute('data-card'))!;
  await card.click();
  await expect(card).toHaveClass(/raised/);
  await card.click();
  await expect(view.locator('.tt-discard .card')).toHaveAttribute('data-card', id);
  expect(errors).toEqual([]);
});

test('Three Thirteen: the table can choose 2 players, so only one computer joins you', async ({ page }) => {
  const errors = watchErrors(page);
  await createTable(page, 'Tess', 'threethirteen');
  await expect(page.locator('[data-players="4"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('[data-players="2"]').click();
  await expect(page.locator('[data-players="2"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.tb-seats')).toContainText('2 players: you and a computer.');
  await expect(page.locator('.tb-seat.is-off')).toHaveCount(2);
  await ready(page);
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'threethirteen');
  const view = page.locator('#threethirteen-view');
  await expect(view.locator('.ht-seat:visible')).toHaveCount(2);
  await expect(view.locator('.tt-count')).toHaveText('101'); // 108 cards, two hands of 3, one face up
  expect(errors).toEqual([]);
});
