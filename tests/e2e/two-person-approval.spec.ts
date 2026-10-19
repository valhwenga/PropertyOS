import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * The §4 control, set from the screen and felt on the screen.
 *
 * The integration suite proves what happens to the ledger. What only a browser
 * can establish is the thing an approver actually experiences: that a rule can
 * be turned on by a landlord rather than by an engineer, that the first of two
 * approvals does not report success, and that the person who drafted the cost
 * is turned away in words rather than by a disabled button they cannot explain.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';
const APPROVER = 'finance@demo.invalid';

/**
 * Opens the approval form and checks it opened.
 *
 * A click that lands before hydration does nothing at all, and on a cold
 * development server that is a real possibility rather than a theoretical one.
 */
async function revealApproval(page: import('@playwright/test').Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByRole('button', { name: 'Approve this cost' }).click();
    if (await page.getByRole('button', { name: 'Approve and post' })
      .isVisible({ timeout: 5_000 }).catch(() => false)) return;
  }
  throw new Error('the approval form never opened');
}

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('two-person approval', () => {
  test.describe.configure({ timeout: 600_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a landlord turns it on, and one approval is no longer enough', async ({
    page, browser,
  }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------------- 1. the rule is a setting */

    await page.goto(`${org}/settings/approvals`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Approval rules' })).toBeVisible();

    const costs = page.locator('form').filter({ hasText: 'Supplier costs' });
    await costs.getByRole('radio', { name: 'Two' }).check();
    await costs.getByRole('button', { name: 'Save' }).click();
    await expect(costs.getByText(/applies to the next decision/)).toBeVisible({
      timeout: 30_000,
    });

    /* ------------------------------------------------------- 2. draft a cost */

    const period = new Date().toISOString().slice(0, 7);
    const marker = `Two-approver repair ${String(Date.now()).slice(-6)}`;
    await page.goto(`${org}/expenses?period=${period}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Record a cost' }).first().click();
    await page.getByLabel('Amount').fill('18500.00');
    await page.getByLabel('What it is for').fill(marker);
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });

    await page.goto(`${org}/expenses?period=${period}`, { waitUntil: 'domcontentloaded' });
    const href = await page.getByRole('link', { name: marker }).first().getAttribute('href');
    expect(href, 'the new draft did not appear in the list').toBeTruthy();

    /* ------------------------- 3. the person who drafted it cannot approve it */

    await page.goto(href!, { waitUntil: 'domcontentloaded' });
    await revealApproval(page);
    await page.getByRole('button', { name: 'Approve and post' }).click();

    await expect(page.getByText('Could not approve')).toBeVisible({ timeout: 30_000 });
    expect(await visibleText(page)).toContain('you prepared it');

    // Still a draft, and the queue still has it.
    await page.goto(href!, { waitUntil: 'domcontentloaded' });
    expect(await visibleText(page)).toContain('Recorded but not in anyone');

    /* ----------------------------- 4. somebody else approves, and it waits */

    // A second browser, because the approver is a second PERSON: signing in
    // over the top of the administrator's session would not prove that.
    const second = await browser.newContext();
    const approver = await second.newPage();
    await signIn(approver, APPROVER);
    await approver.goto(href!, { waitUntil: 'domcontentloaded' });
    await revealApproval(approver);
    await approver.getByRole('button', { name: 'Approve and post' }).click();

    // The words that matter: recorded, not done.
    await expect(approver.getByText(/1 of 2/)).toBeVisible({ timeout: 30_000 });
    const waiting = await visibleText(approver);
    expect(waiting).toContain('nobody is owed anything');
    expect(waiting).toContain('cannot be you');

    // And the same person cannot supply the second signature either.
    await approver.goto(href!, { waitUntil: 'domcontentloaded' });
    await revealApproval(approver);
    await approver.getByRole('button', { name: 'Approve and post' }).click();
    await expect(approver.getByText('Could not approve')).toBeVisible({ timeout: 30_000 });
    expect(await visibleText(approver)).toContain('already approved this');
    await second.close();

    /* ------------------------------ 5. the queue says who has already signed */

    await page.goto(`${org}/approvals`, { waitUntil: 'domcontentloaded' });
    const queue = await visibleText(page);
    expect(queue).toContain('1 of 2 approvals');
    expect(queue).toContain('must be somebody else');
  });

  test('the rule goes back to one approver', async ({ page }) => {
    // Left as it was found, so the rest of the suite — and the demo — behave
    // the way every other spec expects.
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');

    await page.goto(`${org}/settings/approvals`, { waitUntil: 'domcontentloaded' });
    const costs = page.locator('form').filter({ hasText: 'Supplier costs' });
    await costs.getByRole('radio', { name: 'One' }).check();
    await costs.getByRole('button', { name: 'Save' }).click();
    await expect(costs.getByText(/applies to the next decision/)).toBeVisible({
      timeout: 30_000,
    });
    expect(await visibleText(page)).toContain('One approver, which is the product default');
  });
});
