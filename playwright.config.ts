import { defineConfig } from '@playwright/test';
import { hashAdminPassword } from './packages/server/src/adminAuth';
import { E2E_ADMIN_PASSWORD } from './e2e/testPassword';

/**
 * Browser tests that play the site like people do, on a desktop and a phone-sized screen.
 *
 *   npm run e2e                                    build a release and test it locally
 *   E2E_BASE_URL=https://staging.example.com npx playwright test --grep @smoke
 *                                                  quick checks against a deployed copy
 *
 * Locally they use the Chrome already installed; CI installs Playwright's own Chromium.
 */
const external = process.env.E2E_BASE_URL;
const port = 8790;
const ci = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: ci ? 2 : 3,
  retries: ci ? 1 : 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: external ?? `http://127.0.0.1:${port}`,
    channel: ci ? undefined : 'chrome',
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        // Voice tests: a fake microphone, no permission prompt, real local addresses.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { viewport: { width: 393, height: 711 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  ],
  webServer: external
    ? undefined
    : {
        command: 'node release/server.mjs',
        url: `http://127.0.0.1:${port}/healthz`,
        reuseExistingServer: !ci,
        stdout: 'ignore',
        env: {
          GAME_PORT: String(port),
          HOST: '127.0.0.1',
          NODE_ENV: 'production',
          RELEASE: 'e2e',
          LOG_DIR: 'test-results/server-logs',
          PUZZLE_DIR: 'test-results/puzzles',
          // Photo uploads with the pretend check (no AWS here): it refuses a photo 404 px wide.
          PHOTO_CHECK: 'pretend',
          ADMIN_PASSWORD_HASH: hashAdminPassword(E2E_ADMIN_PASSWORD),
          // Many tests open tables at once; production keeps its 50-table cap.
          MAX_PRIVATE_ROOMS: '200',
          EMPTY_ROOM_MS: '5000',
          // Every test comes from this one machine.
          LIMITS: JSON.stringify({ privateRoomsPer10Min: 1000, maxConnectionsPerIp: 500, connectsPerMinute: 5000 }),
        },
      },
});
