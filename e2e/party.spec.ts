import { expect, test } from './fixtures';
import { createRoom, joinByInvite, newPlayer, passThree, playIfMyTurn, sendChat, watchErrors } from './helpers';

test('friends meet in a private room, chat, play Hearts and go back to the lobby @smoke', async ({ page: host, browser }) => {
  const errors = watchErrors(host);
  const friend = await newPlayer(browser, host);
  const friendErrors = watchErrors(friend);

  const code = await createRoom(host, 'Hana');
  await joinByInvite(friend, code, 'Finn');
  for (const p of [host, friend]) await expect(p.locator('.lobby-members li')).toHaveCount(2);

  await sendChat(host, 'hello from the host');
  await expect(friend.locator('#chat-log')).toContainText('hello from the host');

  // Anyone can start a game; both land at the table with a full hand.
  await host.locator('[data-game="hearts"]').click();
  for (const p of [host, friend]) {
    await expect(p.locator('#game')).toHaveAttribute('data-view', 'hearts');
    await expect(p.locator('.ht-hand .card')).toHaveCount(13);
  }
  await expect(friend.locator('#chat-log')).toContainText('Hearts');

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

  // Anyone can end the game.
  await friend.locator('#btn-menu').click();
  await friend.locator('#menu-lobby').click();
  for (const p of [host, friend]) await expect(p.locator('#game')).toHaveAttribute('data-view', 'lobby');

  expect(errors).toEqual([]);
  expect(friendErrors).toEqual([]);
  await friend.context().close();
});
