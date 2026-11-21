import type { Page } from '@playwright/test';
import { expect, newPlayer, test } from './fixtures';
import { at, createRoom, joinByInvite, watchErrors, tapBar } from './helpers';
import { PUZZLE_IMAGES } from '../packages/shared/src/puzzle';

/**
 * Screen spots well inside a piece (pieces are the only fully opaque pixels on the table; the
 * spot and the pixels a few away on every side must all be opaque, so it isn't on an outline).
 */
async function pieceSpots(page: Page) {
  return page.locator('#jigsaw-view .pz-canvas').evaluate((c: HTMLCanvasElement) => {
    const g = c.getContext('2d')!;
    const { data } = g.getImageData(0, 0, c.width, c.height);
    const k = c.width / c.clientWidth;
    const r = Math.round(3 * k);
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < c.width && y < c.height && data[(y * c.width + x) * 4 + 3] === 255;
    const out: { x: number; y: number }[] = [];
    const step = Math.max(4, Math.round(6 * k));
    for (let y = 0; y < c.height; y += step) {
      for (let x = 0; x < c.width; x += step) {
        if (solid(x, y) && solid(x - r, y) && solid(x + r, y) && solid(x, y - r) && solid(x, y + r)) out.push({ x: x / k, y: y / k });
      }
    }
    return out;
  });
}

async function opaqueAt(page: Page, x: number, y: number) {
  return page.locator('#jigsaw-view .pz-canvas').evaluate(
    (c: HTMLCanvasElement, p) => {
      const k = c.width / c.clientWidth;
      return c.getContext('2d')!.getImageData(Math.round(p.x * k), Math.round(p.y * k), 1, 1).data[3] === 255;
    },
    { x, y },
  );
}

interface Seen {
  state: { width: number; height: number; cols: number; rows: number; pieces: { x: number; y: number; g: number }[] } | null;
}

/** Follow the puzzle as the server sends it (call before joining a room). */
function watchPuzzle(page: Page): Seen {
  const seen: Seen = { state: null };
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string' || !f.payload.includes('"pz-')) return;
      const msg = JSON.parse(f.payload);
      if (msg.t !== 'g') return;
      if (msg.m.t === 'pz-state') seen.state = msg.m.state;
      if (msg.m.t === 'pz-moved' && seen.state) for (const [i, x, y, g] of msg.m.pieces) Object.assign(seen.state.pieces[i], { x, y, g });
    }),
  );
  return seen;
}

/** Page coordinates of a board point, from where the view is right now. */
async function onScreen(page: Page, bx: number, by: number) {
  const canvas = page.locator('#jigsaw-view .pz-canvas');
  const [cx, cy, s] = (await canvas.getAttribute('data-cam'))!.split(',').map(Number);
  const box = (await canvas.boundingBox())!;
  return { x: box.x + (bx - cx) * s, y: box.y + (by - cy) * s };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await page.mouse.up();
}

