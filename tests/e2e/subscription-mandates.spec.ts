import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearMandates } from './demo-state';

/**
 * Setting up a debit order, through the interface.
 *
 * The integration suite proves the refusals and the immutability. What the
 * browser has to prove is that a landlord can actually give the authority and
 * take it away again — and that nothing on the way says "active" before the
 * bank has said so, which is the one lie this screen could tell.
 *
 * Requires a running preview with demo data and SUBSCRIPTION_PAYMENT_PROVIDER=sandbox:
 *   ./scripts/preview.sh
 */

const CUSTOMER_ADMIN = 'admin@demo.invalid';
const SLUG = 'demo-blue-crane';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('a debit order mandate', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearMandates(SLUG);
  });

  test.afterAll(async () => { await clearMandates(SLUG); });

  test('is given, authorised by the bank, and withdrawn', async ({ page }) => {
    await signIn(page, CUSTOMER_ADMIN);
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });

    const panel = page.locator('[data-mandate-panel]');
    await expect(panel).toBeVisible();
    // The cap is explained as a cap, not as "an amount".
    await expect(panel).toContainText('most that may ever be collected');

    await expect(async () => {
      await panel.getByRole('button', { name: 'Set up a debit order' }).click();
      await expect(page.getByLabel('Account number')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 90_000 });

    await page.getByLabel('The most that may be collected').fill('2500.00');
    await page.getByLabel('Day of the month').selectOption('1');
    await page.getByLabel('First collection on').fill('2026-12-01');
    await page.getByLabel('Account holder').fill('Blue Crane Properties (Pty) Ltd');
    await page.getByLabel('Bank', { exact: true }).fill('Standard Bank');
    await page.getByLabel('Branch code').fill('051001');
    await page.getByLabel('Account number').fill('62001234567');
    await page.getByRole('button', { name: 'Authorise with my bank' }).click();

    // The stand-in bank, which says what it is.
    await expect(page.getByRole('heading', { name: 'Approve a debit order' }))
      .toBeVisible({ timeout: 60_000 });
    const bank = await visibleText(page);
    expect(bank).toContain('This is not your bank');
    expect(bank).toContain('R2500.00 each month');
    // The account number is never echoed back in full, only its last four.
    expect(bank).not.toContain('62001234567');
    expect(bank).toContain('4567');

    await page.getByRole('button', { name: 'Approve it' }).click();
    await expect(page.getByRole('heading', { name: 'Authorised' }))
      .toBeVisible({ timeout: 60_000 });

    // Back on their own settings: active, capped, and the account masked.
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });
    const settings = await visibleText(page);
    expect(settings).toContain('active');
    expect(settings).toContain('collect up to');
    expect(settings).toContain('ending 4567');
    expect(settings).not.toContain('62001234567');
    // And it says the terms cannot be edited, which is why there is no edit.
    expect(settings).toContain('cannot be edited');

    // Withdrawing it.
    const panelAgain = page.locator('[data-mandate-panel]');
    await expect(async () => {
      await panelAgain.getByRole('button', { name: 'Cancel this mandate' }).click();
      await expect(page.getByLabel('Why')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 90_000 });
    await page.getByLabel('Why').fill('Changing to the new business account');
    await page.getByRole('button', { name: 'Cancel it' }).click();

    // Offered again, with the old one kept in the history rather than erased.
    await expect(page.getByRole('button', { name: 'Set up a debit order' }))
      .toBeVisible({ timeout: 60_000 });
    expect(await visibleText(page)).toContain('Earlier mandates');
  });

  test('declined by the bank leaves nothing authorised', async ({ page }) => {
    await signIn(page, CUSTOMER_ADMIN);
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });

    const panel = page.locator('[data-mandate-panel]');
    await expect(async () => {
      await panel.getByRole('button', { name: 'Set up a debit order' }).click();
      await expect(page.getByLabel('Account number')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 90_000 });

    await page.getByLabel('The most that may be collected').fill('2500.00');
    await page.getByLabel('First collection on').fill('2026-12-01');
    await page.getByLabel('Account holder').fill('Blue Crane Properties (Pty) Ltd');
    await page.getByLabel('Bank', { exact: true }).fill('Standard Bank');
    await page.getByLabel('Branch code').fill('051001');
    await page.getByLabel('Account number').fill('62001234567');
    await page.getByRole('button', { name: 'Authorise with my bank' }).click();

    await expect(page.getByRole('heading', { name: 'Approve a debit order' }))
      .toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Decline it' }).click();

    await expect(page.getByRole('heading', { name: 'Not authorised' }))
      .toBeVisible({ timeout: 60_000 });

    // Nothing live, and the reason the bank gave is kept.
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Set up a debit order' })).toBeVisible();
    expect(await visibleText(page)).toContain('declined it in their banking app');
  });
});
