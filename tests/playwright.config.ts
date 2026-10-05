import { defineConfig, devices } from '@playwright/test';

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
