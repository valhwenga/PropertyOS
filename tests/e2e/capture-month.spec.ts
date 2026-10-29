import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Typing a month's utilities in one pass.
 *
 * The integration suite proves the arithmetic, the refusals and that a run
 * groups a tenancy's captured lines into one invoice. What the browser has to
 * prove is the part that made a landlord stop using it: that the readings can
 * be typed against every lease from one screen, that what was typed is visibly
 * a draft rather than a charge, and that it reaches the billing preview where
 * the money is approved.
 *
 * Requires a running preview with demo data:
 *   ./scripts/host.sh start --dev
 */

const ADMIN = 'admin@demo.invalid';
const SLUG = 'demo-blue-crane';

/** A month far enough ahead that no seeded run or invoice is in the way. */
function futureMonth(): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() + 2, 1);
  return date.toISOString().slice(0, 7);
}

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('capturing a month', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('types a meter reading against a lease and carries it to the billing preview', async ({
    page,
  }) => {
    const month = futureMonth();
    await signIn(page, ADMIN);
    await page.goto(`/app/${SLUG}/billing/capture?period=${month}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByRole('heading', { name: 'Capture the month' }))
      .toBeVisible({ timeout: 60_000 });

    // Every live tenancy is on this one screen — that is the whole point.
    const rows = page.locator('[data-capture-lease]');
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    expect(before).toBeGreaterThan(0);

    /* --------------------------------- 1. the meter book, typed in one row */

    const first = rows.first();
    await first.getByLabel('Charge').selectOption('utility_water');
    await first.getByLabel('Previous').fill('1420');
    await first.getByLabel('Current').fill('1461');
    await first.getByLabel(/Rate per/).fill('27.30');
    await first.getByRole('button', { name: 'Capture' }).click();

    // It says what it is: a draft, not a charge.
    await expect(page.getByText('Nothing is billed until the run is posted'))
      .toBeVisible({ timeout: 30_000 });

    /* ------------------- 2. the arithmetic is done for them, and shown back */

    // 41 kl at R27.30 = R1,119.30. Asserted on the digits rather than the
    // spacing, which is the formatter's business.
    const captured = await visibleText(page);
    expect(captured).toMatch(/Captured this month/);
    expect(captured).toMatch(/1.?119[.,]30/);
    expect(captured).toContain('1420 → 1461');

    /* ------------------------------------ 3. and it reaches the money screen */

    await page.goto(`/app/${SLUG}/billing?period=${month}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Captured for this month' }))
      .toBeVisible({ timeout: 60_000 });
    const preview = await visibleText(page);
    expect(preview).toMatch(/1.?119[.,]30/);
    expect(preview).toContain('41 kl');

    /* ------------------------------------------- 4. a draft can be thrown away */

    await page.goto(`/app/${SLUG}/billing/capture?period=${month}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('button', { name: 'Remove' }).first().click();
    await expect(page.getByText('Captured this month')).toBeHidden({ timeout: 30_000 });
  });
});
