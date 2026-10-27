import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearScheduledPrices } from './demo-state';

/**
 * Pricing the product, through the interface.
 *
 * The integration suite proves the thing that matters most — a period is
 * billed at the price in force for that period — which is invisible on a
 * screen. What the browser has to prove is the part a person depends on: that
 * the history is legible, that a price in force, a scheduled one and a past
 * one are three visibly different things, and that a price typed in rands is
 * not stored as cents.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const SUPPORT = 'support@demo.invalid';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('plans and pricing', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearScheduledPrices();
  });

  test.afterAll(async () => { await clearScheduledPrices(); });

  test('shows what each plan costs, and what it is worth', async ({ page }) => {
    await signIn(page, SUPPORT);
    await page.goto('/platform/plans', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Plans and pricing' })).toBeVisible();

    const text = await visibleText(page);
    // The rule the whole shape exists for, said on the page.
    expect(text).toContain('price in force for the period it bills');
    // The seeded plans, with their money in rands rather than cents.
    expect(text).toContain('Portfolio');
    expect(text).toContain('R899.00');
    expect(text).toContain('units included');
    // What the list is worth, so nobody opens a spreadsheet.
    expect(text).toContain('What the price list is worth');
    expect(text).toContain('nothing here is a forecast');
  });

  test('schedules a rise for next quarter without touching today', async ({ page }) => {
    await signIn(page, SUPPORT);
    await page.goto('/platform/plans', { waitUntil: 'domcontentloaded' });

    const card = page.locator('[data-plan="portfolio"]');
    const before = await card.innerText();
    expect(before).toContain('in force');

    const nextYear = `${new Date().getFullYear() + 1}-01-01`;
    await card.getByRole('button', { name: 'Set a price' }).click();
    await card.getByLabel('From').fill(nextYear);
    await card.getByLabel(/Monthly/).fill('1099.00');
    await card.getByLabel('Units included').fill('60');
    await card.getByLabel(/Each unit over/).fill('45.00');
    await card.getByLabel('Why').fill('Pricing review: agreed rise from January');
    await card.getByRole('button', { name: 'Save this price' }).click();

    await expect(card.getByText('scheduled')).toBeVisible({ timeout: 30_000 });

    const after = await card.innerText();
    // Scheduled, in rands, with the reason — and today's price untouched.
    expect(after).toContain(nextYear);
    expect(after).toContain('1,099.00');
    expect(after).toContain('Pricing review');
    expect(after).toContain('899.00');
    // Exactly one price is in force.
    expect(after.match(/in force/g)?.length).toBe(1);

    // And a scheduled price can still be dropped, because nothing has been
    // invoiced for it.
    const scheduledRow = card.locator('li').filter({ hasText: nextYear });
    await scheduledRow.getByPlaceholder('why it is dropped').fill('Review postponed');
    await scheduledRow.getByRole('button', { name: 'Drop' }).click();
    await expect(card.getByText(nextYear)).toHaveCount(0, { timeout: 30_000 });
  });
});
