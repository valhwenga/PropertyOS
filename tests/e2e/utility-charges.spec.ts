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

  test('a mistaken charge is credited back from the screen', async ({ page }) => {
    // `issueCreditNote` existed since §5 with no screen at all: a posted
    // document is immutable, correctly, and an operator who had charged the
    // wrong amount had nowhere to go but the database.
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');

    await page.goto(`${org}/leases`, { waitUntil: 'domcontentloaded' });
    const leaseHref = await page.locator('a[href*="/leases/"]').evaluateAll((links) =>
      links.map((l) => (l as HTMLAnchorElement).getAttribute('href') ?? '')
        .find((href) => /\/leases\/[0-9a-f-]{36}$/.test(href)) ?? null);
    await page.goto(leaseHref!, { waitUntil: 'domcontentloaded' });

    // Raise something to correct, so the test does not depend on what the
    // demo happens to hold.
    await page.getByLabel('What is this for').selectOption('utility_electricity');
    await page.getByLabel(/^Amount/).fill('1234.00');
    await page.getByLabel('Description on the invoice').fill('Electricity — wrong meter');
    await page.getByRole('button', { name: 'Post this charge' }).click();
    await expect(page.getByText(/Posted as /)).toBeVisible({ timeout: 60_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    const row = page.locator('li', { hasText: 'R1,234.00' }).first();
    await row.getByRole('button', { name: 'Credit this' }).click();

    // A reason is required, because the tenant reads it on the credit note.
    await page.getByLabel(/^Why/).first().fill('Read the wrong meter');
    await page.getByRole('button', { name: /^Credit INV-/ }).first().click();

    // The durable signal is the list: the invoice marked, and a credit note of
    // its own that the tenant can download.
    await expect(page.getByText('Credited in full').first()).toBeVisible({ timeout: 60_000 });
    // By its own number rather than by position: the demo may already hold
    // credit notes from an earlier run, and any of them would pass a check
    // that only asked for "a credit note".
    const creditHref = await page.locator('a[href*="/invoice.pdf"]').evaluateAll((links) => {
      const match = links.find((l) => (l.textContent ?? '').trim().startsWith('CRN-'));
      return match ? match.getAttribute('href') : null;
    });
    expect(creditHref).toBeTruthy();

    const pdf = await page.request.get(creditHref!);
    const body = (await pdf.body()).toString('latin1');
    expect(body).toContain('CREDIT NOTE');
    expect(body).toContain('Read the wrong meter');
    // Nothing to pay on it, and no bank details at all.
    expect(body).toContain('Nothing is payable on this credit note');
    expect(body).not.toContain('HOW TO PAY');
  });
});
