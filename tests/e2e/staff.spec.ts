import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Adding a colleague, through the interface.
 *
 * Roles and the per-role second-factor requirement have existed since the
 * eighth migration and there was no way to add anybody — so the separation of
 * duties the rest of the product insists on could not be set up by the
 * customer at all.
 *
 * What the browser proves that the integration suite cannot: that an
 * administrator can get from "I have hired somebody" to that person signing in
 * and seeing the console, without anybody touching the database — and that the
 * screen is honest that no email was sent, since no provider is configured.
 *
 * One sign-in for the administrator; the new colleague arrives through the
 * invitation link with no account at all, which is the case that matters.
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

/** A click that lands before hydration does nothing; retrying is the fix. */
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

test.describe('colleagues', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an invited colleague joins and can sign in', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    const stamp = String(Date.now()).slice(-6);
    const email = `prep.${stamp}@demo.invalid`;
    const password = `PreparerPassword${stamp}!`;

    /* ----------------------------------------------- 1. invite somebody */

    await page.goto(`${org}/settings/staff`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Colleagues' })).toBeVisible();

    const intro = await visibleText(page);
    // The thing a pending invitation is not.
    expect(intro).toContain('grants nothing until it is accepted');

    await reveal(page, 'Invite a colleague', page.getByLabel('Their email'));

    // The roles that need a second factor say so where the choice is made.
    // A preparer does not need one; an approver does, and inviting somebody as
    // an approver without knowing that produces a colleague who can sign in
    // and do nothing.
    const approverChoice = page.locator('label').filter({ hasText: 'Finance approver' });
    expect(await approverChoice.innerText()).toContain('Needs an authenticator app');
    const preparerChoice = page.locator('label').filter({ hasText: 'Finance preparer' });
    expect(await preparerChoice.innerText()).not.toContain('Needs an authenticator app');

    await page.getByLabel('Their name').fill(`Prep Arer ${stamp}`);
    await page.getByLabel('Their email').fill(email);
    await page.getByLabel(/Finance preparer/).check();

    const scope = page.getByLabel('What they can reach');
    await expect(scope).toBeVisible();
    await page.getByRole('button', { name: 'Create the invitation' }).click();

    const ready = page.getByText(`Invitation ready for ${email}`);
    const failed = page.getByText('Not invited');
    await expect(ready.or(failed).first()).toBeVisible({ timeout: 30_000 });
    if (await failed.isVisible().catch(() => false)) {
      throw new Error(`inviting was refused: ${await visibleText(page)}`);
    }

    /* ---------------------------------- 2. the screen does not claim an email */

    const issued = await visibleText(page);
    // No provider is configured, so claiming "invitation sent" would be a lie
    // the recipient discovers by never receiving it.
    expect(issued).toContain('No email has been sent');
    expect(issued).toContain('shown once');
    expect(issued).toContain('neither you nor Spike can recover it');

    const link = await page.locator('p.font-mono').first().innerText();
    expect(link).toContain('/join/');

    /* ---------------------------- 3. still not a member, and the list says so */

    await page.goto(`${org}/settings/staff`, { waitUntil: 'domcontentloaded' });
    const pending = await visibleText(page);
    expect(pending).toContain('waiting to be accepted');
    expect(pending).toContain('Nobody on this list can sign in yet');
    expect(pending).toContain(email);

    /* ------------------------------------- 4. the colleague accepts the link */

    const context = await page.context().browser()!.newContext();
    const joiner = await context.newPage();
    await joiner.goto(link.trim(), { waitUntil: 'domcontentloaded' });

    const invitationPage = await visibleText(joiner);
    expect(invitationPage).toContain('Join');
    expect(invitationPage).toContain('finance_preparer');
    expect(invitationPage).toContain(email);

    await joiner.getByLabel('Choose a password').fill(password);
    await joiner.getByLabel('The same password again').fill(password);
    await joiner.getByRole('button', { name: /^Join / }).click();

    // Joining signs them in, because a brand new account has no second factor
    // to get past.
    await joiner.waitForURL(/\/app\//, { timeout: 30_000 });
    const console_ = await visibleText(joiner);
    expect(console_).toContain('Reconciliation');

    /* --------------------------------- 5. and the link cannot be used again */

    await joiner.goto(link.trim(), { waitUntil: 'domcontentloaded' });
    expect(await visibleText(joiner)).toContain('This invitation is not valid');
    await context.close();

    /* ------------------------------------- 6. now a member, not an invitation */

    await page.goto(`${org}/settings/staff`, { waitUntil: 'domcontentloaded' });
    const after = await visibleText(page);
    expect(after).toContain(`Prep Arer ${stamp}`);
    expect(after).toContain('accepted');

    const member = page.locator('li').filter({ hasText: `Prep Arer ${stamp}` }).first();
    expect(await member.innerText()).toContain('finance_preparer');

    /* ------------------------------ 7. the administrator cannot raise their own */

    const self = page.locator('li').filter({ hasText: '— you' }).first();
    const selfText = await self.innerText();
    expect(selfText).toContain('This is you');
    expect(selfText).toContain('compromised organisation');
    await expect(self.getByRole('button', { name: 'Change roles' })).toHaveCount(0);
  });
});
