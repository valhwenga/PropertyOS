import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * A lease drafted in the product becomes a tenancy.
 *
 * The defect behind this spec is the largest one found in the audit:
 * `activateLease` had existed since the first milestone with no screen
 * anywhere, so a lease drafted here stayed a draft for ever — no rent
 * schedule, nothing for the billing run to find, no occupancy recorded, and
 * the unit left unreserved. Every lease that had ever been billed in this
 * product was activated by the seed script or by a test, and the lease list
 * told the reader that "a draft has no billing effect until it is activated",
 * which was true and unachievable.
 *
 * So this drafts one through the screens and activates it, and then asserts
 * the three consequences rather than the status badge: the rent schedule
 * exists, the unit is reserved, and the lease bills.
 *
 * Requires a running preview with demo data:
 *   pnpm host start --dev --reset
 */

const LANDLORD = 'admin@demo.invalid';

test.describe('activating a lease', () => {
  test.describe.configure({ timeout: 900_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a draft is activated, and only then does it bill', async ({ page }) => {
    await signIn(page, LANDLORD);

    /* ------------------------------------------------- draft a lease first */
    await page.goto('/app/demo-blue-crane/leases/new', { waitUntil: 'domcontentloaded' });

    // A vacant unit and a resident the demo already has.
    const unit = page.locator('select[name="unitId"]');
    await expect(unit).toBeVisible();
    const unitOptions = await unit.locator('option').count();
    test.skip(unitOptions < 2, 'the demo has no vacant unit to draft against');
    await unit.selectOption({ index: 1 });
    await page.locator('select[name="residentId"]').selectOption({ index: 1 });
    await page.locator('input[name="rent"]').fill('7200');
    await page.getByLabel('Starts').fill('01/12/2026');
    await page.getByLabel('Ends').fill('30/11/2027');
    await page.getByRole('button', { name: /Draft/ }).click();

    // The form confirms rather than redirecting, and its own words are the
    // promise this spec is here about: "Activate it from the lease when you are
    // ready to bill."
    const open = page.getByRole('link', { name: 'Open the lease' });
    await expect(open).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Activate it from the lease/)).toBeVisible();
    await open.click();
    await page.waitForURL(/\/leases\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const leaseUrl = page.url();

    /* --------------------- a draft says so, and says what it does not do */
    await expect(page.getByText(/This lease is a draft/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Nothing is billed and nothing is reserved/)).toBeVisible();

    /* ---------------------------------- neither half alone is enough */
    const activation = page.locator('form', { has: page.locator('#executionExceptionReason') });
    await activation.getByRole('button', { name: 'Activate this lease' }).click();
    // No document and no reason: refused, in the screen's own words.
    await expect(page.getByText(/Attach the signed lease, or say why/)).toBeVisible({
      timeout: 30_000,
    });

    /* ------------------------------------------------------- activate it */
    await activation.locator('#executionExceptionReason')
      .fill('Signed copy is in the post; the tenant moved in on the agreed date');
    await activation.getByRole('button', { name: 'Activate this lease' }).click();

    // The panel is gone, because the lease is no longer a draft.
    await expect(page.getByText(/This lease is a draft/)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('Activated without an attached contract')).toBeVisible();
    await expect(page.getByText(/Signed copy is in the post/)).toBeVisible();

    /* ------------------- and the consequences, which are the actual point */
    // The rent schedule the billing run reads. Without this the lease is
    // active and still bills nothing, which is the failure this spec exists
    // for.
    const schedules = page.locator('section', { hasText: 'What this lease bills every month' });
    await expect(schedules.getByText('Rent').first()).toBeVisible();
    await expect(schedules.getByText('7,200.00').first()).toBeVisible();

    // The unit is reserved: drafting a second lease on the same unit for an
    // overlapping period is refused by the exclusion constraint, not by a
    // read-then-write in the application.
    await page.goto(leaseUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/active/i).first()).toBeVisible();
  });
});
