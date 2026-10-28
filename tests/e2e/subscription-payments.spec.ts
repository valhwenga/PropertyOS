import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearPaymentTestData, seedPayableInvoice } from './demo-state';

/**
 * Paying one of Spike's invoices, through the interface.
 *
 * The integration suite proves the refusals and the state machine. What the
 * browser has to prove is that the loop closes: a landlord presses Pay, a
 * provider says the money moved, and the invoice is settled — with the
 * provider's word arriving through the public notification endpoint rather
 * than through anything the browser touched.
 *
 * It runs against the sandbox provider, which signs its own notifications and
 * verifies them through exactly the code a real provider will go through. No
 * money moves and the page says so.
 *
 * Requires a running preview with demo data and SUBSCRIPTION_PAYMENT_PROVIDER=sandbox:
 *   ./scripts/preview.sh
 */

const CUSTOMER_ADMIN = 'admin@demo.invalid';
const OPERATOR = 'support@demo.invalid';
const SLUG = 'demo-blue-crane';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('paying a subscription invoice', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearPaymentTestData();
  });

  test.afterAll(async () => { await clearPaymentTestData(); });

  test('pays in full, and the invoice settles only on the provider word', async ({ page }) => {
    const { invoiceNumber } = await seedPayableInvoice(SLUG, 115_000);

    await signIn(page, CUSTOMER_ADMIN);
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });

    // Scoped to the card for this invoice: the demo customer may have others.
    const card = page.locator(`[data-invoice="${invoiceNumber}"]`);
    await expect(card).toBeVisible();

    // Whatever the locale formatting is, the button asks for 1 150 of
    // something — asserted on the digits rather than on the spacing, which is
    // the formatter's business and not this test's.
    const pay = card.getByRole('button', { name: /^Pay R.*1.?150/ });
    await expect(pay).toBeVisible();
    await pay.click();

    // The provider's stand-in page.
    await expect(page.getByRole('heading', { name: /^Pay R1150\.00$/ }))
      .toBeVisible({ timeout: 60_000 });

    // The stand-in page is loud about what it is. A screen that looks like a
    // checkout and takes no money is the worst thing to leave ambiguous.
    const sandbox = await visibleText(page);
    expect(sandbox).toContain('This is not a payment page');
    expect(sandbox).toContain('no money moves');

    await page.getByRole('button', { name: 'Pay it' }).click();

    // Back on the return page, and it says confirmed because the provider said
    // so out of band — not because the browser arrived here.
    await expect(page.getByRole('heading', { name: 'Paid, and confirmed' }))
      .toBeVisible({ timeout: 60_000 });
    expect(await visibleText(page)).toContain('not because you arrived here');

    // The invoice is settled, and the customer's own screen shows it.
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });
    const settled = page.locator(`[data-invoice="${invoiceNumber}"]`);
    await expect(settled).toContainText('Paid');
    await expect(settled.getByRole('button', { name: /Pay R/ })).toHaveCount(0);
  });

  test('a short payment leaves the invoice owing, and the operator sees it', async ({ page }) => {
    const { invoiceNumber } = await seedPayableInvoice(SLUG, 115_000);

    await signIn(page, CUSTOMER_ADMIN);
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });
    const card = page.locator(`[data-invoice="${invoiceNumber}"]`);
    await card.getByRole('button', { name: /^Pay R.*1.?150/ }).click();
    await expect(page.getByRole('heading', { name: /^Pay R1150\.00$/ }))
      .toBeVisible({ timeout: 60_000 });

    // Half of it, which is the case that must not mark an invoice settled.
    await page.getByLabel('Pay this many cents').fill('40000');
    await page.getByRole('button', { name: 'Pay part of it' }).click();

    await expect(page.getByRole('heading', { name: 'Paid, and confirmed' }))
      .toBeVisible({ timeout: 60_000 });

    // Still owing, and asking for the remainder rather than the whole amount
    // again.
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });
    const owing = page.locator(`[data-invoice="${invoiceNumber}"]`);
    // The remainder, not the whole amount again.
    await expect(owing.getByRole('button', { name: /^Pay R.*750/ })).toBeVisible();

    // And Spike's own billing screen says what arrived rather than treating it
    // as settled.
    await page.context().clearCookies();
    await signIn(page, OPERATOR);
    await page.goto('/platform/billing', { waitUntil: 'domcontentloaded' });
    const operatorView = await visibleText(page);
    expect(operatorView).toContain(invoiceNumber);
    expect(operatorView).toContain('received, short');
  });
});
