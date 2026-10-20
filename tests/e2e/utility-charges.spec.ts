import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Billing a tenant for the municipality, through the screen.
 *
 * What only a browser settles: that an operator can raise a water charge with
 * its meter reading at all (there was no screen for any ad-hoc charge until
 * now), that it lands on a document the tenant can download, and that the
 * document shows the reading and the tariff rather than an amount to take on
 * trust.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';

test.describe('utility charges', () => {
  test.describe.configure({ timeout: 600_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a water charge is raised with its reading and reaches the invoice', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    await page.goto(`${org}/leases`, { waitUntil: 'domcontentloaded' });
    const leaseHref = await page.locator('a[href*="/leases/"]').evaluateAll((links) =>
      links.map((l) => (l as HTMLAnchorElement).getAttribute('href') ?? '')
        .find((href) => /\/leases\/[0-9a-f-]{36}$/.test(href)) ?? null);
    expect(leaseHref, 'the demo has a lease to charge').toBeTruthy();

    await page.goto(leaseHref!, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Raise a charge' })).toBeVisible();

    /* ------------------------------------ 1. the meter fields follow the category */

    await page.getByLabel('What is this for').selectOption('utility_water');
    await expect(page.getByLabel('Current reading')).toBeVisible();

    // A refuse charge has no meter to read, so it offers none.
    await page.getByLabel('What is this for').selectOption('utility_refuse');
    await expect(page.getByLabel('Current reading')).toHaveCount(0);

    /* ------------------------------------------------- 2. raise a real one */

    const marker = String(Date.now()).slice(-5);
    await page.getByLabel('What is this for').selectOption('utility_water');
    await page.getByLabel(/^Amount/).fill('385.80');
    await page.getByLabel('Description on the invoice').fill(`Water consumption ${marker}`);
    await page.getByLabel('Previous reading').fill('4312');
    await page.getByLabel('Current reading').fill('4324');
    await page.getByLabel('Quantity').fill('12');
    await page.getByLabel(/^Rate per/).fill('32.15');
    await page.getByRole('button', { name: 'Post this charge' }).click();

    await expect(page.getByText(/Posted as /)).toBeVisible({ timeout: 60_000 });

    /* ------------------------------- 3. it is a document the tenant can read */

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Documents issued' }))
      .toBeVisible({ timeout: 30_000 });

    const docHref = await page.locator('a[href*="/invoice.pdf"]').first().getAttribute('href');
    expect(docHref).toBeTruthy();
    const pdf = await page.request.get(docHref!);
    expect(pdf.status()).toBe(200);
    const body = (await pdf.body()).toString('latin1');

    // The sum behind the figure: the reading, the quantity and the tariff.
    expect(body).toContain('meter 4312 to 4324');
    expect(body).toContain('12 kl');
    expect(body).toContain('32.15');
    // Named as water, not as "utility".
    expect(body).toContain('Water');
    // And it still carries the reference a payment needs.
    expect(body).toContain('USE THIS REFERENCE');
  });
});
