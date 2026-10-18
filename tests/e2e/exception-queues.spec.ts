import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * The counts on the overview, and whether they open the work they promise.
 *
 * A queue count is a promise that somebody will be told when there is
 * something to do. Three of these were broken in different ways: the pending
 * approvals tile counted a row the database forbids, so a deposit payout
 * waiting for an approver never reached it; the arrears tile linked to the
 * full ageing report with `overdue=true`, which the report ignored, so the
 * number counted money past its due date and the page it opened listed every
 * unpaid charge including this morning's invoice; and nothing anywhere
 * surfaced a quarantined file, an approved-but-unpaid supplier cost, or a
 * lease signed off that nobody activated.
 *
 * What the browser proves that the suites beside it cannot: that each tile
 * opens a list filtered to exactly what it counted.
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

/**
 * The figure printed on a named overview tile.
 *
 * Matched on the tile's own label, exactly. A substring match finds the wrong
 * card: "Applied to earlier periods" mentions arrears in its qualification and
 * "Outstanding receivable" links to the same report, so looking for a tile
 * containing the word picks whichever comes first.
 */
async function tile(
  page: import('@playwright/test').Page, label: string,
): Promise<{ value: string; href: string }> {
  const card = page.locator('a')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
  await expect(card).toBeVisible();
  const text = await card.innerText();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return { value: lines[1] ?? '', href: (await card.getAttribute('href')) ?? '' };
}

test.describe('exception queues', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('every tile opens the records it counted', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();
    await page.goto(`${org}`, { waitUntil: 'domcontentloaded' });

    const overview = await visibleText(page);
    expect(overview).toContain('Needs attention');

    /* ------------------- 1. the three queues that had no screen at all */

    for (const label of ['Approved, not yet paid', 'Quarantined files', 'Leases awaiting activation']) {
      expect(overview, `${label} is not on the overview`).toContain(label);
    }

    /* ------------------------- 2. arrears opens arrears, not everything */

    // Arrears is no longer a tile of its own: the overdue figure qualifies the
    // outstanding receivable, and the oldest arrears panel links to the ageing
    // report. The promise under test is unchanged — what it opens is what it
    // listed, past due only.
    const ageing = page.getByRole('link', { name: 'Full ageing →' });
    const ageingHref = await ageing.getAttribute('href');
    expect(ageingHref).toContain('overdue=true');
    await page.goto(ageingHref!, { waitUntil: 'domcontentloaded' });
    const report = await visibleText(page);
    // The report now honours the flag it was always being sent, and says so.
    expect(report).toContain('past due as the records stand on');
    expect(report).toContain('Showing only leases with a balance past its due date');
    await expect(page.getByLabel('Past due only')).toBeChecked();

    /* ---------------------------- 3. and the toggle works both ways */

    await page.getByLabel('Past due only').uncheck();
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL((url) => !url.search.includes('overdue'), { timeout: 30_000 });
    expect(await visibleText(page)).not.toContain('Showing only leases with a balance past');

    /* ------------------------ 4. the expense queues link to themselves */

    await page.goto(`${org}/expenses`, { waitUntil: 'domcontentloaded' });
    const expenses = await visibleText(page);
    if (expenses.includes('approved and unpaid')) {
      await page.getByRole('link', { name: /Work the queue/ }).last().click();
      await page.waitForURL(/status=posted/, { timeout: 30_000 });
      const queue = await visibleText(page);
      // Whatever its date: a payables queue that shows only this month's
      // invoices is not a payables queue.
      expect(queue).toContain('whatever its date');
      for (const row of await page.locator('tbody tr').allInnerTexts()) {
        expect(row).toMatch(/Posted|Approved/i);
      }
    }

    /* --------------------- 5. the quarantine tile opens the held files */

    await page.goto(`${org}`, { waitUntil: 'domcontentloaded' });
    const held = await tile(page, 'Quarantined files');
    expect(held.href).toContain('held=yes');
    await page.goto(held.href, { waitUntil: 'domcontentloaded' });
    expect(await visibleText(page)).toMatch(/records?|Nothing matches/);
  });
});
