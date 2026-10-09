import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Deposits, through the interface.
 *
 * There was no deposits domain module at all — the schema carried the controls
 * and nothing a person could reach enforced them. What a browser proves here
 * that the integration suite cannot: that an operator can record a deposit and
 * see it held separately from rent, and that the screen states what the money
 * is rather than leaving it to be inferred.
 *
 * The two-person approval, the evidence requirement and the refusal to pay out
 * more than is held are proved in `tests/integration/deposits.test.ts`, where
 * two identities are cheap. Here there is one sign-in, because each spends a
 * single-use authentication code.
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

test.describe('deposits', () => {
  test.describe.configure({ timeout: 240_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a deposit is recorded, held separately from rent, and fully accounted', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------- what the arrears were before */

    // Just the ageing figures, not the whole page: the chrome carries a theme
    // toggle whose glyph changes on hydration, and comparing that would report
    // a financial defect every time the icon settled differently.
    const arrearsTotals = async (): Promise<string> => {
      const text = await visibleText(page);
      const table = text.slice(text.indexOf('Arrears ageingResident'));
      return table;
    };

    await page.goto(`${org}/reports/arrears`, { waitUntil: 'domcontentloaded' });
    const arrearsBefore = await arrearsTotals();

    /* -------------------------------------------------------- record a deposit */

    await page.goto(`${org}/deposits`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Deposits', exact: true })).toBeVisible();

    const register = await visibleText(page);
    expect(register).toContain('does not reduce any rent receivable');
    expect(register).toContain('A deposit shortfall is never billed as rent');

    await page.getByRole('button', { name: 'Record a deposit received' }).first().click();
    await page.getByLabel('Lease').selectOption({ index: 1 });
    await page.getByLabel('Amount received').fill('1500.00');
    await page.getByLabel('Description').fill('Deposit top-up on review');
    await page.getByRole('button', { name: 'Record deposit' }).click();

    const recorded = page.getByText('Deposit recorded.');
    const failed = page.getByText('Not saved');
    await expect(recorded.or(failed)).toBeVisible({ timeout: 20_000 });
    if (await failed.isVisible().catch(() => false)) {
      throw new Error(`recording the deposit was refused: ${await visibleText(page)}`);
    }

    /* ------------------------------------------- it did not touch the arrears */

    await page.goto(`${org}/reports/arrears`, { waitUntil: 'domcontentloaded' });
    // The whole invariant, observable: R1,500 arrived and the ageing reads
    // exactly as it did before. A deposit is never netted off rent.
    expect(await arrearsTotals()).toBe(arrearsBefore);

    /* ------------------------------------------------------ the deposit itself */

    await page.goto(`${org}/deposits`, { waitUntil: 'domcontentloaded' });

    // Navigate by the href rather than clicking it. A click plus
    // waitForLoadState races: the load state can settle on the page the test
    // started from, and the failure then reads as a missing heading rather
    // than as navigation that never happened.
    const href = await page
      .locator('a[href*="/deposits/"]:not([href$="/deposits"])')
      .first()
      .getAttribute('href');
    expect(href, 'no deposit row linked to a deposit').toBeTruthy();
    await page.goto(href!, { waitUntil: 'domcontentloaded' });

    const detail = await visibleText(page);
    expect(detail).toContain('This money belongs to the resident');
    expect(detail).toContain('Every movement');
    expect(detail).toContain('Received');
    expect(detail).toContain('Deposit top-up on review');
    // Entries are append-only, and the page says so rather than offering a
    // delete that would quietly rewrite someone else's money.
    expect(detail).toContain('append-only');
    expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);

    // No interest has been invented. §10: a guessed rate is never presented as
    // earned interest.
    expect(detail).toContain('PropertyOS does not accrue any');

    /* ------------------------------------- approving a payout needs a second person */

    await page.getByRole('button', { name: 'Deduct, refund or transfer' }).click();
    const payout = await visibleText(page);
    expect(payout).toContain('an approver who is not the person who asked for it');
    // And the product does not claim to know what is lawful.
    expect(payout).toContain('PropertyOS decides');
    // The amount at risk is stated with its currency. An unqualified number on
    // a screen that pays out someone else's money is exactly the wrong place
    // to be ambiguous.
    expect(payout).toMatch(/R[\d,]+\.\d{2} is held/);

    // With no document on the lease the fields are withheld and the reason is
    // given, rather than offering a form the server would refuse. The
    // two-person rule itself is proved in the integration suite, where a
    // second identity costs nothing.
    expect(payout).toContain('a deduction without evidence is blocked');
  });
});
