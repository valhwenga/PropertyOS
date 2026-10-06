import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Loads the preview's own .env.local, so the browser suite talks to the same
 * database and port the preview is actually using.
 *
 * The specs read the demo accounts' TOTP secrets directly, because a one-time
 * code cannot be typed from a fixture. Without this they fell back to a
 * passwordless `postgres` connection string, which fails on any cluster whose
 * superuser has a password — and the failure surfaced as two unrelated-looking
 * sign-in tests breaking, not as a configuration problem. Anything already in
 * the environment wins, so CI is unaffected.
 */
const ENV_FILE = fileURLToPath(new URL('../.env.local', import.meta.url));
if (existsSync(ENV_FILE) && !process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // Not fatal: the defaults below still apply and the specs report clearly.
  }
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.APP_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    // Some environments (locked-down CI images, containers with a preinstalled
    // browser) cannot run `playwright install`. Point this at an existing
    // Chromium rather than failing on a version Playwright wanted to download.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // The resident portal must be comfortable on a small phone with no
    // horizontal scrolling.
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});