test('Jigsaw in a private room: build it together, put it away and pick it up again', async ({ page, browser }, info) => {
  const errors = watchErrors(page);
  const seen = watchPuzzle(page);
  const code = await createRoom(page, 'Pip', 'jigsaw');
  await expect(page.locator('#game')).toHaveAttribute('data-view', 'jigsaw');
  const view = page.locator('#jigsaw-view');

  // The picker: the dog photo (the order is shuffled, so pick it by name) and the piece counts.
  await expect(view.locator('.pz-image')).not.toHaveCount(0);
  await view.locator('[data-image="dog"]').click();
  await view.locator('[data-count="50"]').click();
  await expect(view.locator('[data-count="50"]')).toHaveClass(/picked/);
  await page.screenshot({ path: info.outputPath('setup.png') });
  await view.locator('.pz-start').click();

  await expect(view.locator('.pz-play')).toBeVisible();
  await expect(view.locator('.pz-loading')).toBeHidden();
  await expect(view.locator('.pz-pct')).toHaveText('0%');
  await expect(view.locator('.pz-status')).toContainText('54 pieces');

  // A friend joins and sees the same table.
  const friend = await newPlayer(browser, page);
  // (They land straight in the puzzle, not the lobby.)
  await joinByInvite(friend, code, 'Rue');
  await expect(friend.locator('#game')).toHaveAttribute('data-view', 'jigsaw');
  const fview = friend.locator('#jigsaw-view');
  await expect(fview.locator('.pz-play')).toBeVisible();
  await expect(fview.locator('.pz-loading')).toBeHidden();

  // Put piece 1 next to piece 0: they snap together, and the puzzle is 1 join in 53 done.
  await expect.poll(async () => (await pieceSpots(page)).length).toBeGreaterThan(50);
  const st = seen.state!;
  const pw = st.width / st.cols;
  const ph = st.height / st.rows;
  const [p0, p1] = st.pieces;
  await drag(page, await onScreen(page, p1.x + pw / 2, p1.y + ph / 2), await onScreen(page, p0.x + pw * 1.55, p0.y + ph * 0.45));
  await expect(view.locator('.pz-pct')).toHaveText('4%');
  await expect(fview.locator('.pz-pct')).toHaveText('4%');
  expect(st.pieces[1].g).toBe(st.pieces[0].g);

  // Drag the top-right corner piece into the middle of the frame (far from where it belongs,
  // so it stays there): it moves for both of us.
  const box = (await view.locator('.pz-canvas').boundingBox())!;
  const to = { x: box.width / 2, y: box.height / 2 };
  expect(await opaqueAt(page, to.x, to.y)).toBe(false);
  const corner = st.pieces[st.cols - 1];
  await drag(page, await onScreen(page, corner.x + pw / 2, corner.y + ph / 2), { x: box.x + to.x, y: box.y + to.y });
  await expect.poll(() => opaqueAt(page, to.x, to.y)).toBe(true);
  await expect.poll(() => opaqueAt(friend, to.x, to.y)).toBe(true);
  await page.screenshot({ path: info.outputPath('playing.png') });
  await friend.screenshot({ path: info.outputPath('friend.png') });

  // Zoom and fit don't break anything.
  await page.mouse.move(box.x + to.x, box.y + to.y);
  await page.mouse.wheel(0, -400);
  await view.locator('[data-pz="fit"]').click();
  await expect.poll(() => opaqueAt(page, to.x, to.y)).toBe(true);

  // Put it away; it shows up under "Continue a puzzle" and comes back as it was.
  page.once('dialog', (d) => d.accept());
  await tapBar(page, '#btn-menu');
  await page.locator('#menu [data-menu-item="new-puzzle"]').click();
  await expect(view.locator('.pz-setup')).toBeVisible();
  await expect(view.locator('.pz-saves li')).toHaveCount(1);
  await expect(view.locator('.pz-saves')).toContainText('54 pieces · 4% done');
  await page.screenshot({ path: info.outputPath('continue.png') });
  await view.locator('[data-resume]').click();
  await expect(view.locator('.pz-loading')).toBeHidden();
  await expect.poll(() => opaqueAt(page, to.x, to.y)).toBe(true);
  await expect(view.locator('.pz-pct')).toHaveText('4%');
  await expect(fview.locator('.pz-play')).toBeVisible();

  // Put away again, then take it off the list (it asks first, since it's started).
  page.once('dialog', (d) => d.accept());
  await tapBar(page, '#btn-menu');
  await page.locator('#menu [data-menu-item="new-puzzle"]').click();
  await expect(view.locator('.pz-saves li')).toHaveCount(1);
  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    void d.accept();
  });
  await view.locator('[data-forget]').click();
  await expect(view.locator('.pz-saves')).toHaveCount(0);
  expect(asked).toContain('off your list');
  await page.reload();
  await expect(page.locator('#jigsaw-view .pz-setup')).toBeVisible();
  await expect(page.locator('#jigsaw-view .pz-image').first()).toBeVisible();
  await expect(page.locator('#jigsaw-view .pz-saves')).toHaveCount(0);

  expect(errors).toEqual([]);
  await friend.context().close();
});

