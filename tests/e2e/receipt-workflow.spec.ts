import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * The receipt workflow, driven the way an operator would.
 *
 * Rent and receivables had tested domain logic and no screen that performed any
 * of it: receipts, allocation, suspense and reversal all existed as functions
 * nobody could reach. A passing domain test is not a workflow, so this follows
 * the whole thing through the interface — record money, hold it in suspense,
 * say whose it is, apply part of it, leave the rest as credit, then reverse.
 *
 * One sign-in for the lot. Each one spends a single-use authentication code,
 * and a second would cost thirty seconds waiting for a window it may use.
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

test.describe('receipt workflow', () => {
  test.describe.configure({ timeout: 240_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('money is recorded, identified, part-applied and reversed', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------- 1. record, without a payer */

    await page.goto(`${org}/reconciliation`, { waitUntil: 'domcontentloaded' });

    // The product's central financial promise, asserted where a user can see
    // it: the screen must say in words that a resident's claim has reduced
    // nothing. Checked here rather than in a test of its own, because each
    // sign-in spends a single-use authentication code.
    expect(await visibleText(page)).toContain('has not reduced any balance');

    await page.getByRole('button', { name: 'Record money received' }).click();

    const reference = `TEST ${String(Date.now()).slice(-6)}`;
    await page.getByLabel('Amount received').fill('2500.00');
    await page.getByLabel('Reference on the statement').fill(reference);
    // Payer deliberately left as "Not identified": unidentified money belongs
    // in suspense, and that has to be reachable from the form.
    await page.getByRole('button', { name: 'Record receipt' }).click();

    await expect(page.getByText(/Receipt recorded/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/in suspense until you say whose it is/)).toBeVisible();

    /* ------------------------------------------------ 2. identify the payer */

    await page.goto(`${org}/reconciliation`, { waitUntil: 'domcontentloaded' });
    const identify = page.getByRole('link', { name: 'Identify →' }).first();
    await expect(identify).toBeVisible({ timeout: 15_000 });
    await identify.click();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText('This money has no identified payer')).toBeVisible();
    const receiptUrl = page.url();

    await page.getByLabel('Whose payment is this?').selectOption({ index: 1 });
    await page.getByLabel('How do you know?')
      .fill('Matched the reference on the bank statement.');
    await page.getByRole('button', { name: 'Assign to this lease' }).click();

    // Out of suspense. Crucially the money is NOT applied to anything yet:
    // knowing whose it is says nothing about what it pays for.
    await expect(page.getByText('This money has no identified payer')).toBeHidden({ timeout: 20_000 });
    const afterIdentify = await visibleText(page);
    expect(afterIdentify).toContain('Apply this money to charges');
    expect(afterIdentify).toContain('Nothing applied yet');

    /* ------------------------------------------------- 3. suggest and apply */

    await page.getByRole('button', { name: /Suggest — oldest due date first/ }).click();
    await expect(page.getByText(/Filled in using the oldest due date first policy/))
      .toBeVisible({ timeout: 20_000 });

    // A suggestion is not final. Override it completely: clear every box the
    // suggestion filled, then apply one rand to the first charge alone.
    //
    // One rand, not a round figure, and deliberately so. This suite runs
    // against the demo organisation, whose charges carry whatever earlier runs
    // left on them, and an amount larger than a charge's remaining balance is
    // correctly refused. A test that assumes a fresh fixture is a test that
    // reports a product defect every time it is run twice.
    const amountBoxes = page.locator('input[name^="amount:"]');
    const boxCount = await amountBoxes.count();
    expect(boxCount, 'no open charges to apply to').toBeGreaterThan(0);
    for (let i = 0; i < boxCount; i++) await amountBoxes.nth(i).fill('');
    await amountBoxes.first().fill('1.00');

    await expect(page.getByText('Left as unapplied credit')).toBeVisible();
    await page.getByRole('button', { name: 'Apply to these charges' }).click();
    await expect(page.getByText(/Applied\./)).toBeVisible({ timeout: 20_000 });

    await page.goto(receiptUrl, { waitUntil: 'domcontentloaded' });
    const afterApply = await visibleText(page);
    expect(afterApply).toContain('What this receipt has paid');
    expect(afterApply).toContain('R1.00');
    // The rest stayed as credit rather than being forced onto a charge.
    expect(afterApply).toContain('Unapplied credit');

    /* ---------------------------------------------------------- 4. reverse */

    await page.getByRole('button', { name: 'Reverse' }).first().click();
    await page.getByLabel('Why?').fill('Applied to the wrong charge; re-allocating.');
    await page.getByRole('button', { name: 'Confirm reversal' }).click();

    await page.waitForTimeout(2000);
    await page.goto(receiptUrl, { waitUntil: 'domcontentloaded' });
    const afterReverse = await visibleText(page);

    // The money is back as credit, and the reversed allocation is still on
    // screen: a corrected allocation is history, not something to erase.
    expect(afterReverse).toContain('Reversed');
    expect(afterReverse).toContain('Applied to the wrong charge');
    expect(afterReverse).toContain('R2,500.00');
  });

});
