import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * The monthly billing workflow, driven the way an operator would.
 *
 * Billing had a read-only preview and a note on the page saying posting was
 * not wired up. The domain could preview, validate, version and post idempotently;
 * none of it was reachable. This follows the whole thing: preview a period,
 * prepare it as a run, read the validation report, approve and post, then
 * download the batch summary.
 *
 * One sign-in. Each one spends a single-use authentication code.
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

test.describe('billing', () => {
  test.describe.configure({ timeout: 240_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a period is previewed, prepared, approved, posted and exported', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------------------- 1. preview */

    // Find the first month that actually has something to bill.
    //
    // Hard-coding a month does not survive the suite being run twice: once a
    // schedule and period are billed the duplicate guard correctly refuses a
    // second charge, and a test that assumes an unbilled month would report a
    // product defect on its second run. Picking a month outside the demo
    // lease's term has the opposite problem — nothing is billable and the test
    // silently skips, which is what the first version of this did.
    const months = Array.from({ length: 11 }, (_, i) => `2026-${String(i + 2).padStart(2, '0')}`);
    let prepared = false;

    for (const period of months) {
      await page.goto(`${org}/billing?period=${period}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();

      const previewText = await visibleText(page);
      expect(previewText).toContain('Nothing on this page posts a charge');

      const prepare = page.getByRole('button', { name: 'Prepare this run' });
      if (await prepare.isVisible().catch(() => false)) {
        await prepare.click();
        prepared = true;
        break;
      }
    }
    expect(prepared, 'no month in the demo lease term had anything left to bill').toBe(true);

    /* ------------------------------------------------------- 2. prepare */

    await page.waitForURL(/\/billing\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const runUrl = page.url();

    const runText = await visibleText(page);
    expect(runText).toContain('Validation report');
    expect(runText).toContain('preview version');

    /* ------------------------------------------------------- 3. approve */

    // The confirmation is required before anything posts, and it restates the
    // figures so nobody approves a number they scrolled past.
    await page.getByRole('button', { name: 'Approve and post this run' }).click();
    const confirmText = await visibleText(page);
    expect(confirmText).toContain('cannot be edited or deleted');
    expect(confirmText).toContain('does not double-bill');

    await page.getByRole('button', { name: /^Post \d+ charges?$/ }).click();

    // What success looks like is the run's own posted view, not a toast: the
    // page revalidates and renders the charges the run raised. A refusal keeps
    // the form and shows its reason, which is the useful thing to report.
    const succeeded = page.getByRole('heading', { name: 'Charges raised' });
    const refused = page.getByText('Could not post this run');
    await expect(succeeded.or(refused)).toBeVisible({ timeout: 30_000 });
    if (await refused.isVisible().catch(() => false)) {
      throw new Error(`posting was refused: ${await visibleText(page)}`);
    }

    /* ---------------------------------------- 4. posted state and export */

    await page.goto(runUrl, { waitUntil: 'domcontentloaded' });
    const postedText = await visibleText(page);
    expect(postedText).toContain('posted');
    expect(postedText).toContain('Charges raised');
    // The validation report is gone: it describes what a run would do, and this
    // one has done it.
    expect(postedText).not.toContain('Validation report');

    const summary = await page.request.get(`${runUrl}/summary.csv`);
    expect(summary.status()).toBe(200);
    const csv = await summary.text();
    expect(csv).toContain('Billing batch summary');
    expect(csv).toContain('Posted charges are immutable');
    expect(csv).toContain('Document');

    /* ------------------------------------------- 5. posting twice is safe */

    // Re-posting the same run must not raise a second set of charges. The
    // confirmation is simply no longer offered, because the run is posted.
    await expect(page.getByRole('button', { name: 'Approve and post this run' })).toHaveCount(0);
  });
});
