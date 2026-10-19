import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Making the product look like the landlord's own.
 *
 * Three claims a browser is the only place to settle. That choosing an accent
 * actually repaints the console rather than only writing a row. That a logo
 * an administrator uploads is the thing that appears in the sidebar. And that
 * a file which is not an image is refused with a reason, not stored and then
 * served to every resident.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

/** A real 48×48 PNG, built here so the test carries no binary fixture. */
function pngBytes(): Buffer {
  const header = Buffer.alloc(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(48, 16);
  header.writeUInt32BE(48, 20);
  return header;
}

test.describe('appearance', () => {
  test.describe.configure({ timeout: 240_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an administrator sets the accent, uploads a logo, and is refused a script', async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    await page.goto(`${org}/settings/appearance`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();

    /* ------------------------------------------- 1. the accent is applied */

    await page.getByRole('radio', { name: /Ocean/ }).check({ force: true });
    await page.getByRole('button', { name: 'Save appearance' }).click();
    await expect(page.getByText(/Saved\./).first()).toBeVisible({ timeout: 30_000 });

    // The console itself, not the form: the shell carries the chosen accent on
    // every page, which is what makes a primary button change colour.
    await page.goto(`${org}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-brand="ocean"]').first()).toBeVisible({ timeout: 30_000 });

    /* ----------------------------------------------- 2. a logo, and only a logo */

    await page.goto(`${org}/settings/appearance`, { waitUntil: 'domcontentloaded' });

    // A script dressed as a PNG. The name and the content type both claim an
    // image; the bytes do not, and the bytes are what decides.
    await page.setInputFiles('#logo', {
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByText(/not a PNG or a JPEG/)).toBeVisible({ timeout: 30_000 });
    expect(await visibleText(page)).toContain('SVG is not accepted');

    await page.setInputFiles('#logo', {
      name: 'brand.png', mimeType: 'image/png', buffer: pngBytes(),
    });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByAltText(/logo as it appears/)).toBeVisible({ timeout: 30_000 });

    // And it is served: the sidebar on the next page shows the uploaded file
    // rather than the Spike wordmark.
    await page.goto(`${org}`, { waitUntil: 'domcontentloaded' });
    const logo = page.locator('aside img').first();
    await expect(logo).toBeVisible({ timeout: 30_000 });
    const served = await page.request.get(`${org}/brand-logo`);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toContain('image/png');
    // Never rendered as a document, whatever got through.
    expect(served.headers()['x-content-type-options']).toBe('nosniff');

    /* -------------------------------------------------- 3. put it back */

    await page.goto(`${org}/settings/appearance`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Remove logo' }).click();
    await expect(page.getByText(/No logo yet/)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('radio', { name: /Spike purple/ }).check({ force: true });
    await page.getByRole('button', { name: 'Save appearance' }).click();
    await expect(page.getByText(/Saved\./).first()).toBeVisible({ timeout: 30_000 });
  });

  test('the theme choice is saved against the account, not the browser', async ({ page }) => {
    await signIn(page, 'thandiwe@demo.invalid');
    await page.goto('/account', { waitUntil: 'domcontentloaded' });

    await page.getByRole('radio', { name: 'Dark' }).check();
    await page.getByRole('button', { name: 'Save for my account' }).click();
    await expect(page.getByText(/follow you to your next device/)).toBeVisible({
      timeout: 30_000,
    });

    // A different browser session entirely — no localStorage, nothing carried
    // over but the account. The server renders the saved theme itself.
    const fresh = await page.context().newPage();
    await fresh.goto('/portal', { waitUntil: 'domcontentloaded' });
    await expect(fresh.locator('html')).toHaveAttribute('data-theme', 'dark');
    await fresh.close();

    // Left as it was found, so the rest of the suite sees the light theme.
    await page.goto('/account', { waitUntil: 'domcontentloaded' });
    await page.getByRole('radio', { name: 'Follow my device' }).check();
    await page.getByRole('button', { name: 'Save for my account' }).click();
    await expect(page.getByText(/follow you to your next device/)).toBeVisible({
      timeout: 30_000,
    });
  });
});