test('a 6-piece puzzle for little kids: big pieces, any picture', async ({ page }, info) => {
  const errors = watchErrors(page);
  await createRoom(page, 'Tot', 'jigsaw');
  const view = page.locator('#jigsaw-view');
  await expect(view.locator('.pz-image')).toHaveCount(PUZZLE_IMAGES.length);
  // Sizes up to 500 (1000 was dropped); the first picture in the shuffled order is picked.
  await expect(view.locator('[data-count]')).toHaveCount(6);
  await expect(view.locator('[data-count="1000"]')).toHaveCount(0);
  await expect(view.locator('.pz-image').first()).toHaveClass(/picked/);
  const orderOf = () => view.locator('.pz-image').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.image));
  const before = await orderOf();
  // Picking only moves the tick: the pictures aren't rebuilt (that made them all blink on iPhones).
  const firstPic = await view.locator('.pz-image img').first().elementHandle();
  await view.locator('[data-image="toy-shop"]').click();
  await view.locator('[data-count="6"]').click();
  expect(await firstPic!.evaluate((el) => el.isConnected)).toBe(true);
  await expect(view.locator('.pz-image.picked')).toHaveCount(1);
  await expect(view.locator('[data-image="toy-shop"]')).toHaveClass(/picked/);
  await expect(view.locator('.pz-grid')).toHaveText('Toy shop: 6 pieces, 3 across and 2 down.');
  await page.screenshot({ path: info.outputPath('picker.png'), fullPage: true });
  await view.locator('.pz-start').click();
  await expect(view.locator('.pz-loading')).toBeHidden();
  await expect(view.locator('.pz-status')).toContainText('6 pieces');
  // (Drawn on the next frame after the pieces are cut.)
  await expect.poll(async () => (await pieceSpots(page)).length).toBeGreaterThan(100);
  await page.screenshot({ path: info.outputPath('six.png') });

  // Nothing placed, so putting it away doesn't keep it.
  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    void d.accept();
  });
  await tapBar(page, '#btn-menu');
  await page.locator('#menu [data-menu-item="new-puzzle"]').click();
  await expect(view.locator('.pz-setup')).toBeVisible();
  expect(asked).toContain('won’t be kept');
  await expect(view.locator('.pz-image')).toHaveCount(PUZZLE_IMAGES.length);
  // Back at the picker, the pictures come in a new order.
  expect(await orderOf()).not.toEqual(before);
  await expect(view.locator('.pz-saves')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('holding a piece at the edge of the screen scrolls the table', async ({ page }, info) => {
  await createRoom(page, 'Edge', 'jigsaw');
  const view = page.locator('#jigsaw-view');
  await view.locator('[data-image="dog"]').click();
  await view.locator('[data-count="100"]').click();
  await view.locator('.pz-start').click();
  await expect.poll(async () => (await pieceSpots(page)).length).toBeGreaterThan(50);
  // The magnifier's button is only on touch screens.
  await expect(view.locator('[data-pz="loupe"]')).toBeVisible({ visible: info.project.name === 'phone' });
  const canvas = view.locator('.pz-canvas');
  const box = (await canvas.boundingBox())!;
  // Zoom in on a piece on the left side of the table (pieces are scattered at random, so aim at
  // one: zooming keeps what's under the pointer there).
  const middleBand = (p: { x: number; y: number }) => p.y > 120 && p.y < box.height - 140 && p.x > 80 && p.x < box.width - 120;
  const aim = (await pieceSpots(page)).filter((p) => middleBand(p) && p.x < box.width * 0.45);
  const target = aim[Math.floor(aim.length / 2)];
  expect(target).toBeTruthy();
  await page.mouse.move(box.x + target.x, box.y + target.y);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -500);
  await expect.poll(async () => (await pieceSpots(page)).length).toBeGreaterThan(5);
  const camX = async () => Number((await canvas.getAttribute('data-cam'))!.split(',')[0]);
  // The piece spot nearest where we aimed.
  const near = (p: { x: number; y: number }) => Math.hypot(p.x - target.x, p.y - target.y);
  const from = (await pieceSpots(page)).filter(middleBand).sort((a, b) => near(a) - near(b))[0];
  expect(from).toBeTruthy();
  const before = await camX();
  // Carry it to the right edge and hold it there.
  const edgeX = box.x + box.width - 4;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + from.x + ((edgeX - box.x - from.x) * i) / 8, box.y + from.y);
  await page.waitForTimeout(1200);
  // The table scrolled right, and the piece is still in hand under the pointer.
  expect(await camX()).toBeGreaterThan(before + 100);
  expect(await opaqueAt(page, edgeX - box.x, from.y)).toBe(true);
  // A mouse doesn't hide what it drags: no magnifier.
  await expect(view.locator('.pz-loupe')).not.toHaveClass(/\bon\b/);
  await page.mouse.up();
  // Letting go stops the scrolling (give the last frame a moment to draw first).
  await page.waitForTimeout(200);
  const stopped = await camX();
  await page.waitForTimeout(400);
  expect(await camX()).toBe(stopped);
});

