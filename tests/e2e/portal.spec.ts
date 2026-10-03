import { test, expect } from '@playwright/test';

/**
 * Resident portal browser checks.
 *
 * Requires a running server with seeded demo data:
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @propertyos/web start
 */
test.describe('resident portal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill('thandiwe@demo.invalid');
    await page.getByLabel('Password').fill(process.env.SEED_PASSWORD ?? 'DemoPassword123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/portal\//);
  });

  test('shows the amount due from posted records', async ({ page }) => {
    await expect(page.getByText('Amount due')).toBeVisible();
    await expect(page.getByText('R1,850.00').first()).toBeVisible();
  });

  test('states that uploaded evidence has not changed the balance', async ({ page }) => {
    await expect(page.getByText('Awaiting verification')).toBeVisible();
    await expect(
      page.getByText(/balance above will only change once the payment is confirmed/i),
    ).toBeVisible();
  });

  test('has no horizontal scrolling on a small screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });

  test('is keyboard navigable to the primary action', async ({ page }) => {
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeFocused();
  });
});

test.describe('operator console', () => {
  test('denies a resident the operator console', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill('thandiwe@demo.invalid');
    await page.getByLabel('Password').fill(process.env.SEED_PASSWORD ?? 'DemoPassword123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/portal\//);

    await page.goto('/app/demo-blue-crane');
    // Redirected away: a resident is not a member of the organisation.
    await expect(page).not.toHaveURL(/\/app\/demo-blue-crane$/);
  });
});
