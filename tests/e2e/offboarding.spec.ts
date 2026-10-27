import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { reopenAccount } from './demo-state';

/**
 * A customer leaving, through the interface.
 *
 * The integration suite proves the refusals and the destruction itself. What
 * the browser has to prove is the part that can only be got wrong on a screen:
 * that closing an account tells the customer, on the page they are actually
 * sent to, how long their records are kept and how to take them — because
 * before this work the only link to their own archive was on a console page
 * that closing had just taken away from them.
 *
 * Destruction is deliberately not exercised here. It is irreversible, the demo
 * database is shared with every other spec, and a browser test is a poor place
 * to find out that a cleanup step did not run.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const OPERATOR = 'support@demo.invalid';
const CUSTOMER_ADMIN = 'other-admin@demo.invalid';
const SLUG = 'demo-karoo';

/**
 * Clicks a disclosure button until the thing it reveals is actually there.
 *
 * Playwright's click waits for the button, not for React to have attached a
 * handler to it, and the preview runs in dev mode where the bundle arrives
 * noticeably after `domcontentloaded`. A click that lands first does nothing at
 * all and is not retried, which shows up later as a timeout on a field that was
 * never going to appear. Retrying the click is the fix; waiting longer before it
 * is a guess.
 */
async function reveal(
  page: import('@playwright/test').Page, button: string, field: string,
): Promise<void> {
  await expect(async () => {
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByLabel(field)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
}

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('a customer leaving', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await reopenAccount(SLUG, 'trial');
  });

  test.afterAll(async () => { await reopenAccount(SLUG, 'trial'); });

  test('closes with a date, and the customer is told and can take their records',
    async ({ page }) => {
      await signIn(page, OPERATOR);
      await page.goto(`/platform/customers/${SLUG}`, { waitUntil: 'domcontentloaded' });

      // The status form no longer offers closing, because closing needs a date.
      const statusSelect = page.locator('select#status');
      await expect(statusSelect.locator('option[value="closed"]')).toHaveCount(0);

      await reveal(page, 'Close this account', 'Why the account is closing');
      await page.getByLabel('Why the account is closing')
        .fill('The customer sold the portfolio and asked to close on SPK-7100');
      await page.getByLabel('Keep their records for').selectOption('12');
      await page.getByRole('button', { name: 'Close the account' }).click();

      // The panel turns into the retention clock.
      await expect(page.getByText(/kept \d+ more days?/)).toBeVisible({ timeout: 30_000 });
      const operatorText = await visibleText(page);
      expect(operatorText).toContain('SPK-7100');
      expect(operatorText).toContain('Records kept until');
      // Not yet destroyable, so that button is not on the page at all.
      await expect(page.getByRole('button', { name: 'Destroy these records' })).toHaveCount(0);

      // Now the customer's own side of it. The sign-in helper starts from a
      // signed-out browser — /sign-in redirects somebody who is already signed
      // in, so the form it fills never appears.
      await page.context().clearCookies();
      await signIn(page, CUSTOMER_ADMIN);
      await page.goto(`/app/${SLUG}`, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(new RegExp(`/account-suspended/${SLUG}`));

      const customerText = await visibleText(page);
      expect(customerText).toContain('Nothing has been deleted yet');
      // The date, on their screen rather than only on Spike's.
      expect(customerText).toContain('These records are kept until');
      // And what used to be here, which is no longer true.
      expect(customerText).not.toContain('there is no path');

      // The way out: present, and it actually produces an archive.
      const download = page.getByRole('link', { name: 'Download everything' });
      await expect(download).toBeVisible();
      const href = await download.getAttribute('href');
      expect(href).toBe(`/app/${SLUG}/settings/export/export.zip`);

      const archive = await page.request.get(href!, { timeout: 120_000 });
      expect(archive.status()).toBe(200);
      expect(archive.headers()['content-type']).toBe('application/zip');
      expect((await archive.body()).length).toBeGreaterThan(500);
    });

  test('reopening clears the clock', async ({ page }) => {
    await signIn(page, OPERATOR);
    await page.goto(`/platform/customers/${SLUG}`, { waitUntil: 'domcontentloaded' });

    await reveal(page, 'Close this account', 'Why the account is closing');
    await page.getByLabel('Why the account is closing')
      .fill('Closed in error while testing SPK-7102');
    await page.getByRole('button', { name: 'Close the account' }).click();
    await expect(page.getByText(/kept \d+ more days?/)).toBeVisible({ timeout: 30_000 });

    await page.locator('select#status').selectOption('active');
    await page.locator('#status-reason').fill('The customer stayed, SPK-7102 was wrong');
    await page.getByRole('button', { name: 'Change status' }).click();

    // Reloaded on purpose, and retried. The panel is one client component
    // across all three states, so after reopening it still carries the
    // disclosure state from the close it just did — its button reads "Cancel"
    // rather than "Close this account" even though the server has moved on.
    // What this test is about is the server's state, so it reloads until that
    // state is there rather than watching a toggle or waiting on a success
    // message, which also appears in the audit table below it.
    await expect(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Close this account' }))
        .toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 90_000 });
    expect(await visibleText(page)).not.toContain('Records kept until');
  });
});
