import type { Page } from '@playwright/test';
type GameId = 'tanks' | 'hearts' | 'spades' | 'dominoes' | 'threethirteen' | 'mahjong' | 'jigsaw';
import { expect } from './fixtures';
export { newPlayer } from './fixtures';

/**
 * A page path. During a production canary, E2E_SLOT aims the tests at the new copy (the web
 * server routes ?slot= straight to it) before any real players are sent there.
 */
export function at(pathname: string) {
  const slot = process.env.E2E_SLOT;
  if (!slot) return pathname;
  // An address may already have a query (an invite's ?i=…): add to it, don't start another.
  return `${pathname}${pathname.includes('?') ? '&' : '?'}slot=${slot}`;
}

/** Fail on uncaught page errors (console noise like a blocked autoplay is fine). */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Type a name on the start or join page (tapping Change first if a name is already shown). */
export async function enterName(page: Page, form: 'start' | 'join', name: string) {
  const change = page.locator(`[data-name-for="${form}"] [data-name-act="change"]`);
  if (await change.isVisible()) await change.click();
  await page.locator(`#${form}-name`).fill(name);
}

/**
 * Open a table from a game's own page (/dominoes), the way a person would: it opens at the
 * table with that game picked, before anyone is ready. Returns its code.
 */
export async function createTable(page: Page, name: string, game: GameId | null = 'jigsaw', mic: 'on' | 'off' = 'off') {
  await page.goto(at(game ? `/${game}` : '/start'));
  await enterName(page, 'start', name);
  await page.getByRole('button', { name: `Start with mic ${mic}` }).click();
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'lobby');
  await expect(page).toHaveURL(/\/r\/[A-Z]{6}/);
  return new URL(page.url()).pathname.slice('/r/'.length);
}

/** Say you're ready at the table. */
export async function ready(page: Page) {
  await page.locator('.tb-go [data-act="ready"]').click();
}

/** Start a table playing `game` on your own: open it, then say you're ready. Returns its code. */
export async function createRoom(page: Page, name: string, game: GameId = 'jigsaw', mic: 'on' | 'off' = 'off') {
  const code = await createTable(page, name, game, mic);
  await ready(page);
  await expect(page.locator('#game')).toHaveAttribute('data-view', game);
  return code;
}

/**
 * Tap a button on the bar: the mic, Messages or the menu, or Invite and Help, which are in the
 * menu (user, 2026-11-25): it's opened first for those, the way a player would.
 */
export async function tapBar(page: Page, selector: string) {
  const btn = page.locator(selector);
  if (!(await btn.isVisible()) && (await page.locator(`#menu ${selector}`).count())) await page.locator('#btn-menu').click();
  await btn.click();
}

/** Join a table through its invite link, the way a friend would. */
export async function joinByInvite(page: Page, code: string, name: string, mic: 'on' | 'off' = 'off') {
  await page.goto(at(`/r/${code}`));
  await enterName(page, 'join', name);
  await page.getByRole('button', { name: `Join with mic ${mic}` }).click();
  await expect(page.locator('#btn-menu')).toBeVisible();
}

/** Menu, then Switch game: back to the table. */
export async function toLobby(page: Page) {
  await tapBar(page, '#btn-menu');
  await page.locator('#menu-lobby').click();
  await expect(page.locator('.lobby-view .lobby-games')).toBeVisible();
}

export async function sendChat(page: Page, text: string) {
  const input = page.locator('#chat-input');
  const wasOpen = await input.isVisible();
  if (!wasOpen) await tapBar(page, '#btn-chat');
  await input.fill(text);
  await input.press('Enter');
  // On a phone the chat covers the screen; close it again like a player would.
  if (!wasOpen) {
    await page.locator('#chat-collapse').click();
    await expect(input).toBeHidden();
  }
}

/** Cards overlap, so tap the visible strip at each card's left edge. */
export async function tapCard(page: Page, card: string) {
  await page.locator(`.ht-hand .card[data-card="${card}"]`).click({ position: { x: 6, y: 24 } });
}

export async function handCards(page: Page) {
  return page.locator('.ht-hand .card').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.card!));
}

/** Pick three cards and pass them. */
export async function passThree(page: Page) {
  await expect(page.locator('.ht-hand .card')).toHaveCount(13);
  const cards = (await handCards(page)).slice(0, 3);
  for (const c of cards) {
    await tapCard(page, c);
    await expect(page.locator(`.ht-hand .card[data-card="${c}"]`)).toHaveClass(/raised/);
  }
  await page.locator('.ht-action').click();
}

/** If it's this player's turn, play their first legal card. Returns whether they played. */
export async function playIfMyTurn(page: Page) {
  const legal = page.locator('.ht-hand.my-turn .card.legal');
  if ((await legal.count()) === 0) return false;
  const card = (await legal.first().getAttribute('data-card'))!;
  const before = (await handCards(page)).length;
  await tapCard(page, card);
  // Phones lift a card on the first tap and play it on the second.
  if (await page.locator(`.ht-hand .card[data-card="${card}"].raised`).count()) await tapCard(page, card);
  await expect(page.locator('.ht-hand .card')).toHaveCount(before - 1);
  return true;
}
