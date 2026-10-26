import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearPermissionOverrides } from './demo-state';

/**
 * What a role can do, and one customer being given something extra.
 *
 * The integration suite proves the permission works, is confined to one
 * customer, and always needs a second factor. What the browser has to prove is
 * the half that lives in words: that an operator can look up what a role does
 * without reading SQL, and that the customer is TOLD when Spike widens what
 * their own colleagues may do — because a grant the landlord cannot see is a
 * back door however complete the audit trail is.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';
const SUPPORT = 'support@demo.invalid';
const ORG = 'demo-blue-crane';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('roles and permissions', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearPermissionOverrides(ORG);
  });

  test('the catalogue answers "why can’t our manager do that?"', async ({ page }) => {
    await signIn(page, SUPPORT);
    await page.goto('/platform/permissions', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Roles and permissions' })).toBeVisible();

    const text = await visibleText(page);
    // The answer to the question support is actually asked, both ways round.
    expect(text).toContain('Property manager');
    expect(text).toContain('maintenance.manage');
    expect(text).toContain('finance_approver');
    // The facts that explain the odd entries rather than leaving them to be
    // discovered: the role carrying Spike's permission cannot be handed out.
    expect(text).toContain('not assignable');
    expect(text).toContain('spike_operator');
    // And which permissions a support session could ever exercise, which is a
    // different question with a different answer.
    expect(text).toContain('never');
  });

  test('a grant reaches the customer’s own screen, in their words', async ({ page }) => {
    /* ------------------------------------- Spike grants it ------------- */

    await signIn(page, SUPPORT);
    await page.goto(`/platform/customers/${ORG}`, { waitUntil: 'domcontentloaded' });

    const before = await visibleText(page);
    expect(before).toContain('Extra permissions');
    // The rule that makes it safe to offer, said on the form.
    expect(before).toContain('cannot lock them out');
    expect(before).toContain('None. Every role here does exactly what it does');

    await page.getByLabel('Which of their roles').selectOption('property_manager');
    await page.getByLabel('What to add').selectOption('expense.record');
    await page.getByLabel('Who asked, and why')
      .fill('SPK-8800: their managers buy materials, the owner asked for it');
    await page.getByRole('button', { name: 'Grant it' }).click();

    await expect(page.getByText(/also has/)).toBeVisible({ timeout: 30_000 });
    const after = await visibleText(page);
    expect(after).toContain('Property manager');
    expect(after).toContain('expense.record');
    expect(after).toContain('SPK-8800');
    await page.context().clearCookies();

    /* ------------------------------------- the customer is told -------- */

    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/settings/staff`, { waitUntil: 'domcontentloaded' });

    const customerView = await visibleText(page);
    expect(customerView).toContain('Spike has given');
    expect(customerView).toContain('Property manager');
    expect(customerView).toContain('SPK-8800');
    // Who did it, by name, and the condition attached to it.
    expect(customerView).toContain('at Spike');
    expect(customerView).toMatch(/authenticator set up/);
    await page.context().clearCookies();

    /* ------------------------------------- and it can be taken back ---- */

    await signIn(page, SUPPORT);
    await page.goto(`/platform/customers/${ORG}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Remove' }).first().click();
    await page.getByLabel('Why remove it').fill('SPK-8800 closed, they changed their mind');
    await page.getByRole('button', { name: 'Remove it' }).click();

    await expect(page.getByText(/None. Every role here does exactly/))
      .toBeVisible({ timeout: 30_000 });
    await page.context().clearCookies();

    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/settings/staff`, { waitUntil: 'domcontentloaded' });
    expect(await visibleText(page)).not.toContain('Spike has given');
  });
});
