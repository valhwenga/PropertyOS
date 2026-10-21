import { test, expect } from '@playwright/test';
import { clearInspectionResponses } from './demo-state';
import { signIn } from './sign-in';

/**
 * Two controls that existed in the domain and on no screen.
 *
 * `reverseReceipt`: the product could record money and not unrecord it. A
 * bounced cheque, a double capture, a deposit slip keyed against the wrong
 * landlord — all ordinary, and all needing a developer with a database
 * connection.
 *
 * `respondToInspection`: a report recording damage against somebody's deposit
 * could be finalised and the person it was about had no way to agree or
 * disagree with it. Of everything this product produces, that report is the
 * most likely to cost a tenant money, and it was the only one they could not
 * answer.
 *
 * Requires a running preview with demo data:
 *   pnpm host start --dev --reset
 */

const LANDLORD = 'admin@demo.invalid';
const RESIDENT = 'thandiwe@demo.invalid';

test.describe('corrections and responses', () => {
  test.describe.configure({ timeout: 900_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a receipt that should not have been recorded is reversed', async ({ page }) => {
    await signIn(page, LANDLORD);
    await page.goto('/app/demo-blue-crane/reconciliation', { waitUntil: 'domcontentloaded' });

    // Record the receipt this test is going to reverse, rather than reversing
    // the demo's one and leaving the next run with nothing: a reversed receipt
    // is not reversible again, so a spec that consumes a fixture works once.
    await page.getByRole('button', { name: 'Record money received' }).click();
    await page.locator('#amount').fill('1500.00');
    await page.locator('#receivedOn').fill(new Date().toISOString().slice(0, 10));
    await page.locator('#receiptLeaseId').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Record receipt' }).click();
    // Wait for the recording to land before looking for it in the list: the
    // modal says so, and reading the page before that found nothing.
    await expect(page.getByText(/Receipt recorded|Already recorded/)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Close' }).last().click();

    // Whatever it is called, it is now the newest receipt on the page. Picked
    // by link rather than by name so a numbering change does not break this.
    const href = await page
      .locator('a[href^="/app/demo-blue-crane/reconciliation/"]')
      .evaluateAll((links) => links
        .map((l) => (l as HTMLAnchorElement).getAttribute('href') ?? '')
        .find((h) => /\/reconciliation\/[0-9a-f-]{36}$/.test(h)) ?? null);
    expect(href, 'the receipt just recorded is not listed anywhere').not.toBeNull();
    await page.goto(href!, { waitUntil: 'domcontentloaded' });

    // The section exists only while the receipt is confirmed: nothing else can
    // be reversed.
    await expect(page.getByRole('heading', { name: 'If this payment was wrong' }))
      .toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'The money did not arrive' }).click();
    // It says what it is about to do before it is pressed, including what
    // happens to the allocations the receipt has already paid.
    await expect(page.getByText(/Nothing is deleted/)).toBeVisible();
    await page.locator('#reverse-receipt-reason')
      .fill('Cheque returned unpaid by the bank — demo correction');
    await page.getByRole('button', { name: 'Reverse the receipt' }).click();

    // Reversed: the receipt is failed and the control is gone, because a
    // failed receipt cannot be reversed again.
    await expect(page.getByRole('heading', { name: 'If this payment was wrong' }))
      .toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(/This receipt is failed/)).toBeVisible();
  });

  test('a resident answers the inspection report on their home', async ({ page }) => {
    // Unanswered, whatever an earlier run left behind.
    await clearInspectionResponses('demo-blue-crane');
    await signIn(page, RESIDENT);
    await page.goto('/portal', { waitUntil: 'domcontentloaded' });
    const tenancy = new URL(page.url()).pathname.startsWith('/portal/')
      ? new URL(page.url()).pathname
      : (await page.locator('a[href^="/portal/"]').first().getAttribute('href'))!;

    await page.goto(`${tenancy}/inspections`, { waitUntil: 'domcontentloaded' });

    // The report, with what was recorded room by room — including the item a
    // tenant would reasonably argue about.
    await expect(page.getByRole('heading', { name: 'Inspections' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Move-in inspection')).toBeVisible();
    await expect(page.getByText('Stove and oven')).toBeVisible();
    await expect(page.getByText(/Right front plate does not heat/)).toBeVisible();
    await expect(page.getByText('Waiting on you')).toBeVisible();

    /* ------------------------- a dispute needs to say what it disputes */
    await page.getByText(/I disagree with something in it/).click();
    await page.getByRole('button', { name: 'Send my response' }).click();
    // The browser stops an empty required field, so the form is still here.
    await expect(page.getByRole('button', { name: 'Send my response' })).toBeVisible();

    await page.locator('textarea[name="comment"]')
      .fill('The scuff marks beside the plug point were there when I moved in.');
    await page.getByRole('button', { name: 'Send my response' }).click();

    await expect(page.getByText('You disagreed')).toBeVisible({ timeout: 30_000 });
    // The recorded answer, not the textarea that still holds the same words.
    await expect(page.getByText(/^You answered .* were there when I moved in/s))
      .toBeVisible();

    /* ----------------------------- and can change their mind afterwards */
    await page.getByText(/I agree this is what the property was like/).click();
    await page.getByRole('button', { name: 'Update my response' }).click();
    await expect(page.getByText('You agreed')).toBeVisible({ timeout: 30_000 });
  });
});
