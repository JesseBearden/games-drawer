import { expect, test } from './fixtures';
import { createTable, joinByInvite, newPlayer, passThree, playIfMyTurn, ready, sendChat, watchErrors, tapBar } from './helpers';

test('friends meet at a table, chat, play Hearts and switch games @smoke', async ({ page: host, browser }) => {
  const errors = watchErrors(host);
  const friend = await newPlayer(browser, host);
  const friendErrors = watchErrors(friend);

  // Opened from the Hearts page: everyone gathers at the table first, nothing dealt yet.
  const code = await createTable(host, 'Hana', 'hearts');
  await joinByInvite(friend, code, 'Finn');
  await expect(host.locator('#chat-log')).toContainText('Finn joined');
  await expect(friend.locator('#game')).toHaveAttribute('data-view', 'lobby');
  await expect(friend.locator('.lobby-games [data-game="hearts"]')).toHaveAttribute('aria-pressed', 'true');

  await sendChat(host, 'hello from the host');
  await expect(friend.locator('#chat-log')).toContainText('hello from the host');

  // They pick seats across from each other; a taken seat stays taken.
  await host.locator('.tb-seat.s-near').click();
  await expect(friend.locator('.tb-seat.s-near')).toContainText('Hana');
  await friend.locator('.tb-seat.s-near').click({ force: true }); // (it's marked unavailable)
  await expect(friend.locator('.tb-seat.s-near')).toContainText('Hana');
  await friend.locator('.tb-seat.s-far').click();
  await expect(host.locator('.tb-seat.s-far')).toContainText('Finn');

  // Ready: the game waits for everyone here.
  await ready(host);
  await expect(host.locator('.tb-status')).toHaveText('Waiting for Finn.');
  await expect(friend.locator('.tb-status')).toHaveText('Everyone else is ready.');
  await expect(host.locator('#game')).toHaveAttribute('data-view', 'lobby');
  await ready(friend);

  // Both are at the Hearts table with a full hand, across from each other.
  for (const p of [host, friend]) {
    await expect(p.locator('#game')).toHaveAttribute('data-view', 'hearts');
    await expect(p.locator('.ht-hand .card')).toHaveCount(13);
  }

  // Pass three each, then play until both people have played a card (bots fill the other seats).
  await passThree(host);
  await passThree(friend);
  const played = new Set<string>();
  const deadline = Date.now() + 60_000;
  while (played.size < 2 && Date.now() < deadline) {
    for (const [name, p] of [
      ['host', host],
      ['friend', friend],
    ] as const) {
      if (await playIfMyTurn(p)) played.add(name);
    }
    await host.waitForTimeout(200);
  }
  expect([...played].sort()).toEqual(['friend', 'host']);

  // Anyone can switch games: Menu, Switch game takes everyone back to the table; pick one, and
  // it starts once both are ready.
  await tapBar(friend, '#btn-menu');
  await friend.locator('#menu-lobby').click();
  for (const p of [host, friend]) await expect(p.locator('#game')).toHaveAttribute('data-view', 'lobby');
  await expect(host.locator('.lobby-people li')).toHaveCount(2);
  await friend.locator('[data-game="dominoes"]').click();
  await expect(host.locator('.lobby-games [data-game="dominoes"]')).toHaveAttribute('aria-pressed', 'true');
  for (const p of [host, friend]) await ready(p);
  for (const p of [host, friend]) await expect(p.locator('#game')).toHaveAttribute('data-view', 'dominoes');

  expect(errors).toEqual([]);
  expect(friendErrors).toEqual([]);
  await friend.context().close();
});
