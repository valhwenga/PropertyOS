import { test, expect } from '@playwright/test';
import { signIn, unusedCode } from './sign-in';

/**
 * Banking details, through the interface.
 *
 * The domain rules are covered in `tests/integration/bank-accounts.test.ts`,
 * which is where staleness, permissions and isolation are proved. What only a
 * browser can show is whether an operator can actually complete the work: that
 * the number they type is masked the moment it is stored, that the history
 * reads as a history, and — the one that matters most — that being refused for
 * a stale session leads somewhere instead of dead-ending on an error.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';

test.describe('banking details', () => {
  test.describe.configure({ timeout: 180_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an operator can add banking details and see them masked', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    await page.goto(`${org}/settings/banking`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Banking details' })).toBeVisible();

    const label = `Rent account ${Date.now()}`;
    await page.getByRole('button', { name: 'Add a bank account' }).first().click();
    await page.getByLabel('What to call it').fill(label);
    await page.getByLabel('Bank').fill('Standard Bank');
    await page.getByLabel('Account holder').fill('Blue Crane Rentals (Pty) Ltd');
    await page.getByLabel('Branch code').fill('051001');
    await page.getByLabel('Account number').fill('40 488 8321');
    await page.getByLabel('Why is this changing?').fill('Opening banking details for the pilot.');
    await page.getByRole('button', { name: 'Add account' }).click();

    await expect(page.getByText(label)).toBeVisible({ timeout: 15_000 });

    // The number the operator just typed must not be anywhere on the page.
    const body = await page.locator('body').evaluate((el) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
      return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    });
    expect(body).not.toContain('404888321');
    expect(body).not.toContain('40 488 8321');
    expect(body).toContain('•••• 8321');

    // A new account is not verified, and the screen says so in words rather
    // than leaving the operator to infer it from a missing badge.
    expect(body).toContain('Not verified — nobody has checked these details');

    // And the history already names the change and its reason.
    expect(body).toContain('Account added');
    expect(body).toContain('Opening banking details for the pilot.');
  });

  test('re-verification returns the operator to where they were', async ({ page }) => {
    // The recovery path. A refusal for a stale session is only useful if the
    // way out of it works and lands back on the same screen.
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    const destination = `${org}/settings/banking`;

    await page.goto(`/reauthenticate?returnTo=${encodeURIComponent(destination)}&action=change+the+account+number`);
    await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
    await expect(page.getByText(/Before you change the account number/)).toBeVisible();

    // A code from the NEXT window: signing in a moment ago spent this one, and
    // the server is right to refuse a replayed code.
    await page.getByLabel('Authentication code').fill(await unusedCode(ADMIN));
    await page.getByRole('button', { name: 'Confirm and continue' }).click();

    await page.waitForURL(`**${destination}`, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Banking details' })).toBeVisible();
  });

  test('re-verification will not bounce the operator off-site', async ({ page }) => {
    // returnTo comes from a query string, so it is attacker controlled. A
    // protocol-relative URL is the form most naive checks let through.
    await signIn(page, ADMIN);
    await page.goto('/reauthenticate?returnTo=//example.invalid/phish');
    const cancel = page.getByRole('link', { name: 'Cancel and go back' });
    await expect(cancel).toHaveAttribute('href', '/app');
  });
});
