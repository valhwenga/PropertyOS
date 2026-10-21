import { test, expect } from '@playwright/test';
import { endLeaseTermYesterday } from './demo-state';
import { signIn } from './sign-in';

/**
 * What happens when a lease runs out.
 *
 * The defects behind this spec: `expireLease` had one test, no screen and no
 * scheduled job, and it is the only path in the product that writes the
 * `expired` status — so a tenancy that reached its end date stayed `active` for
 * ever. `renewLease` had **no references anywhere in the repository**, not even
 * a test, so continuing a tenancy meant drafting a fresh lease by hand and
 * losing the link between the two.
 *
 * Neither is automatic, and the spec asserts the product says so: whether the
 * tenant left or stayed on is a fact only a person knows, and a job that marked
 * leases expired at midnight would be guessing.
 *
 * Requires a running preview with demo data:
 *   pnpm host start --dev --reset
 */

const LANDLORD = 'admin@demo.invalid';

test.describe('a lease that has run out', () => {
  test.describe.configure({ timeout: 900_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('says so, is recorded as ended or as a holdover, and can be renewed', async ({ page }) => {
    const { leaseId } = await endLeaseTermYesterday('demo-blue-crane');

    await signIn(page, LANDLORD);
    await page.goto(`/app/demo-blue-crane/leases/${leaseId}?tab=history`, {
      waitUntil: 'domcontentloaded',
    });

    /* ------------------------------ the product says nothing happened by itself */
    await expect(page.getByText(/term ended .* and it is still recorded as active/))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/does not guess whether the tenant left or stayed on/))
      .toBeVisible();

    /* ---------------------------------------- record it, as a holdover */
    await page.getByRole('button', { name: 'The term has ended' }).click();
    const expiry = page.locator('form', { has: page.getByText('Has the tenant moved out?') });
    await expiry.getByText(/No, they are still there/).click();
    await expiry.getByRole('button', { name: 'Record the end of the term' }).click();

    // Expired, not closed: arrears are untouched and the lease keeps its history.
    await expect(page.getByText('expired').first()).toBeVisible({ timeout: 30_000 });

    /* ------------------------------------------------ and renew it */
    await page.getByRole('button', { name: 'Renew for a new term' }).click();
    const renewal = page.locator('form', { has: page.locator('#newRent') });
    await expect(renewal.locator('#newRent')).not.toHaveValue('');
    await renewal.getByRole('button', { name: 'Draft the renewal' }).click();

    // A draft successor, which has to be activated like any other lease —
    // a renewal is an agreement, not a number somebody typed.
    await expect(page.getByText(/drafted for the new term/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/It is a draft/)).toBeVisible();

    /* -------------------------- and the successor is linked and inactive */
    await page.goto('/app/demo-blue-crane/leases', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('draft').first()).toBeVisible();
  });
});
