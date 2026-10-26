import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearSupportAccess } from './demo-state';

/**
 * Letting Spike change something, through the interface.
 *
 * The integration suite proves the scopes, the policies and the refusals.
 * What only the browser proves is the part the customer is actually deciding
 * on: that the screen says plainly what they are agreeing to, that unticked
 * means look-and-change-nothing, and that what they allowed is afterwards
 * readable on their own screen rather than only in an audit table.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';
const ORG = 'demo-blue-crane';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('letting support change something', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearSupportAccess(ORG);
  });

  test('the customer chooses what support may change, in their own words', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/settings/support-access`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Spike support access' })).toBeVisible();

    const before = await visibleText(page);
    // The scopes are offered in the landlord's language, not as permission keys.
    expect(before).toContain('Maintenance');
    expect(before).toContain('Property and lease records');
    expect(before).toContain('Cannot end a tenancy');
    // And the floor is stated: what no tick can ever allow.
    expect(before).toContain('can never move money');
    expect(before).toContain('Leave these unticked');

    /* ----------------------------------- a window that allows maintenance */

    await page.getByLabel('What this is for').fill('Ticket SPK-2208: leak on the wrong unit');
    await page.getByLabel('Maintenance', { exact: false }).first().check();
    await page.getByRole('button', { name: 'Open the window' }).click();

    await expect(page.getByText(/Support can let themselves in|open until|Close the window/i))
      .toBeVisible({ timeout: 30_000 });

    const after = await visibleText(page);
    // What they just allowed is readable back to them.
    expect(after).toContain('Maintenance');
  });

  test('an unticked window still means look and change nothing', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/settings/support-access`, { waitUntil: 'domcontentloaded' });

    await page.getByLabel('What this is for').fill('Ticket SPK-2209: just have a look please');
    // Deliberately ticking nothing: the default must be the old behaviour.
    await page.getByRole('button', { name: 'Open the window' }).click();

    await expect(page.getByRole('button', { name: 'Close the window' }))
      .toBeVisible({ timeout: 30_000 });

    const text = await visibleText(page);
    expect(text).toContain('read');
    // No scope name should appear as something granted on this window.
    expect(text).not.toContain('allowed changes to: Maintenance');
  });
});
