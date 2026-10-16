import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * The grouped sidebar, and what a colleague with one role actually sees.
 *
 * Sixteen equal entries down the side was a list to read rather than a shape
 * to learn, and every one of them was shown to every member — so a property
 * manager was offered Billing, Deposits, Reports, Import and Settings, all of
 * which answer "you do not have access to this" after the click. A menu that
 * is wrong eleven times out of sixteen teaches a new colleague that the
 * product is mostly closed to them.
 *
 * What the browser proves that the suites beside it cannot: that the group
 * headings reach the page, that the sidebar a real signed-in member is served
 * matches the one the resolver computes, and — the part that matters — that
 * hiding a section changed nothing about reaching it. The last case types the
 * URL of a page that is no longer on their menu and expects the refusal that
 * was always there.
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

async function reveal(
  page: import('@playwright/test').Page,
  button: string,
  field: import('@playwright/test').Locator,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByRole('button', { name: button }).first().click();
    if (await field.isVisible({ timeout: 4_000 }).catch(() => false)) return;
  }
  throw new Error(`"${button}" never revealed its form`);
}

/** The section links in the sidebar, in the order they are rendered. */
async function sections(page: import('@playwright/test').Page): Promise<string[]> {
  return page.getByRole('navigation', { name: 'Sections' })
    .getByRole('link').allInnerTexts();
}

test.describe('grouped navigation', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an administrator sees four areas; a property manager sees two', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();
    await page.goto(`${org}/leases`, { waitUntil: 'domcontentloaded' });

    /* ------------------------------------------- 1. the areas are on the page */

    const nav = page.getByRole('navigation', { name: 'Sections' });
    for (const area of ['Portfolio', 'Finance', 'Operations', 'Administration']) {
      await expect(nav.getByRole('heading', { name: area, exact: true })).toBeVisible();
    }

    const all = await sections(page);
    expect(all[0]).toBe('Overview');
    // An administrator holds everything, so nothing is withheld from them.
    for (const section of ['Properties', 'Billing', 'Approvals', 'Inspections', 'Settings']) {
      expect(all, `${section} missing from an administrator's sidebar`).toContain(section);
    }
    // And the current page is still marked, which the grouping must not lose.
    await expect(nav.getByRole('link', { name: 'Leases' })).toHaveAttribute('aria-current', 'page');

    /* ----------------------------------- 2. invite a colleague with one role */

    const stamp = String(Date.now()).slice(-6);
    const email = `pm.${stamp}@demo.invalid`;
    const password = `ManagerPassword${stamp}!`;

    await page.goto(`${org}/settings/staff`, { waitUntil: 'domcontentloaded' });
    await reveal(page, 'Invite a colleague', page.getByLabel('Their email'));
    await page.getByLabel('Their name').fill(`Pee Em ${stamp}`);
    await page.getByLabel('Their email').fill(email);
    await page.getByLabel(/Property manager/).check();
    await page.getByRole('button', { name: 'Create the invitation' }).click();
    await expect(page.getByText(`Invitation ready for ${email}`)).toBeVisible({ timeout: 30_000 });
    const link = (await page.locator('p.font-mono').first().innerText()).trim();

    const context = await page.context().browser()!.newContext();
    const manager = await context.newPage();
    await manager.goto(link, { waitUntil: 'domcontentloaded' });
    await manager.getByLabel('Choose a password').fill(password);
    await manager.getByLabel('The same password again').fill(password);
    await manager.getByRole('button', { name: /^Join / }).click();
    await manager.waitForURL(/\/app\//, { timeout: 30_000 });

    /* ------------------------------------- 3. their sidebar is their own work */

    const theirs = await sections(manager);
    const theirNav = manager.getByRole('navigation', { name: 'Sections' });
    await expect(theirNav.getByRole('heading', { name: 'Portfolio', exact: true })).toBeVisible();
    await expect(theirNav.getByRole('heading', { name: 'Operations', exact: true })).toBeVisible();
    // Nothing in Finance or Administration is theirs, so neither heading is
    // rendered at all — an empty group is worse than no group.
    await expect(theirNav.getByRole('heading', { name: 'Finance', exact: true }))
      .toHaveCount(0);
    await expect(theirNav.getByRole('heading', { name: 'Administration', exact: true }))
      .toHaveCount(0);

    expect(theirs).toContain('Maintenance');
    expect(theirs).toContain('Inspections');
    for (const absent of ['Billing', 'Deposits', 'Expenses', 'Approvals', 'Reports', 'Settings']) {
      expect(theirs, `${absent} should not be offered`).not.toContain(absent);
    }
    // property_manager does not require a second factor, so nothing is being
    // held back from them and no notice should claim otherwise.
    expect(await visibleText(manager)).not.toContain('once you set up an authenticator');

    /* ------------------- 4. and the hidden page refuses them just as it did */

    await manager.goto(`${org}/settings/audit`, { waitUntil: 'domcontentloaded' });
    const audit = await visibleText(manager);
    expect(audit).toMatch(/do not have access|permission/i);
    // The refusal is the control. The menu is a courtesy, and it must never be
    // mistaken for one: nothing from the trail is on the page.
    expect(audit).not.toContain('before_state');

    await context.close();
  });
});
