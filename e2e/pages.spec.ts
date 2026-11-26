import { PROTOCOL_VERSION } from '../packages/shared/src/protocol';
import { expect, test } from './fixtures';
import { E2E_ADMIN_PASSWORD } from './testPassword';
import { at, createRoom, enterName, newPlayer, tapBar, watchErrors } from './helpers';

test('home: start a table or type a code; starting lists the games @smoke', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(at('/'));
  await expect(page).toHaveTitle('Games Drawer');
  await expect(page.locator('#page-home h1')).toHaveText('Play a game together.');
  await expect(page.locator('#code-input')).toBeVisible();

  // Start a table: just your name and the mic (the game is picked together at the table).
  await page.locator('#home-start').click();
  await expect(page).toHaveURL(/\/start$/);
  await expect(page.locator('#start-detail')).toContainText('pick a game together');
  await expect(page.locator('#page-start .pc-choice')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start with mic on' })).toBeVisible();

  // No name yet: it asks for one, right there.
  await page.getByRole('button', { name: 'Start with mic off' }).click();
  await expect(page.locator('#landing-error')).toHaveText('Type your name first, so everyone knows who you are.');
  await expect(page.locator('#landing-error')).toBeInViewport();

  // Back, and the browser's back button returns to the start page.
  await page.locator('#page-start .entry-home').click();
  await expect(page.locator('#page-home')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#page-start')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a game’s own address starts a table with that game picked; unknown ones go home', async ({ page }) => {
  await page.goto(at('/tankyouforbeingafriend'));
  await expect(page).toHaveURL(/\/tanks(\?|$)/);
  await expect(page.locator('#start-detail')).toContainText('Tanks picked');
  await page.goto(at('/dominoes'));
  await expect(page.locator('#start-detail')).toContainText('Dominoes picked');
  await page.goto(at('/not-a-game'));
  await expect(page).toHaveURL(/\/(\?|$)/);
  await expect(page.locator('#page-home')).toBeVisible();
});

test('a code that’s too short, or a table that has closed, says so on screen', async ({ page }) => {
  // The server's answer for a dead code, played here: real wrong codes count against this
  // computer's limit on guesses, which would lock the other tests out of their tables.
  await page.route('**/api/table**', (route) => route.fulfill({ json: { ok: false, reason: 'closed' } }));
  await page.goto(at('/'));
  await page.locator('#code-input').fill('bcd');
  await page.locator('#code-form button').click();
  const error = page.locator('#landing-error');
  await expect(error).toHaveText('Table codes are 6 letters.');
  await expect(page.locator('#code-form + #landing-error')).toHaveCount(1);
  // Fixing the code clears it.
  await page.locator('#code-input').fill('bcdf');
  await expect(error).toBeHidden();

  await page.locator('#code-input').fill('bcdfgh');
  await page.locator('#code-form button').click();
  await expect(page).toHaveURL(/\/r\/BCDFGH/);
  await expect(page.locator('#join-title')).toHaveText('This table has closed');
  await expect(page.locator('#join-form')).toBeHidden();
  await expect(page.locator('#join-home')).toHaveText('Back to home');
  await expect(page.locator('#join-home')).toHaveClass(/pc-btn-main/);
});

test('if joining fails, the reason shows under the join buttons', async ({ page }) => {
  await page.route('**/api/table**', (route) => route.fulfill({ json: { ok: true, from: 'Gus', for: null, game: 'jigsaw', people: ['Gus'], away: [], full: false } }));
  const why = 'That room has closed or the code is wrong.';
  await page.routeWebSocket(/\/ws/, (ws) =>
    ws.onMessage((m) => {
      if (JSON.parse(String(m)).t !== 'hello') return;
      setTimeout(() => {
        ws.send(JSON.stringify({ t: 'error', code: 'not-found', message: why }));
        ws.close({ code: 4004, reason: 'not-found' });
      }, 600);
    }),
  );
  await page.goto(at('/r/BCDFGH'));
  // Gus invited you and is there: one line says it all.
  await expect(page.locator('#join-title')).toHaveText('Join Gus for a puzzle');
  await expect(page.locator('#join-detail')).toBeHidden();
  await enterName(page, 'join', 'Ivy');
  await page.getByRole('button', { name: 'Join with mic off' }).click();
  const error = page.locator('#landing-error');
  // "room" is a "table" on the page.
  await expect(error).toHaveText('That table has closed or the code is wrong.');
  await expect(error).toBeInViewport();
  await expect(page.locator('#join-form + #landing-error')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Join with mic off' })).toBeEnabled();
});

test('before joining you see everyone at the table, kept up to date', async ({ page }) => {
  let people = ['Jesse', 'Sam', 'Mory'];
  let away: string[] = [];
  await page.route('**/api/table**', (route) => route.fulfill({ json: { ok: true, from: 'Jesse', for: null, game: 'jigsaw', people, away, full: false } }));
  await page.goto(at('/r/BCDFGH'));
  const title = page.locator('#join-title');
  const detail = page.locator('#join-detail');
  await expect(title).toHaveText('Join Jesse, Sam and Mory for a puzzle');
  await expect(title.locator('b')).toHaveText(['Jesse', 'Sam', 'Mory']);
  // Someone arrives while you're deciding: the page catches up by itself.
  people = ['Jesse', 'Sam', 'Mory', 'Pat'];
  await expect(title).toHaveText('Join Jesse, Sam, Mory and Pat for a puzzle', { timeout: 12_000 });
  // Jesse steps away: who invited you, then who's there. Names are shown as text, never as page code.
  people = ['<img src=x onerror=alert(1)>'];
  await expect(title).toHaveText('Jesse invited you to play', { timeout: 12_000 });
  await expect(detail).toHaveText('Join <img src=x onerror=alert(1)> for a puzzle.');
  await expect(detail.locator('img')).toHaveCount(0);
  // Someone who dropped out still holds a seat: they're named too.
  people = ['Jesse'];
  away = ['Sam'];
  await expect(title).toHaveText('Join Jesse for a puzzle', { timeout: 12_000 });
  await expect(detail).toHaveText('Sam stepped away and may come back.');
});

test('back at a table you just left: you’re told it’s yours, not that it’s full or that you stepped away', async ({ page }) => {
  // Four at the table, one of them you, from a tab you've just closed that isn't noticed yet.
  let info: object = { ok: true, from: 'Jesse', for: null, game: 'jigsaw', people: ['Jesse', 'Jesse 2', 'iPad', 'Jesse Phone'], away: [], full: true, back: null, here: true };
  let device = '';
  await page.route('**/api/table**', (route) => {
    device = route.request().headers()['x-gd-device'] ?? '';
    return route.fulfill({ json: info });
  });
  await page.goto(at('/r/BCDFGH'));
  const title = page.locator('#join-title');
  const detail = page.locator('#join-detail');
  const join = page.getByRole('button', { name: 'Join with mic off' });
  await expect(title).toHaveText('You’re already at this table');
  await expect(detail).toContainText('If you just closed it, this page lets you back in by itself');
  await expect(join).toBeHidden();
  // The page asks with this device's number (a header, never in the address).
  expect(device).toMatch(/^[0-9a-f]{32}$/);
  // It's noticed: your seat waits for you (the table is still "full", but the seat is yours).
  info = { ...info, people: ['Jesse 2', 'iPad', 'Jesse Phone'], away: ['Jesse'], here: false, back: 'Jesse' };
  await expect(title).toHaveText('Welcome back, Jesse', { timeout: 6000 });
  await expect(detail).toHaveText('Your seat is saved. Join Jesse 2, iPad and Jesse Phone for a puzzle.');
  await expect(join).toBeVisible();
});

test('an invite made for someone by name fills it in for them @smoke', async ({ page: host, browser }) => {
  // Catch the link instead of opening the phone's share sheet.
  await host.addInitScript(() => {
    const nav = navigator as Navigator & { __shared?: ShareData };
    nav.share = async (d?: ShareData) => {
      nav.__shared = d;
    };
    nav.canShare = () => true;
  });
  const code = await createRoom(host, 'Holly');
  await tapBar(host, '#btn-share');
  await expect(host.locator('#invite-code')).toHaveText(code);
  await host.locator('#invite-name').fill('Liz');
  await host.locator('#invite-send').click();
  await expect(host.locator('#invite')).toBeHidden();
  const shared = await host.evaluate(() => (navigator as Navigator & { __shared?: ShareData }).__shared!);
  expect(shared.text).toContain('Liz, come play');
  expect(shared.url).toMatch(new RegExp(`/r/${code}\\?i=[a-z2-9]{8}$`));

  const friend = await newPlayer(browser, host);
  await friend.goto(at(new URL(shared.url!).pathname + new URL(shared.url!).search));
  await expect(friend.locator('#join-title')).toHaveText('Join Holly for a puzzle');
  await expect(friend.locator('#join-name-shown')).toHaveText('Liz');
  await friend.getByRole('button', { name: 'Join with mic off' }).click();
  await expect(friend.locator('#game')).toHaveAttribute('data-view', 'jigsaw');
  await expect(host.locator('#chat-log')).toContainText('Liz is here');
  await friend.context().close();
});

test('the bar: Help explains the game, Messages shows only while closed, and leaving goes home', async ({ page }) => {
  await createRoom(page, 'Fay', 'hearts');
  // The bar is the mic, Messages and the menu on every screen; Invite and Help are in the menu.
  await expect(page.locator('#btn-share')).toBeHidden();
  await page.locator('#btn-menu').click();
  await expect(page.locator('#btn-share')).toBeVisible();
  // Who's at the table, you included, as on Your table.
  await expect(page.locator('#menu-people li[data-alias]')).toHaveText(['FayYou']);
  // Help: how to play the game on screen.
  await page.locator('#btn-help').click();
  await expect(page.locator('#menu')).toBeHidden();
  await expect(page.locator('#help-title')).toHaveText('How to play Hearts');
  await expect(page.locator('#help-body')).toContainText('Pass 3 cards');
  await page.locator('#help-close').click();
  await expect(page.locator('#help')).toBeHidden();
  // Messages: the bar's button opens it and hides; the panel's Close brings the button back.
  const btn = page.locator('#btn-chat');
  if (!(await page.locator('#chat-input').isVisible())) await tapBar(page, '#btn-chat');
  await expect(page.locator('#chat-input')).toBeVisible();
  await expect(btn).toBeHidden();
  await page.locator('#chat-collapse').click();
  await expect(btn).toBeVisible();
  await tapBar(page, '#btn-menu');
  await page.locator('#menu-leave').click();
  await expect(page.locator('#page-home')).toBeVisible();
  await expect(page).toHaveURL(/\/(\?|$)/);
});

test('on a phone that can’t go full screen, Full screen explains the home screen icon', async ({ page }) => {
  // Like an iPhone: web pages can't go full screen.
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false });
  });
  await createRoom(page, 'Fern', 'jigsaw');
  await tapBar(page, '#btn-menu');
  await page.locator('#btn-fullscreen').click();
  const help = page.locator('#home-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('Add to Home Screen');
  await expect(page.locator('#menu')).toBeHidden();
  await page.locator('#home-help-close').click();
  await expect(help).toBeHidden();
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

/** A welcome as the server sends it, for tests that play the server. */
const fakeWelcome = (chat: { id: string; text: string }[]) =>
  JSON.stringify({
    t: 'welcome',
    v: PROTOCOL_VERSION,
    session: 's',
    name: 'Ivy',
    reclaimed: false,
    alias: 'me',
    voice: { enabled: false, iceServers: [] },
    room: { code: 'BCDFGH', kind: 'private' },
    game: null,
    members: [{ id: 'me', name: 'Ivy', color: 0, connected: true }],
    chat: chat.map((m) => ({ ...m, from: 'Gus', speaker: 'gus', color: 1, at: Date.now() })),
    chatFilter: 'hide',
    table: { pick: null, seats: [], ready: [], players: 4, mahjong: { points: false, full: false } },
  });

test('Back to home while joining cancels it, even if the answer comes later', async ({ page }) => {
  await page.route('**/api/table**', (route) => route.fulfill({ json: { ok: true, from: 'Gus', for: null, game: null, people: ['Gus'], away: [], full: false } }));
  let answer = () => {};
  let cancelled = false;
  await page.routeWebSocket(/\/ws/, (ws) => {
    ws.onClose(() => (cancelled = true));
    ws.onMessage((m) => {
      if (JSON.parse(String(m)).t === 'hello') answer = () => ws.send(fakeWelcome([]));
    });
  });
  await page.goto(at('/r/BCDFGH'));
  await enterName(page, 'join', 'Ivy');
  await page.getByRole('button', { name: 'Join with mic off' }).click();
  await expect(page.locator('#landing-error')).toHaveText('Joining the table…');
  await page.locator('#join-home').click();
  await expect(page.locator('#page-home')).toBeVisible();
  await expect(page.locator('#landing-error')).toBeHidden();
  await expect(page.locator('#code-form button')).toBeEnabled();
  await expect.poll(() => cancelled).toBe(true);
  answer();
  await page.waitForTimeout(300);
  await expect(page.locator('#page-home')).toBeVisible();
  await expect(page.locator('#game')).toBeHidden();
});

test('a reconnect keeps Messages and adds what was missed, as unread; the next table starts read', async ({ page }) => {
  // Narrow enough that Messages starts closed.
  await page.setViewportSize({ width: Math.min(900, page.viewportSize()!.width), height: 700 });
  let visits = 0;
  await page.routeWebSocket(/\/ws/, (ws) =>
    ws.onMessage((m) => {
      if (JSON.parse(String(m)).t !== 'hello') return;
      visits++;
      const all = [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }, { id: 'c', text: 'while you were away' }];
      ws.send(fakeWelcome(visits === 1 ? all.slice(0, 2) : all.slice(1)));
      if (visits === 1) setTimeout(() => void ws.close(), 500);
    }),
  );
  await page.goto(at('/start'));
  await enterName(page, 'start', 'Ivy');
  await page.getByRole('button', { name: 'Start with mic off' }).click();
  await expect(page.locator('#chat-log .msg-text')).toHaveText(['first', 'second', 'while you were away']);
  await expect(page.locator('#chat-unread')).toHaveJSProperty('hidden', false);

  await tapBar(page, '#btn-menu');
  await page.locator('#menu-leave').click();
  await page.locator('#home-start').click();
  await page.getByRole('button', { name: 'Start with mic off' }).click();
  await expect(page.locator('#chat-log .msg-text')).toHaveCount(2);
  await expect(page.locator('#chat-unread')).toHaveJSProperty('hidden', true);
});
