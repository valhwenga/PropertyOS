import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Asking a report a question, and getting an answer that says what it answered.
 *
 * Every report read `from` and `to` from the URL and offered no control that
 * could set them, so the period was whatever the current calendar month
 * happened to be and the page never said which month that was. Worse, the
 * export route parsed the query string a second time on its own and called
 * half the reports with no filters at all: a file downloaded from a narrowed
 * screen could quietly contain everything, and the file is the thing that gets
 * forwarded to an accountant.
 *
 * What the browser proves that the suites beside it cannot: that the controls
 * reach the page, that the figures move when they are used, that the file and
 * the screen agree, and that a mistyped date shows the default with a warning
 * rather than a 500.
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

test.describe('report filters', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a report states its period, takes a new one, and exports what it shows', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ---------------------------------- 1. the period is on the page, in words */

    await page.goto(`${org}/reports/collection`, { waitUntil: 'domcontentloaded' });
    const header = await visibleText(page);
    expect(header).toMatch(/\d{2}\/\d{2}\/\d{4} to \d{2}\/\d{2}\/\d{4}/);
    expect(header).toContain('every property in your scope');

    /* ------------------------------------------- 2. and it can be changed */

    // Exact: the theme toggle's label contains the word "to", and a
    // substring match on a two-letter label finds it.
    await page.getByLabel('From', { exact: true }).fill('2026-01-01');
    await page.getByLabel('To', { exact: true }).fill('2026-12-31');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL(/from=2026-01-01/, { timeout: 30_000 });
    expect(await visibleText(page)).toContain('01/01/2026 to 31/12/2026');

    /* ------------------- 3. the export answers the same question as the screen */

    const csv = await page.request.get(
      `${org}/reports/collection/export.csv?from=2026-01-01&to=2026-12-31`,
    );
    expect(csv.status()).toBe(200);
    const body = await csv.text();
    expect(body).toContain('"Covers","01/01/2026 to 31/12/2026"');
    expect(body).toContain('2026-01-01');
    expect(csv.headers()['content-disposition'])
      .toContain('collection-2026-01-01-to-2026-12-31.csv');

    /* -------------------- 4. a point-in-time report is not filed under a range */

    const rentRoll = await page.request.get(`${org}/reports/rent-roll/export.csv?asAt=2026-06-30`);
    expect(rentRoll.status()).toBe(200);
    expect(rentRoll.headers()['content-disposition'])
      .toContain('rent-roll-as-at-2026-06-30.csv');
    expect(await rentRoll.text()).toContain('"Covers","as at 30/06/2026"');

    /* ------------------------------ 5. a report with no date says it has none */

    await page.goto(`${org}/reports/arrears`, { waitUntil: 'domcontentloaded' });
    const arrears = await visibleText(page);
    expect(arrears).toContain('as the records stand on');
    expect(arrears).toContain('cannot be re-created for a past date');
    // And offers no date box to accept and discard.
    await expect(page.getByLabel('As at', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('From', { exact: true })).toHaveCount(0);

    /* ---------------------------------- 6. narrowing by property moves figures */

    await page.goto(`${org}/reports/rent-roll`, { waitUntil: 'domcontentloaded' });
    const boxes = page.locator('input[name="property"]');
    const properties = await boxes.count();
    expect(properties, 'the demo has no property to narrow to').toBeGreaterThan(0);
    const rowsBefore = await page.locator('tbody tr').count();

    await boxes.first().check();
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL(/property=/, { timeout: 30_000 });
    const narrowed = await visibleText(page);
    // The narrowing is stated, not left for the reader to remember.
    expect(narrowed).not.toContain('every property in your scope');
    if (properties > 1) {
      expect(await page.locator('tbody tr').count()).toBeLessThan(rowsBefore);
    }

    /* ----------------------- 7. the journal extract refuses to be cut up */

    await page.goto(`${org}/reports/journal-lines`, { waitUntil: 'domcontentloaded' });
    const journal = await visibleText(page);
    expect(await page.locator('input[name="property"]').count()).toBe(0);
    expect(journal).toContain('does not balance');

    /* --------------------------- 8. a date it cannot read is said, not thrown */

    const broken = await page.goto(
      `${org}/reports/collection?from=banana&to=2026-12-31`,
      { waitUntil: 'domcontentloaded' },
    );
    expect(broken?.status(), 'a mistyped date answered 500').toBe(200);
    expect(await visibleText(page)).toContain('could not be read');

    /* --------------------- 9. a horizon the report does not offer is refused */

    await page.goto(`${org}/reports/lease-expiry?within=99999`, { waitUntil: 'domcontentloaded' });
    const horizon = await visibleText(page);
    expect(horizon).toContain('within 180 days of');
    expect(horizon).toContain('could not be read');
  });
});
