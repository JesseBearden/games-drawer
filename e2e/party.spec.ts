import { expect, test } from './fixtures';
import { createRoom, joinByInvite, newPlayer, passThree, playIfMyTurn, sendChat, watchErrors } from './helpers';

test('friends meet at a table, chat, play Hearts and switch games @smoke', async ({ page: host, browser }) => {
  const errors = watchErrors(host);
  const friend = await newPlayer(browser, host);
  const friendErrors = watchErrors(friend);

  const code = await createRoom(host, 'Hana', 'hearts');
  await joinByInvite(friend, code, 'Finn');
  await expect(host.locator('#chat-log')).toContainText('Finn joined');

  await sendChat(host, 'hello from the host');
  await expect(friend.locator('#chat-log')).toContainText('hello from the host');

  // Both are at the Hearts table with a full hand (the friend took a computer player's seat).
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

  // Anyone can switch games: Menu, Switch game, then pick one; everyone goes with them.
  await friend.locator('#btn-menu').click();
  await friend.locator('#menu-lobby').click();
  for (const p of [host, friend]) await expect(p.locator('#game')).toHaveAttribute('data-view', 'lobby');
  await expect(host.locator('.lobby-people li')).toHaveCount(2);
  await friend.locator('[data-game="dominoes"]').click();
  for (const p of [host, friend]) await expect(p.locator('#game')).toHaveAttribute('data-view', 'dominoes');

  expect(errors).toEqual([]);
  expect(friendErrors).toEqual([]);
  await friend.context().close();
});
