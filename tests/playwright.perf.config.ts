import { defineConfig, devices } from '@playwright/test';

/**
 * Performance measurement, kept out of the ordinary suite.
 *
 * These specs need an application pointed at the generated load dataset, which
 * is a different database from the one every other test uses. Running them by
 * accident would measure the demo seed and report a meaningless number, so
 * they live under their own config and are run deliberately:
 *
 *   pnpm perf
 */
export default defineConfig({
  testDir: './perf',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 300_000,
  use: {
    baseURL: process.env.APP_BASE_URL ?? 'http://localhost:3100',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : {}),
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
});