test('looking around stops at the edge of the table', async ({ page }) => {
  await createRoom(page, 'Pan', 'jigsaw');
  const view = page.locator('#jigsaw-view');
  await view.locator('[data-image="dog"]').click();
  await view.locator('[data-count="50"]').click();
  await view.locator('.pz-start').click();
  await expect.poll(async () => (await pieceSpots(page)).length).toBeGreaterThan(50);
  const canvas = view.locator('.pz-canvas');
  const box = (await canvas.boundingBox())!;
  // How opaque the canvas is at a screen spot: 0 off the table, faint on it, solid on a piece.
  const alphaAt = (x: number, y: number) =>
    canvas.evaluate((c: HTMLCanvasElement, p) => {
      const k = c.width / c.clientWidth;
      return c.getContext('2d')!.getImageData(Math.round(p.x * k), Math.round(p.y * k), 1, 1).data[3];
    }, { x, y });

  // Zoomed all the way out, the whole table stays in the middle: nothing to drag around.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 600);
  // Zoom in, then try to drag far past each corner of the table.
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -500);
  const toolsTop = (await view.locator('.pz-tools').boundingBox())!.y - box.y;
  const corners = [
    { dx: 1, dy: 1, check: { x: 40, y: 90 } },
    // The table stops just above the tools strip (which wraps onto two rows on a phone).
    { dx: -1, dy: -1, check: { x: box.width - 40, y: toolsTop - 20 } },
  ];
  for (const { dx, dy, check } of corners) {
    // Start the drag on bare table, not a piece.
    const start = await canvas.evaluate((c: HTMLCanvasElement) => {
      const g = c.getContext('2d')!;
      const k = c.width / c.clientWidth;
      for (let y = 120; y < c.clientHeight - 120; y += 9) {
        for (let x = 60; x < c.clientWidth - 60; x += 9) {
          const a = g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data[3];
          if (a > 0 && a < 255) return { x, y };
        }
      }
      return null;
    });
    expect(start).not.toBeNull();
    await page.mouse.move(box.x + start!.x, box.y + start!.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + start!.x + dx * i * 400, box.y + start!.y + dy * i * 400);
    await page.mouse.up();
    await expect.poll(() => alphaAt(check.x, check.y)).toBeGreaterThan(0);
    await expect.poll(() => alphaAt(box.width / 2, box.height / 2)).toBeGreaterThan(0);
  }
});

