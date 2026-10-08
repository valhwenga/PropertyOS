import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Smoke checks for a local preview.
 *
 * These answer one question: is the preview this developer just started actually
 * usable, or does it merely render? A preview that signs you in and then shows
 * nothing — which is what happens when no second factor is enrolled, because
 * elevated roles are MFA-gated inside `app.has_permission` — looks broken, and
 * the failure is silent. So the operator path is walked all the way to a figure
 * on the page, and tenant isolation is checked while we are here.
 *
 * The sign-in helper, TOTP and all, lives in ./sign-in.ts.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 *
 * Run with:
 *   pnpm preview:check
 */

test.describe('local preview', () => {
  // Completing a second factor can need to wait out a 30-second TOTP window
  // before retrying, which does not fit the default 30-second budget.
  test.describe.configure({ timeout: 120_000 });

  // One project only. These checks ask whether the preview works at all, which
  // is not device-specific — and a TOTP code is good for exactly one sign-in, so
  // running the same account twice inside one 30-second window would have the
  // second run rejected as a replay. Device coverage lives in portal.spec.ts.
  // An empty pattern is Playwright's documented way to take no fixtures while
  // still reading testInfo, so the rule is wrong here rather than the code.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'preview checks run on one project only');
  });

  // Warm the server-action path before any test spends a one-time code.
  //
  // The first sign-in against a freshly started server is markedly slower than
  // the rest — enough to outlast a 30-second TOTP window. Paying that cost here,
  // with an account that needs no second factor, means the operator test is not
  // racing initialisation with the lifetime of its code. It is also why this
  // cannot simply be the first test: whichever test ran first would pay it.
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await signIn(page, 'thandiwe@demo.invalid');
    } finally {
      await page.close();
    }
  });

  test('the landlord operator gets past the second factor and sees real figures', async ({ page }) => {
    await signIn(page, 'admin@demo.invalid');
    await page.goto('/app');

    // Demo data is labelled, so its presence is also proof we are not looking at
    // anything real.
    await expect(page.getByText(/\[DEMO\]/).first()).toBeVisible();

    // The organisation name is not itself the link, so follow the first link
    // into an organisation rather than guessing at its accessible name.
    await page.locator('a[href^="/app/"]').first().click();

    // Asserting on the content rather than waiting for 'networkidle': the console
    // keeps connections open, so network idle never arrives and the wait times
    // out even though the page rendered. The assertion below retries on its own.
    //
    // An MFA-gated account with no factor reaches this page and sees nothing. A
    // rendered amount is what distinguishes a working preview from that.
    await expect(page.getByText(/R[\d  ,]+\.\d\d/).first()).toBeVisible({ timeout: 20_000 });
  });

  test("the resident sees the blueprint's closing balance", async ({ page }) => {
    await signIn(page, 'thandiwe@demo.invalid');
    await page.goto('/portal');
    await expect(page.getByText('R1,850.00').first()).toBeVisible();
  });

  test('the second landlord sees none of the first landlord’s portfolio', async ({ page }) => {
    await signIn(page, 'other-admin@demo.invalid');
    await page.goto('/app');
    await expect(page.getByText('[DEMO] Karoo Letting').first()).toBeVisible();
    await expect(page.getByText('[DEMO] Blue Crane Rentals')).toHaveCount(0);
  });

  test('healthz reports the database and tenant isolation', async ({ request }) => {
    const response = await request.get('/healthz');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'healthy',
      checks: { database: 'ok', tenantIsolation: 'ok' },
    });
  });
});
