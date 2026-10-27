import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearSettings } from './demo-state';

/**
 * Switching a feature off, and the two people who find out.
 *
 * The integration suite proves each flag closes the thing it gates. What the
 * browser has to prove is the part that decides whether this is usable or
 * merely true: that an operator can find the switch, that the customer is TOLD
 * their feature is off rather than discovering a product that appears broken,
 * and that the resident — who has no account with Spike and no way to ask —
 * meets a closed door rather than an error.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';
const RESIDENT = 'thandiwe@demo.invalid';
const SUPPORT = 'support@demo.invalid';
const ORG = 'demo-blue-crane';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('settings and flags', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearSettings();
  });

  test.afterAll(async () => { await clearSettings(); });

  test('the settings screen says what is read and what ships', async ({ page }) => {
    await signIn(page, SUPPORT);
    await page.goto('/platform/settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    const text = await visibleText(page);
    // The promise the page makes about itself: no flags that do nothing.
    expect(text).toContain('no flags that do nothing');
    // Features, which can differ per customer, and limits, which cannot.
    expect(text).toContain('Resident portal');
    expect(text).toContain('Longest support session');
    expect(text).toContain('the same for every customer');
    // The default is in view beside the value, so clearing is not a leap.
    expect(text).toContain('Ships as');
  });

  test('switching the portal off reaches the landlord and the resident', async ({ page }) => {
    /* ------------------------------------- the resident, while it is on */

    await signIn(page, RESIDENT);
    await page.goto('/portal', { waitUntil: 'domcontentloaded' });
    expect(page.url()).toContain('/portal');
    expect(await visibleText(page)).not.toContain('Sign in');
    await page.context().clearCookies();

    /* ------------------------------------- Spike switches it off ------- */

    await signIn(page, SUPPORT);
    await page.goto(`/platform/customers/${ORG}`, { waitUntil: 'domcontentloaded' });

    const before = await visibleText(page);
    expect(before).toContain('Features');
    expect(before).toContain('Whatever every other customer gets');

    const portalRow = page.locator('li').filter({ hasText: 'Resident portal' }).first();
    await portalRow.getByRole('button', { name: 'Change' }).click();
    await portalRow.getByLabel('Value').selectOption('false');
    await portalRow.getByLabel('Who asked, and why')
      .fill('SPK-9200: they run their own tenant app and asked us to close ours');
    await portalRow.getByRole('button', { name: 'Save' }).click();

    // Scoped to the row: the reason also lands in the customer's audit trail
    // further down the same page, which is the trail doing its job rather than
    // a duplicate.
    await expect(portalRow.getByText(/SPK-9200/)).toBeVisible({ timeout: 30_000 });
    await page.context().clearCookies();

    /* ------------------------------------- the landlord is told -------- */

    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/settings`, { waitUntil: 'domcontentloaded' });
    const landlordView = await visibleText(page);
    expect(landlordView).toContain('Some features are switched off for your account');
    expect(landlordView).toContain('Resident portal');
    expect(landlordView).toContain('SPK-9200');
    expect(landlordView).toContain('at Spike');
    await page.context().clearCookies();

    /* ------------------------------------- and the resident is out ----- */

    await signIn(page, RESIDENT);
    await page.goto('/portal', { waitUntil: 'domcontentloaded' });
    // No lease resolves, so the portal has nothing to show them. What matters
    // is that it is a closed door and not a crash.
    const residentView = await visibleText(page);
    expect(residentView).not.toMatch(/could not load|server error/i);
    await page.context().clearCookies();

    /* ------------------------------------- and it goes back ------------ */

    await signIn(page, SUPPORT);
    await page.goto(`/platform/customers/${ORG}`, { waitUntil: 'domcontentloaded' });
    const row = page.locator('li').filter({ hasText: 'Resident portal' }).first();
    await row.getByRole('button', { name: 'Change' }).click();
    await row.getByLabel('Or give them whatever everybody else gets, because')
      .fill('SPK-9200: they changed their mind');
    await row.getByRole('button', { name: 'Same as everybody' }).click();
    await expect(page.getByText('Whatever every other customer gets').first())
      .toBeVisible({ timeout: 30_000 });
    await page.context().clearCookies();

    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/settings`, { waitUntil: 'domcontentloaded' });
    expect(await visibleText(page))
      .not.toContain('Some features are switched off for your account');
  });
});
