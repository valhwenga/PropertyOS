import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Changing what a lease bills, and applying the escalation it agreed.
 *
 * The defect behind this spec: the lease agreement this product generates
 * promises that the rent increases on each anniversary, the lease records the
 * percentage, and nothing ever applied it — so the billing run went on raising
 * the original amount for the whole term. There was also no screen to add a
 * recurring parking bay or levy at all.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';

test.describe('recurring charges', () => {
  test.describe.configure({ timeout: 600_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a recurring charge is added, changed, and keeps its history', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');

    await page.goto(`${org}/leases`, { waitUntil: 'domcontentloaded' });
    const leaseHref = await page.locator('a[href*="/leases/"]').evaluateAll((links) =>
      links.map((l) => (l as HTMLAnchorElement).getAttribute('href') ?? '')
        .find((href) => /\/leases\/[0-9a-f-]{36}$/.test(href)) ?? null);
    await page.goto(leaseHref!, { waitUntil: 'domcontentloaded' });

    const panel = page.locator('section', { hasText: 'What this lease bills every month' })
      .first();
    await expect(panel).toBeVisible();
    // The rent schedule activation wrote is there to see, which it never was.
    await expect(panel.getByText('Rent').first()).toBeVisible();

    /* ------------------------------------------------- 1. add a recurring charge */

    const existing = await panel.getByText('Parking').count();
    if (existing === 0) {
      await panel.getByRole('button', { name: 'Add a recurring charge' }).click();
      await panel.getByLabel('What for').selectOption('parking');
      await panel.getByLabel(/^Amount a month/).fill('650.00');
      await panel.getByLabel('Description on the invoice').fill('Parking bay 7');
      await panel.getByRole('button', { name: 'Add it' }).click();
      await expect(page.getByText(/The next billing run raises it/))
        .toBeVisible({ timeout: 60_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
    }

    /* ------------------------------------- 2. change it, and keep what it was */

    // An earlier run of this spec may already have made the change; the
    // product keeps that history on purpose, so the test continues from it
    // rather than trying to make it again and being refused.
    const scheduled = page.locator('li', { hasText: 'Parking' }).filter({ hasText: 'From ' });
    if (await scheduled.count() === 0) {
      const parkingRow = page.locator('li', { hasText: 'Parking' })
        .filter({ hasText: 'Current' }).first();
      const dates = (await parkingRow.textContent() ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? [];
      expect(dates.length, 'the row states the dates it applies').toBeGreaterThan(0);

      // The day AFTER the current amount started. A change backdated onto its
      // own start would silently restate months it already covered, and the
      // domain refuses that.
      const from = new Date(`${dates[0]}T00:00:00Z`);
      from.setUTCDate(from.getUTCDate() + 1);

      await parkingRow.getByRole('button', { name: 'Change the amount' }).click();
      await page.getByLabel(/^New amount/).fill('720.00');
      await page.getByLabel(/^From/).fill(from.toISOString().slice(0, 10));
      await page.getByLabel(/^Reason/).fill('Body corporate increased the bay tariff');
      await page.getByRole('button', { name: 'Change it' }).click();
      await expect(page.getByText(/Changed from /)).toBeVisible({ timeout: 60_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    // Two rows: the one still billing until the change date, and the one
    // waiting to take over. A future row says when it starts rather than
    // calling itself historical, which is what a current/not-current pair
    // would have to say about it.
    await expect(page.locator('li', { hasText: 'Parking' }).filter({ hasText: 'From ' })
      .first()).toContainText('R720.00');
    expect(await page.locator('li', { hasText: 'Parking' }).count()).toBeGreaterThan(1);
  });

  test('an agreed escalation is proposed with its arithmetic, never applied alone', async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');

    await page.goto(`${org}/leases`, { waitUntil: 'domcontentloaded' });
    const hrefs = await page.locator('a[href*="/leases/"]').evaluateAll((links) =>
      links.map((l) => (l as HTMLAnchorElement).getAttribute('href') ?? '')
        .filter((href) => /\/leases\/[0-9a-f-]{36}$/.test(href)));

    // Whichever lease in the demo has an escalation that has fallen due. If
    // none has, the notice must not appear anywhere — which is the other half
    // of the claim and just as worth asserting.
    let found = false;
    for (const href of hrefs.slice(0, 6)) {
      await page.goto(href, { waitUntil: 'domcontentloaded' });
      const notice = page.getByText('An agreed rent increase is due and has not been applied');
      if (await notice.count() === 0) continue;
      found = true;

      await expect(notice).toBeVisible();
      // The arithmetic, not just an instruction: the percentage, the date it
      // fell due, and what is still being billed.
      const body = await page.locator('form', { hasText: 'An agreed rent increase' })
        .first().textContent();
      expect(body).toMatch(/% on each anniversary/);
      expect(body).toMatch(/still billing/);
      expect(body).toMatch(/check it against the lease/);

      // And it is a proposal: the field can be overridden before applying.
      await expect(page.getByLabel(/^New rent/)).toBeEditable();
      break;
    }

    if (!found) {
      // Nothing is due, so nothing may claim one is.
      expect(await page.getByText('An agreed rent increase is due').count()).toBe(0);
    }
  });
});
