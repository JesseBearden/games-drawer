// Builds the link-preview picture (art/og.jpg, 1200x630) shown when an invite link is shared,
// from the home page's own felt art: the page felt, the drawer, the two hands and the headline.
// Needs Chrome (Playwright's "chrome" channel) and the internet for the site's font.
// Run with: npx tsx scripts/make-og.ts
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ART = path.resolve('packages/client/public/art');
const OUT = path.join(ART, 'og.jpg');
const art = (name: string) => pathToFileURL(path.join(ART, name)).href;

// Colours, felt size and the pressed-in text lip match felt.css and paper.css.
const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@800&display=block" rel="stylesheet" />
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    background: #e9dac4 url('${art('felt/paper.webp')}') 0 0 / 384px;
    font-family: 'Atkinson Hyperlegible Next', sans-serif;
    font-weight: 800;
    color: #112875;
    text-shadow: 0 1px 0 rgb(255 255 255 / 0.6);
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .brand {
    position: absolute;
    top: 20px;
    left: 40px;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 34px;
    letter-spacing: -0.02em;
  }
  .brand img { width: 58px; height: 58px; }
  /* A little wider than the picture, so the sleeves run off both sides. */
  .hero { display: block; flex: none; width: 1240px; margin-top: 46px; }
  h1 {
    margin: 26px 0 0;
    font-size: 92px;
    line-height: 1;
    letter-spacing: -0.03em;
  }
</style></head>
<body>
  <div class="brand"><img src="${art('brand.webp')}" alt="" />Games Drawer</div>
  <img class="hero" src="${art('together.webp')}" alt="" />
  <h1>Play a game together.</h1>
</body></html>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
// Opened from a file so it can show the art beside it (a blank page can't load local pictures).
const tmp = path.join(os.tmpdir(), 'games-drawer-og.html');
fs.writeFileSync(tmp, html);
await page.goto(pathToFileURL(tmp).href, { waitUntil: 'networkidle', timeout: 30_000 });
await page.evaluate(() => document.fonts.ready);
const fontLoaded = await page.evaluate(() => document.fonts.check('800 92px "Atkinson Hyperlegible Next"'));
if (!fontLoaded) throw new Error('The site font did not load; check the internet connection and try again.');
await page.screenshot({ path: OUT, type: 'jpeg', quality: 86 });
await browser.close();
fs.rmSync(tmp, { force: true });
console.log(path.relative(process.cwd(), OUT));
