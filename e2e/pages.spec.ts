import { expect, test } from './fixtures';
import { E2E_ADMIN_PASSWORD } from './testPassword';
import { at, watchErrors } from './helpers';

test('the home page lists the games, and each game has its own page @smoke', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(at('/'));
  await expect(page).toHaveTitle('Games Drawer');
  await expect(page.locator('.game-tile')).toHaveCount(5);
  // Tanks and Jigsaw are open to everyone; the card and tile games are still being finished:
  // private rooms only, with an Under construction sign.
  for (const id of ['tanks', 'jigsaw']) await expect(page.locator(`[data-play="${id}"]`)).toBeVisible();
  for (const slug of ['hearts', 'spades', 'dominoes']) {
    const tile = page.locator(`.game-tile:has(a[href="/${slug}"])`);
    await expect(tile.locator('.gt-tag')).toHaveText('Private rooms');
    await expect(tile.locator('.uc-chip')).toHaveText('🚧 Under construction');
  }
  for (const id of ['hearts', 'spades', 'dominoes']) await expect(page.locator(`[data-play="${id}"]`)).toHaveCount(0);
  await expect(page.locator('.game-tile:has(a[href="/jigsaw"]) .uc-chip')).toHaveCount(0);
  await expect(page.locator('#create-private')).toHaveText('Start a private room');

  // Tapping a game opens its page, without reloading.
  await page.locator('.game-tile a[href="/hearts"]').click();
  await expect(page).toHaveURL(/\/hearts/);
  await expect(page.locator('#gp-title')).toHaveText('Hearts');
  await expect(page).toHaveTitle('Hearts · Games Drawer');
  await expect(page.locator('#gp-howto li')).toHaveCount(3);
  await expect(page.locator('#gp-construction')).toBeVisible();
  await expect(page.locator('#play-public')).toBeHidden();

  // Back to all games, and the browser's back button returns to the game's page.
  await page.locator('#back-home').click();
  await expect(page.locator('#home-head')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#gp-title')).toHaveText('Hearts');
  expect(errors).toEqual([]);
});

test('old and long addresses land on the game’s page', async ({ page }) => {
  await page.goto(at('/tankyouforbeingafriend'));
  await expect(page).toHaveURL(/\/tanks(\?|$)/);
  await expect(page.locator('#gp-title')).toContainText('Tank You');
  await page.goto(at('/not-a-game'));
  await expect(page).toHaveURL(/\/(\?|$)/);
  await expect(page.locator('#home-head')).toBeVisible();
});

test('a room that has closed says so right where you tried to join, on screen', async ({ page }) => {
  // The game server's answer to a dead code, played here instead: real wrong codes count against
  // this computer's limit on guesses, which would lock the other tests out of their rooms.
  // (It answers after a moment, like a slow connection.)
  const why = 'That room has closed or the code is wrong.';
  await page.routeWebSocket(/\/ws/, (ws) =>
    ws.onMessage((m) => {
      if (JSON.parse(String(m)).t !== 'hello') return;
      setTimeout(() => {
        ws.send(JSON.stringify({ t: 'error', code: 'not-found', message: why }));
        ws.close({ code: 4004, reason: 'not-found' });
      }, 900);
    }),
  );
  await page.goto(at('/'));
  await page.locator('#code-input').fill('bcdfg');
  await page.locator('#code-form button').click();
  const error = page.locator('#landing-error');
  // While it tries: "Joining room…" right there; then the answer takes its place.
  const below = page.locator('#home-actions .section-title');
  await expect(error).toHaveText('Joining room BCDFG…');
  await expect(error).toHaveClass(/pending/);
  await expect(error).toHaveText(why);
  await expect(error).not.toHaveClass(/pending/);
  await expect(error).toBeInViewport();
  await expect(page.locator('#code-form + #landing-error')).toHaveCount(1);
  await page.waitForTimeout(300);
  const y = (await below.boundingBox())!.y;
  // Trying again: the old answer stays (faded) instead of vanishing, then the new one arrives,
  // and everything below ends up where it was.
  await page.locator('#code-form button').click();
  await expect(error).toBeVisible();
  await expect(error).toHaveClass(/retrying|pending/);
  await expect(error).toHaveText('Joining room BCDFG…');
  await expect(error).toHaveText(why);
  await expect(error).not.toHaveClass(/retrying|pending/);
  await page.waitForTimeout(300);
  expect((await below.boundingBox())!.y).toBeCloseTo(y, 0);
  // Fixing the code clears it.
  await page.locator('#code-input').fill('bcdf');
  await expect(error).toBeHidden();

  // An old invite link: the reason shows under its Join button.
  await page.goto(at('/r/BCDFG'));
  await page.locator('#join-invite').click();
  await expect(error).toHaveText(why);
  await expect(error).toBeInViewport();
  await expect(page.locator('#invite-panel + #landing-error')).toHaveCount(1);
  await expect(page.locator('#join-invite')).toBeEnabled();
});

test('Play now on the Jigsaw page puts you at a public table @smoke', async ({ page }) => {
  await page.goto(at('/jigsaw'));
  await expect(page.locator('#gp-construction')).toBeHidden();
  await page.locator('#name-input').fill('Hal');
  await page.locator('#play-public').click();
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'jigsaw');
  // Public tables are shared, so someone may already be building one: either is fine.
  await expect(page.locator('.pz-setup-card, .pz-play canvas').first()).toBeVisible();
  await expect(page).toHaveURL(/\/jigsaw/);
  // Public tables have no invite button (that's for private rooms).
  await expect(page.locator('#btn-share')).toBeHidden();
});

test('Play with friends opens a private room already playing that game', async ({ page }) => {
  await page.goto(at('/hearts'));
  await page.locator('#name-input').fill('Fay');
  await page.locator('#play-friends').click();
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'hearts');
  await expect(page).toHaveURL(/\/r\/[A-Z]{5}/);
  await expect(page.locator('#btn-share')).toBeVisible();
  // Leaving the room goes back home.
  await page.locator('#btn-menu').click();
  await page.locator('#menu-leave').click();
  await expect(page.locator('#home-head')).toBeVisible();
  await expect(page).toHaveURL(/\/(\?|$)/);
});

test('the admin page asks for its password, then shows who plays what', async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'deployed copies have their own password');
  await page.goto(at('/admin'));
  await expect(page.locator('h1')).toHaveText('Games Drawer admin');
  await page.locator('input[name="password"]').fill('not the password');
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('.err')).toHaveText('That’s not the password.');
  await page.locator('input[name="password"]').fill(E2E_ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('h2').first()).toHaveText('Games, most played first');
  await expect(page.locator('tbody tr', { hasText: 'Jigsaw' })).toHaveCount(1);
  await page.locator('a', { hasText: '30 days' }).click();
  await expect(page).toHaveURL(/days=30/);
  await page.locator('button', { hasText: 'Sign out' }).click();
  await expect(page.locator('input[name="password"]')).toBeVisible();
});
