import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Spike's own staff, through the interface.
 *
 * The integration suite proves the permissions and the policies. What only
 * the browser proves is that an administrator can get from "a colleague
 * joined" to that colleague holding a named role — and that the console says
 * what each role carries, because an operator who cannot see that cannot tell
 * a refusal from a fault.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const SUPPORT = 'support@demo.invalid';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('platform operators', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an administrator invites a colleague and scopes what they may do', async ({ page }) => {
    await signIn(page, SUPPORT);
    await page.goto('/platform/operators', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Operators' })).toBeVisible();

    const opening = await visibleText(page);
    // The console states what being an operator is NOT, on the page where
    // somebody is about to be made one.
    expect(opening).toContain('grants no access to any customer');
    // And what each role carries, by permission key, so a scoped role is a
    // readable decision rather than a label.
    expect(opening).toContain('platform.operators.manage');
    expect(opening).toContain('Read-only');

    /* ------------------------------------------------- 1. invite a colleague */

    const stamp = String(Date.now()).slice(-6);
    const email = `colleague.${stamp}@spike.invalid`;

    await page.getByLabel('Their full name').fill(`Thabo Molefe ${stamp}`);
    await page.getByLabel('Their email address').fill(email);
    // Support only: deliberately not an administrator.
    await page.getByRole('button', { name: 'Invite them' }).click();

    await expect(page.getByText('Invitation ready')).toBeVisible({ timeout: 30_000 });
    const invited = await visibleText(page);
    expect(invited).toContain('No email has been sent');
    expect(invited).toContain('/join-operator/');
    // The second factor is named as the condition, not discovered later.
    expect(invited).toContain('enrol an authenticator');

    const link = await page.locator('p.font-mono').first().textContent();
    const token = (link ?? '').trim().split('/join-operator/')[1];
    expect(token).toBeTruthy();

    /* ------------------------------- 2. the colleague accepts, in a new context */

    const fresh = await page.context().browser()!.newContext();
    const theirPage = await fresh.newPage();
    await theirPage.goto(`${page.url().split('/platform')[0]}/join-operator/${token}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(
      theirPage.getByRole('heading', { name: /invited to the platform team/i }),
    ).toBeVisible();
    const theirView = await visibleText(theirPage);
    expect(theirView).toContain('Support');
    expect(theirView).toContain(email);

    const password = `ColleaguePassword${stamp}!`;
    await theirPage.getByLabel('Choose a password').fill(password);
    await theirPage.getByLabel('Confirm it').fill(password);
    await theirPage.getByRole('button', { name: 'Accept and continue' }).click();

    // Sent to enrolment rather than into the console: a single-factor session
    // is refused there, which would read as a broken invitation.
    await theirPage.waitForURL(/\/account\/security/, { timeout: 60_000 });
    await fresh.close();

    /* ------------------------------- 3. and now they appear, with that role */

    await page.goto('/platform/operators', { waitUntil: 'domcontentloaded' });
    const afterwards = await visibleText(page);
    expect(afterwards).toContain(`Thabo Molefe ${stamp}`);
    expect(afterwards).toContain(email);
    // Enrolment is theirs to do, and until they do the console stays shut —
    // said on the row rather than left for them to discover.
    expect(afterwards).toContain('the console stays closed to them');
  });

  test('the console cannot be left without an administrator', async ({ page }) => {
    await signIn(page, SUPPORT);
    await page.goto('/platform/operators', { waitUntil: 'domcontentloaded' });

    // The viewer's own row offers no way to remove their own access: it is the
    // one change that cannot be undone from inside the console.
    // Anchored on the row's own hook: a looser locator matches an ancestor
    // that contains every other operator's buttons too.
    const ownRow = page.locator('[data-operator="support@demo.invalid"]');
    await expect(ownRow.getByRole('button', { name: 'Remove console access' }))
      .toHaveCount(0);

    // Dropping their own administrator role is refused by the database, and
    // the refusal lands on the row it is about.
    const form = ownRow.locator('form').first();
    await form.getByLabel('Platform administrator').uncheck();
    await form.getByRole('button', { name: 'Save roles' }).click();

    await expect(page.getByText(/last platform administrator|at least one role/i))
      .toBeVisible({ timeout: 30_000 });
  });
});
