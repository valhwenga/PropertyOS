import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import {
  clearCollections, clearPaymentTestData, seedAuthenticatedMandate, seedPayableInvoice,
} from './demo-state';

/**
 * Collecting on a mandate, through the interface.
 *
 * The integration suite proves the cap, the authority and the reversal. What
 * the browser has to prove is the thing an operator does on the first of the
 * month: prepare a run, look at it, submit it, and see what the bank said —
 * with the customer able to see the same thing from their own side, which is
 * what stops a debit order becoming a dispute.
 *
 * Requires a running preview with demo data and SUBSCRIPTION_PAYMENT_PROVIDER=sandbox:
 *   ./scripts/preview.sh
 */

const OPERATOR = 'support@demo.invalid';
const CUSTOMER_ADMIN = 'admin@demo.invalid';
const SLUG = 'demo-blue-crane';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('a debit order run', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearCollections(SLUG);
    await clearPaymentTestData();
  });

  test.afterAll(async () => { await clearCollections(SLUG); await clearPaymentTestData(); });

  test('is prepared, submitted, and settles the invoice when the bank pays', async ({ page }) => {
    await seedAuthenticatedMandate(SLUG, 500_000);
    const { invoiceNumber } = await seedPayableInvoice(SLUG, 115_000);

    await signIn(page, OPERATOR);
    await page.goto('/platform/collections', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Debit orders' })).toBeVisible();

    // The screen is honest about the stand-in before anything is submitted.
    expect(await visibleText(page)).toContain('moves no money');

    await page.getByLabel('Collection date').fill(new Date().toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Prepare' }).click();

    // Prepared, named, and nothing sent.
    await expect(page.getByText(/prepared for/)).toBeVisible({ timeout: 60_000 });
    const afterPrepare = await visibleText(page);
    expect(afterPrepare).toContain('Prepared, nothing sent');
    expect(afterPrepare).toMatch(/R1.?150\.00/);
    expect(afterPrepare).toContain('ending 4567');

    // The customer can see it coming, before it leaves.
    await page.context().clearCookies();
    await signIn(page, CUSTOMER_ADMIN);
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });
    const customerView = await visibleText(page);
    expect(customerView).toContain('What is being collected');
    expect(customerView).toContain('not taken yet');
    expect(customerView).toContain(invoiceNumber);

    // Back as the operator: submit it, then the bank answers.
    await page.context().clearCookies();
    await signIn(page, OPERATOR);
    await page.goto('/platform/collections', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Submit to the bank' }).first().click();
    await expect(page.getByText('With the bank')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('link', { name: 'produce one now' }).click();
    await expect(page.getByRole('heading', { name: /^Answer for COL-/ }))
      .toBeVisible({ timeout: 60_000 });
    expect(await visibleText(page)).toContain('This is not a bank');
    await page.getByRole('button', { name: 'The money came out' }).click();
    await expect(page.getByRole('heading', { name: 'Debit orders' }))
      .toBeVisible({ timeout: 60_000 });

    // Successful, and the invoice is settled.
    await page.goto('/platform/collections', { waitUntil: 'domcontentloaded' });
    expect(await visibleText(page)).toContain('successful');

    await page.goto('/platform/billing', { waitUntil: 'domcontentloaded' });
    const billing = await visibleText(page);
    expect(billing).toContain(invoiceNumber);
    expect(billing).toContain('Paid');
  });

  test('an unpaid debit leaves the invoice owing, and says why', async ({ page }) => {
    await seedAuthenticatedMandate(SLUG, 500_000);
    const { invoiceNumber } = await seedPayableInvoice(SLUG, 115_000);

    await signIn(page, OPERATOR);
    await page.goto('/platform/collections', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Collection date').fill(new Date().toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Prepare' }).click();
    await expect(page.getByText(/prepared for/)).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'Submit to the bank' }).first().click();
    await expect(page.getByText('With the bank')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: 'produce one now' }).click();
    await page.getByRole('button', { name: 'Insufficient funds' }).click();
    await expect(page.getByRole('heading', { name: 'Debit orders' }))
      .toBeVisible({ timeout: 60_000 });

    // The operator sees why, in the section for things that need a decision.
    await page.goto('/platform/collections', { waitUntil: 'domcontentloaded' });
    const operatorView = await visibleText(page);
    expect(operatorView).toContain('Did not come out');
    expect(operatorView).toContain('Insufficient funds');

    // The invoice is still owing.
    await page.goto('/platform/billing', { waitUntil: 'domcontentloaded' });
    const billing = await visibleText(page);
    expect(billing).toContain(invoiceNumber);

    // And the customer is told, in those words.
    await page.context().clearCookies();
    await signIn(page, CUSTOMER_ADMIN);
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });
    const customerView = await visibleText(page);
    expect(customerView).toContain('did not go through');
    expect(customerView).toContain('still owing');
  });
});
