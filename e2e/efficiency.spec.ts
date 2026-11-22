/** The cheaper ways of updating the screen, as a browser sees them. */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { at, createRoom, createTable, joinByInvite, newPlayer, passThree, toLobby, watchErrors } from './helpers';

test.skip(({ isMobile }) => isMobile, 'one screen size is enough');
test.skip(() => !!process.env.E2E_BASE_URL, 'local only');

/** What this page sends and gets over its WebSocket, batches opened up. */
function watchWire(page: Page) {
  const sent: string[] = [];
  const got: string[] = [];
  page.on('websocket', (ws) => {
    const kind = (m: { t: string; m?: { t: string } }) => (m.t === 'g' ? m.m!.t : m.t);
    ws.on('framesent', (f) => sent.push(kind(JSON.parse(String(f.payload)))));
    ws.on('framereceived', (f) => {
      const m = JSON.parse(String(f.payload));
      for (const one of m.t === 'batch' ? m.msgs : [m]) got.push(kind(one));
    });
  });
  return { sent, got };
}

async function startPuzzle(page: Page) {
  const view = page.locator('#jigsaw-view');
  await view.locator('[data-image="dog"]').click();
  await view.locator('[data-count="50"]').click();
  await view.locator('.pz-start').click();
  await expect(view.locator('.pz-loading')).toBeHidden();
  await expect(view.locator('.pz-canvas')).toBeVisible();
}

test('puzzling alone sends no pointers; with company, pointers move without redrawing the table', async ({ page, browser }) => {
  const errors = watchErrors(page);
  const wire = watchWire(page);
  const code = await createRoom(page, 'Ida', 'jigsaw');
  await startPuzzle(page);
  const box = (await page.locator('.pz-canvas').boundingBox())!;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(middle.x - 80, middle.y);
  await page.mouse.move(middle.x + 80, middle.y, { steps: 20 });
  await page.waitForTimeout(400);
  expect(wire.sent).not.toContain('pz-cursor');

  const friend = await newPlayer(browser, page);
  await joinByInvite(friend, code, 'Ned');
  await expect(friend.locator('.pz-loading')).toBeHidden();
  await page.waitForTimeout(800); // (settled: joining redraws)
  await page.evaluate(() => {
    const w = window as unknown as { draws: number };
    w.draws = 0;
    const ctx = document.querySelector<HTMLCanvasElement>('.pz-canvas')!.getContext('2d')!;
    const clear = ctx.clearRect.bind(ctx);
    ctx.clearRect = (...a: [number, number, number, number]) => {
      w.draws++;
      clear(...a);
    };
  });
  await friend.mouse.move(middle.x - 60, middle.y);
  for (let i = 0; i < 10; i++) {
    await friend.mouse.move(middle.x - 60 + i * 12, middle.y + 5);
    await friend.waitForTimeout(70);
  }
  await expect(page.locator('.pz-cursor')).toContainText('Ned');
  expect(await page.evaluate(() => (window as unknown as { draws: number }).draws)).toBe(0);

  // It ends up exactly where theirs stopped (the last move always goes out).
  await expect
    .poll(async () => {
      const t = await page.locator('.pz-cursor').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
      return Math.abs(t - (middle.x - 60 + 9 * 12 - box.x));
    })
    .toBeLessThan(12);
  expect(errors).toEqual([]);
  await friend.context().close();
});

