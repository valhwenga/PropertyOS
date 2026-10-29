import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearPaymentTestData, reopenAccount, seedOverdueInvoice } from './demo-state';

/**
 * Chasing an unpaid subscription invoice, through the interface.
 *
 * The integration suite proves the ladder: the thresholds, one step per
 * invoice per day, who the reminder is addressed to, and that the automatic
 * pass cannot suspend anybody. What the browser has to prove is the part a
 * person does — that an operator can see what has been sent, stop the chasing
 * on one invoice and suspend an account over another, and that the customer
 * being chased can see it from their own side.
 *
 * Requires a running preview with demo data:
 *   ./scripts/host.sh start --dev
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

test.describe('chasing an unpaid invoice', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearPaymentTestData();
    await reopenAccount(SLUG);
  });

  test.afterAll(async () => {
    await clearPaymentTestData();
    await reopenAccount(SLUG);
  });

  test('an operator reads what was sent, stops chasing one, and suspends over another', async ({
    page,
  }) => {
    // Two debts on the same customer: one being chased, one that has run out
    // of automatic steps and is waiting on a person.
    const chased = await seedOverdueInvoice(SLUG, {
      daysOverdue: 12, monthsBack: 11, steps: ['first_reminder', 'final_notice'],
    });
    const waiting = await seedOverdueInvoice(SLUG, {
      daysOverdue: 24, monthsBack: 10,
      steps: ['first_reminder', 'final_notice', 'suspension_proposed'],
    });

    await signIn(page, OPERATOR);
    await page.goto('/platform/chasing', { waitUntil: 'domcontentloaded' });

    // What was sent, and when, is on the card — the question an operator has
    // with a customer on the phone.
    const chasedCard = page.locator(`[data-overdue="${chased.invoiceNumber}"]`);
    await expect(chasedCard).toBeVisible({ timeout: 30_000 });
    await expect(chasedCard).toContainText('Reminder sent');
    await expect(chasedCard).toContainText('Final notice sent');

    const waitingCard = page.locator(`[data-overdue="${waiting.invoiceNumber}"]`);
    await expect(waitingCard).toContainText('needs a decision');
    await expect(waitingCard).toContainText('Suspension proposed');

    // Stopping the chasing on the first one. It is not a write-off: the card
    // says so, and the invoice is untouched.
    await chasedCard.getByRole('button', { name: 'Stop chasing this' }).click();
    await chasedCard.getByLabel('Why the chasing is stopping')
      .fill('Rang in, paying by transfer on Friday');
    await chasedCard.getByRole('button', { name: 'Stop chasing' }).click();
    await expect(page.getByText('Decided (1)')).toBeVisible({ timeout: 30_000 });

    // And suspending the account over the second, which is a person's act with
    // its own reason.
    const stillWaiting = page.locator(`[data-overdue="${waiting.invoiceNumber}"]`);
    await stillWaiting.getByRole('button', { name: 'Suspend the account' }).click();
    await stillWaiting.getByLabel('Why the account is being suspended')
      .fill('Unpaid after a final notice and two calls');
    await stillWaiting.getByRole('button', { name: 'Suspend the account' }).click();

    await expect(page.locator(`[data-overdue="${waiting.invoiceNumber}"]`))
      .toContainText('suspended', { timeout: 30_000 });

    // The suspension names the invoice it was for, on the customer's record.
    await page.goto(`/platform/customers/${SLUG}`, { waitUntil: 'domcontentloaded' });
    const record = await visibleText(page);
    expect(record).toContain(waiting.invoiceNumber);
    expect(record).toContain('days overdue');
  });

  test('the customer being chased can see what arrived', async ({ page }) => {
    const { invoiceNumber } = await seedOverdueInvoice(SLUG, {
      daysOverdue: 12, steps: ['first_reminder', 'final_notice'],
    });

    await signIn(page, CUSTOMER_ADMIN);
    await page.goto(`/app/${SLUG}/settings/subscription`, { waitUntil: 'domcontentloaded' });

    const panel = page.locator('[data-chasing]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('We sent a reminder');
    await expect(panel).toContainText('We sent a final notice');
    await expect(panel).toContainText(invoiceNumber);

    // And what it does not say: nothing threatens their records, because
    // non-payment never takes them away.
    await expect(panel).toContainText('records are never deleted');
  });
});