test('a finger dragging a piece gets a magnifier above it, and the piece stays under the finger', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'touch only');
  const seen = watchPuzzle(page);
  await createRoom(page, 'Thumb', 'jigsaw');
  const view = page.locator('#jigsaw-view');
  await view.locator('[data-image="dog"]').click();
  await view.locator('[data-count="50"]').click();
  await view.locator('.pz-start').click();
  await expect.poll(async () => (await pieceSpots(page)).length).toBeGreaterThan(50);
  const st = seen.state!;
  const pw = st.width / st.cols;
  const ph = st.height / st.rows;
  const scale = Number((await view.locator('.pz-canvas').getAttribute('data-cam'))!.split(',')[2]);
  // Pieces are scattered at random: use ones with no other piece close by, so nothing covers
  // the middle we grab, and nothing snaps on (a group gets no magnifier).
  const alone = (i: number) => {
    const ps = seen.state!.pieces;
    return ps.every((q, j) => j === i || Math.hypot(q.x - ps[i].x, q.y - ps[i].y) > 1.3 * pw);
  };
  const byY = st.pieces
    .map((p, i) => ({ y: p.y, i }))
    .filter(({ i }) => alone(i))
    .sort((a, b) => a.y - b.y);
  expect(byY.length).toBeGreaterThan(4);
  const middle = byY[Math.floor(byY.length / 2)].i;
  const loupe = view.locator('.pz-loupe');
  const screen = (await view.locator('.pz-canvas').boundingBox())!;
  // Straight above the finger, unless that would put it off the side of the screen.
  const aboveX = (x: number, r: number) => Math.min(screen.x + screen.width - r - 6, Math.max(screen.x + r + 6, x));

  // Real touch events (Playwright's mouse would be a mouse, which gets no magnifier).
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  // A tap without moving leaves the piece where it was, with no magnifier.
  const tapped = { ...st.pieces[middle] };
  const tapAt = await onScreen(page, tapped.x + pw / 2, tapped.y + ph / 2);
  await touch('touchStart', tapAt.x, tapAt.y);
  await expect(loupe).not.toHaveClass(/\bon\b/);
  await touch('touchEnd', tapAt.x, tapAt.y);
  await expect.poll(() => seen.state!.pieces[middle].y, { timeout: 3000 }).toBeCloseTo(tapped.y, 0);

  // Drag a piece from the middle of the table 40 pixels sideways (towards the middle, away from
  // the table's edge).
  let start = { ...st.pieces[middle] };
  let at = await onScreen(page, start.x + pw / 2, start.y + ph / 2);
  let dir = start.x > st.width / 2 ? -1 : 1;
  let to = { x: at.x + dir * 40, y: at.y };
  await touch('touchStart', at.x, at.y);
  for (let i = 1; i <= 5; i++) await touch('touchMove', at.x + dir * i * 8, at.y);
  // The magnifier shows up straight above the finger...
  await expect(loupe).toHaveClass(/\bon\b/);
  await page.waitForTimeout(200);
  let lb = (await loupe.boundingBox())!;
  expect(lb.x + lb.width / 2).toBeCloseTo(aboveX(to.x, lb.width / 2), 0);
  expect(lb.y + lb.height).toBeLessThan(to.y - 30);
  // ...centred on the piece in hand, bigger than on the table...
  const [bx, by, zoom] = (await loupe.getAttribute('data-at'))!.split(',').map(Number);
  expect(zoom).toBeGreaterThan(scale * 1.2);
  expect(bx).toBeCloseTo(start.x + (dir * 40) / scale + pw / 2, -1);
  expect(by).toBeCloseTo(start.y + ph / 2, -1);
  // ...and it's drawn (a picture has lots of colours; an empty table has a handful).
  const colours = await loupe.evaluate((c: HTMLCanvasElement) => {
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    const found = new Set<number>();
    for (let i = 0; i < data.length; i += 4) found.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    return found.size;
  });
  expect(colours).toBeGreaterThan(200);
  await page.screenshot({ path: info.outputPath('magnifier-middle.png') });
  // The piece stayed under the finger, so it's dropped right there; the magnifier goes away.
  await touch('touchEnd', to.x, to.y);
  await expect.poll(() => seen.state!.pieces[middle].x).toBeCloseTo(start.x + (dir * 40) / scale, -1);
  expect(seen.state!.pieces[middle].y).toBeCloseTo(start.y, -1);
  await expect(loupe).not.toHaveClass(/\bon\b/);

  // The piece nearest the top of the screen: the magnifier still sits straight above the finger
  // (sliding off the top of the screen if it has to), and the table doesn't move.
  const canvas = view.locator('.pz-canvas');
  const cam = async () => (await canvas.getAttribute('data-cam'))!.split(',').map(Number);
  const top = byY[0].i;
  start = { ...seen.state!.pieces[top] };
  at = await onScreen(page, start.x + pw / 2, start.y + ph / 2);
  dir = start.x > st.width / 2 ? -1 : 1;
  to = { x: at.x + dir * 40, y: at.y };
  const before = await cam();
  await touch('touchStart', at.x, at.y);
  for (let i = 1; i <= 5; i++) await touch('touchMove', at.x + dir * i * 8, at.y);
  await expect(loupe).toHaveClass(/\bon\b/);
  await page.waitForTimeout(600);
  lb = (await loupe.boundingBox())!;
  expect(lb.x + lb.width / 2).toBeCloseTo(aboveX(to.x, lb.width / 2), 0);
  expect(lb.y + lb.height).toBeCloseTo(to.y - 46, 0);
  (await cam()).forEach((v, i) => expect(v).toBeCloseTo(before[i], 3));
  await page.screenshot({ path: info.outputPath('magnifier-top.png') });
  await touch('touchEnd', to.x, to.y);
  await expect(loupe).not.toHaveClass(/\bon\b/);
  await expect.poll(() => seen.state!.pieces[top].x).toBeCloseTo(start.x + (dir * 40) / scale, -1);
  expect(seen.state!.pieces[top].y).toBeCloseTo(start.y, -1);

  // The magnifier button turns it off, and it stays off.
  const button = view.locator('[data-pz="loupe"]');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('gd.magnifier'))).toBe('0');
  start = { ...seen.state!.pieces[middle] };
  at = await onScreen(page, start.x + pw / 2, start.y + ph / 2);
  await touch('touchStart', at.x, at.y);
  for (let i = 1; i <= 5; i++) await touch('touchMove', at.x - i * 8, at.y);
  await page.waitForTimeout(200);
  await expect(loupe).not.toHaveClass(/\bon\b/);
  await touch('touchEnd', at.x - 40, at.y);
  // (Wait for the server to place it: usually 40 pixels left, unless that's where it belongs.)
  await expect.poll(() => seen.state!.pieces[middle].x).not.toBeCloseTo(start.x, 0);

  // A group: join two neighbouring pieces in the middle of the screen (with the mouse, magnifier
  // still off), then turn it back on: two with nothing close by, away from where they go.
  const spot = { x: screen.x + screen.width * 0.4, y: screen.y + screen.height * 0.6 };
  const [cx0, cy0] = await cam();
  const spotOnTable = { x: cx0 + (spot.x - screen.x) / scale, y: cy0 + (spot.y - screen.y) / scale };
  const ps = seen.state!.pieces;
  const clear = (i: number) =>
    i !== middle && i !== top && alone(i) && Math.hypot(ps[i].x + pw / 2 - spotOnTable.x, ps[i].y + ph / 2 - spotOnTable.y) > 2.5 * pw;
  const a = ps.findIndex((_, i) => i % st.cols < st.cols - 1 && clear(i) && clear(i + 1));
  expect(a).toBeGreaterThanOrEqual(0);
  const pa = { ...ps[a] };
  await drag(page, await onScreen(page, pa.x + pw / 2, pa.y + ph / 2), spot);
  await expect.poll(async () => (await onScreen(page, seen.state!.pieces[a].x + pw / 2, seen.state!.pieces[a].y + ph / 2)).x).toBeCloseTo(spot.x, -1);
  const pb = { ...seen.state!.pieces[a + 1] };
  await drag(page, await onScreen(page, pb.x + pw / 2, pb.y + ph / 2), { x: spot.x + pw * scale, y: spot.y });
  await expect.poll(() => seen.state!.pieces[a + 1].g).toBe(seen.state!.pieces[a].g);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  // Magnifier on again: dragging the pair gets none (only single pieces do, even this small).
  const pair = { ...seen.state!.pieces[a] };
  at = await onScreen(page, pair.x + pw / 2, pair.y + ph / 2);
  await touch('touchStart', at.x, at.y);
  for (let i = 1; i <= 5; i++) await touch('touchMove', at.x + i * 8, at.y);
  await page.waitForTimeout(250);
  await expect(loupe).not.toHaveClass(/\bon\b/);
  await touch('touchEnd', at.x + 40, at.y);
  await expect.poll(() => seen.state!.pieces[a].x).toBeCloseTo(pair.x + 40 / scale, -1);
});