test('the puzzle’s cloth still follows a zoom, though its position no longer restyles the whole page', async ({ page }) => {
  await createRoom(page, 'Fern', 'jigsaw');
  await startPuzzle(page);
  const size = () => page.locator('#game').evaluate((el) => getComputedStyle(el).backgroundSize);
  const before = await size();
  const box = (await page.locator('.pz-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(size).not.toBe(before);
  // Not inherited: only #game has it.
  expect(await page.locator('#game').evaluate((el) => getComputedStyle(el).getPropertyValue('--felt-zoom'))).not.toBe('');
  expect(await page.locator('.pz-canvas').evaluate((el) => getComputedStyle(el).getPropertyValue('--felt-zoom'))).toBe('');
});

test('a held piece’s shadow is blurred once as it’s picked up, not on every frame of the drag', async ({ page }) => {
  await createRoom(page, 'Sol', 'jigsaw');
  await startPuzzle(page);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const w = window as unknown as { blurs: number };
    w.blurs = 0;
    const proto = CanvasRenderingContext2D.prototype;
    const draw = proto.drawImage;
    proto.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (this.shadowBlur === 14 * devicePixelRatio) w.blurs++;
      return (draw as (...a: unknown[]) => void).apply(this, args);
    } as typeof proto.drawImage;
  });
  // The middle of any loose piece: a spot that's opaque all round (the table and frame aren't).
  const spot = await page.locator('.pz-canvas').evaluate((c: HTMLCanvasElement) => {
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    const k = c.width / c.clientWidth;
    const solid = (x: number, y: number) => data[(y * c.width + x) * 4 + 3] === 255;
    for (let y = 90; y < c.height - 120; y += 5) {
      for (let x = 20; x < c.width - 20; x += 5) if (solid(x, y) && solid(x - 6, y) && solid(x + 6, y) && solid(x, y - 6) && solid(x, y + 6)) return { x: x / k, y: y / k };
    }
    return null;
  });
  expect(spot).not.toBeNull();
  const box = (await page.locator('.pz-canvas').boundingBox())!;
  const at = { x: box.x + spot!.x, y: box.y + spot!.y };
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 25; i++) {
    await page.mouse.move(at.x + ((to.x - at.x) * i) / 25, at.y + ((to.y - at.y) * i) / 25);
    await page.waitForTimeout(20);
  }
  expect(await page.evaluate(() => (window as unknown as { blurs: number }).blurs)).toBe(1);
  await page.mouse.up();
});

test('a hand keeps its cards as it changes, rather than being rebuilt', async ({ page }) => {
  await createRoom(page, 'Hope', 'hearts');
  await expect(page.locator('.ht-hand .card')).toHaveCount(13);
  await page.locator('.ht-hand .card').evaluateAll((els) => els.forEach((el) => ((el as HTMLElement & { same?: boolean }).same = true)));
  await passThree(page);
  await expect(page.locator('.ht-hand .card.new')).toHaveCount(3);
  // The ten that stayed are the same elements; only the three passed to you are new.
  const same = await page.locator('.ht-hand .card').evaluateAll((els) => els.filter((el) => (el as HTMLElement & { same?: boolean }).same).length);
  expect(same).toBe(10);
});

test('the lobby changes around a button you’re about to tap, without replacing it', async ({ page, browser }) => {
  const code = await createTable(page, 'Lou', 'hearts');
  const button = page.locator('.tb-go [data-act="ready"]');
  await button.evaluate((el) => ((el as HTMLElement & { same?: boolean }).same = true));
  const friend = await newPlayer(browser, page);
  await joinByInvite(friend, code, 'Max');
  await expect(page.locator('.lobby-people')).toContainText('Max');
  expect(await button.evaluate((el) => (el as HTMLElement & { same?: boolean }).same)).toBe(true);

  // The "Your mic is off" strip going doesn't rebuild the games under it either.
  const game = page.locator('.lobby-games [data-game="spades"]');
  await game.evaluate((el) => ((el as HTMLElement & { same?: boolean }).same = true));
  await page.locator('.lobby-view [data-act="voice"]').click();
  await expect(page.locator('.lobby-view .pc-alert')).toHaveCount(0);
  expect(await game.evaluate((el) => (el as HTMLElement & { same?: boolean }).same)).toBe(true);
  expect(await button.evaluate((el) => (el as HTMLElement & { same?: boolean }).same)).toBe(true);
  await friend.context().close();
});

test('the first page leaves the chat filter and the games’ own pictures for later', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await page.goto(at('/'));
  await page.waitForLoadState('networkidle');
  expect(asked.filter((p) => /chat-filter|chatCheck|card-stock|windsock/.test(p))).toEqual([]);
  // The smaller picture, on this screen.
  expect(asked.filter((p) => p.includes('together'))).toEqual(['/art/together-1024.webp']);
  await createRoom(page, 'Wren', 'dominoes');
  await expect.poll(() => asked.some((p) => p.includes('chat-filter'))).toBe(true);
  await expect.poll(() => asked).toContain('/art/card-stock.webp');
});

test('each game’s screen downloads when it’s picked, and works again after switching', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname);
  });
  const errors = watchErrors(page);
  await createRoom(page, 'Pia', 'hearts');
  await expect(page.locator('.ht-hand .card')).toHaveCount(13);
  expect(scripts.filter((s) => /tankView|jigsawView|dominoesView|spadesView/.test(s))).toEqual([]);
  await toLobby(page);
  await page.locator('.lobby-games [data-game="dominoes"]').click();
  await page.locator('.tb-go [data-act="ready"]').click();
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'dominoes');
  await expect(page.locator('.dm-mine').first()).toBeVisible();
  await expect.poll(() => scripts.some((s) => s.includes('dominoesView'))).toBe(true);
  expect(errors).toEqual([]);
});
