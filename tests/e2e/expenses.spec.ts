import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Expenses, through the interface.
 *
 * There was no expenses domain module: the table and its cost classes have
 * existed since the schema was written with nothing able to write a row except
 * the CSV import, and no account to hold an approved-but-unpaid cost.
 *
 * What a browser proves that the integration suite cannot: that an operator can
 * get a cost from "an invoice arrived" to "we paid it" without leaving the
 * product, and that each screen says what the current state means for the books
 * rather than showing a badge and leaving them to guess.
 *
 * One sign-in — each spends a single-use authentication code.
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

test.describe('expenses', () => {
  test.describe.configure({ timeout: 240_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a cost is drafted, approved, then paid — and the two are different events', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------------------------ 1. draft */

    const period = new Date().toISOString().slice(0, 7);
    await page.goto(`${org}/expenses?period=${period}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Expenses', exact: true })).toBeVisible();

    const marker = `Geyser element ${String(Date.now()).slice(-6)}`;
    await page.getByRole('button', { name: 'Record a cost' }).first().click();
    await page.getByLabel('Amount').fill('2400.00');
    await page.getByLabel('What it is for').fill(marker);
    await page.getByRole('button', { name: 'Save as draft' }).click();

    const saved = page.getByText('Draft saved.');
    const failed = page.getByText('Not saved');
    await expect(saved.or(failed)).toBeVisible({ timeout: 20_000 });
    if (await failed.isVisible().catch(() => false)) {
      throw new Error(`recording the cost was refused: ${await visibleText(page)}`);
    }

    /* ----------------------------------------------------- 2. open it */

    await page.goto(`${org}/expenses?period=${period}`, { waitUntil: 'domcontentloaded' });
    const href = await page.getByRole('link', { name: marker }).first().getAttribute('href');
    expect(href, 'the new draft did not appear in the list').toBeTruthy();
    await page.goto(href!, { waitUntil: 'domcontentloaded' });

    const draft = await visibleText(page);
    // The state is explained, not just badged.
    expect(draft).toContain('Recorded but not in anyone');
    expect(draft).toContain('Nothing has been posted');
    // And the cost class says what it does to the result, rather than being an
    // enum the reader has to interpret.
    expect(draft).toContain('counts towards net operating income');

    /* --------------------------------------------------------- 3. approve */

    await page.getByRole('button', { name: 'Approve this cost' }).click();
    const confirm = await visibleText(page);
    expect(confirm).toContain('It does not pay anyone');
    expect(confirm).toMatch(/R[\d,]+\.\d{2}/);

    await page.getByRole('button', { name: 'Approve and post' }).click();

    const posted = page.getByText('No money has left the bank');
    const refused = page.getByText('Could not approve');
    await expect(posted.or(refused)).toBeVisible({ timeout: 20_000 });
    if (await refused.isVisible().catch(() => false)) {
      throw new Error(`approving was refused: ${await visibleText(page)}`);
    }

    // Approved is not paid, and the page is explicit about it.
    const afterApproval = await visibleText(page);
    expect(afterApproval).toContain('the supplier is owed it');
    expect(afterApproval).toContain('Record the payment');

    /* ------------------------------------------------------------- 4. pay */

    await page.getByRole('button', { name: 'Record the payment' }).click();
    await page.getByLabel('Payment reference').fill('EFT test');
    await page.getByRole('button', { name: 'Record the payment' }).click();

    const paid = page.getByText('the money has left the bank');
    const payFailed = page.getByText('Could not record the payment');
    await expect(paid.or(payFailed)).toBeVisible({ timeout: 20_000 });
    if (await payFailed.isVisible().catch(() => false)) {
      throw new Error(`paying was refused: ${await visibleText(page)}`);
    }

    // A paid cost cannot be voided, and the reason is given rather than the
    // button simply being absent.
    const afterPayment = await visibleText(page);
    expect(afterPayment).toContain('cannot be voided');
    expect(afterPayment).toContain('the money did leave the account');
    await expect(page.getByRole('button', { name: 'Void this cost' })).toHaveCount(0);
  });
});
