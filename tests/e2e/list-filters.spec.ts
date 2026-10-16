import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Finding one record in a list, through the interface.
 *
 * Leases, residents and documents had no search, no filter and no paging. All
 * three read every row in the organisation and filtered in the page, and the
 * documents list cut itself off at the most recent 200 rows in silence —
 * which looks exactly like having 200 documents. An archived resident could
 * not be reached from anywhere in the product at all: the query excluded them
 * and nothing could ask.
 *
 * What the browser proves that the suites beside it cannot: that the controls
 * reach the page, that the filter survives in the URL so a filtered list can
 * be sent to a colleague, and that the line under the list says how much of
 * the set is on screen.
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

test.describe('list filters', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an operator searches a list, and the list says what it is showing', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------- 1. the count is on the page */

    await page.goto(`${org}/residents`, { waitUntil: 'domcontentloaded' });
    const listed = await visibleText(page);
    // "3 records" is what tells somebody the list is complete. Its absence is
    // indistinguishable from a list that stopped early.
    expect(listed).toMatch(/\d+ records?/);
    const before = await page.locator('tbody tr').count();
    expect(before).toBeGreaterThan(0);

    /* ------------------------------------------------- 2. search narrows it */

    await page.getByLabel('Search').fill('mokoena');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL(/q=mokoena/, { timeout: 30_000 });

    const found = await page.locator('tbody tr').count();
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThanOrEqual(before);
    for (const row of await page.locator('tbody tr').allInnerTexts()) {
      expect(row.toLowerCase()).toContain('mokoena');
    }

    /* ------------------- 3. a search that matches nothing says what it means */

    await page.getByLabel('Search').fill('nobodybythisname');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL(/q=nobodybythisname/, { timeout: 30_000 });
    const empty = await visibleText(page);
    // Not "no residents yet": the difference between an empty product and a
    // filter that excluded everybody is the whole message.
    expect(empty).toContain('Nobody matches those filters');
    expect(empty).not.toContain('No residents yet');

    /* ----------------------------- 4. an archived person can now be reached */

    await page.getByRole('link', { name: 'Reset' }).click();
    await page.waitForURL(/residents$/, { timeout: 30_000 });
    await page.getByLabel('Status').selectOption('archived');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL(/status=archived/, { timeout: 30_000 });
    // Whether the demo has one is not the point; that the question can be
    // asked at all is.
    expect(await visibleText(page)).toMatch(/records?|Nobody matches/);

    /* ------------------------------- 5. leases filter by status, and the URL
                                          is the state, so it can be shared */

    await page.goto(`${org}/leases?status=active`, { waitUntil: 'domcontentloaded' });
    const leases = await page.locator('tbody tr').allInnerTexts();
    expect(leases.length).toBeGreaterThan(0);
    for (const row of leases) expect(row).toContain('Active');

    /* ------------------- 6. the quarantine banner counts every held file */

    await page.goto(`${org}/documents`, { waitUntil: 'domcontentloaded' });
    const documents = await visibleText(page);
    if (documents.includes('quarantined')) {
      await page.getByRole('link', { name: 'Show only those files' }).click();
      await page.waitForURL(/held=yes/, { timeout: 30_000 });
      const held = await page.locator('tbody tr').allInnerTexts();
      expect(held.length).toBeGreaterThan(0);
      for (const row of held) expect(row).toMatch(/Awaiting scan|Not scanned|Flagged|Scan failed/);
    }

    /* ---------------------- 7. a mistyped page number is the first page */

    const broken = await page.goto(`${org}/documents?page=banana`, {
      waitUntil: 'domcontentloaded',
    });
    expect(broken?.status()).toBe(200);
    expect(await visibleText(page)).toMatch(/\d+ records?|Showing 1/);
  });
});
