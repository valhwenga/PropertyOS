import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearSupportAccess } from './demo-state';

/**
 * Spike working inside a customer's console, on a session they approved.
 *
 * Everything under this was already true in the database: the scopes, the
 * policies, the attribution. What was missing was the only part a person
 * experiences — `requireOperator` resolved organisations from membership, so
 * an operator could hold a live approved write session and still be bounced
 * out of the console it applies to.
 *
 * What the browser has to prove, and the integration suite cannot:
 *   * the customer's approval is what opens the door, and nothing else;
 *   * every screen says whose records these are and what may be changed;
 *   * the menu offers what the session allows and not the rest;
 *   * ending the session shuts the door on the next click.
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

test.describe('support inside the customer console', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearSupportAccess(ORG);
  });

  test('no session, no console: the door is the approval', async ({ page }) => {
    await signIn(page, SUPPORT);
    // A platform operator with nothing approved is not a member of anything,
    // and the console says so by sending them to their own list.
    await page.goto(`/app/${ORG}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/app(\?|$)/, { timeout: 30_000 });
    expect(await visibleText(page)).not.toContain('Blue Crane');
  });

  test('an approved session opens the console, says so, and ends', async ({ page }) => {
    /* ------------------------------- 1. the customer allows maintenance */

    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/settings/support-access`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('What this is for').fill('Ticket SPK-3301: please re-file the leak');
    await page.getByLabel('Maintenance', { exact: false }).first().check();
    await page.getByRole('button', { name: 'Open the window' }).click();
    await expect(page.getByRole('button', { name: 'Close the window' }))
      .toBeVisible({ timeout: 30_000 });
    // Switching user: `/sign-out` is POST only, and the session is a signed
    // cookie with nothing server-side holding it, so clearing cookies is the
    // sign-out — the same approach mfa.spec.ts takes.
    await page.context().clearCookies();

    /* ------------------------------- 2. the operator opens a session for it */

    await signIn(page, SUPPORT);
    await page.goto(`/platform/customers/${ORG}`, { waitUntil: 'domcontentloaded' });
    const windowNote = await visibleText(page);
    expect(windowNote).toContain('They allowed changes to: maintenance');

    await page.getByLabel('Reason, including the ticket reference')
      .fill('SPK-3301: re-filing the leak ticket the customer asked about');
    await page.getByLabel('maintenance', { exact: true }).check();
    await page.getByRole('button', { name: 'Open session' }).click();
    await expect(page.getByRole('link', { name: /Open their console/ }))
      .toBeVisible({ timeout: 30_000 });

    /* ------------------------------- 3. and works inside their console */

    await page.getByRole('link', { name: /Open their console/ }).click();
    await page.waitForURL(new RegExp(`/app/${ORG}`), { timeout: 30_000 });

    const inside = await visibleText(page);
    // Whose records these are, what may change, and that they can end it.
    expect(inside).toContain('on a support session');
    expect(inside).toContain('Maintenance');
    expect(inside).toContain('never their bank details');
    expect(inside).toContain('can end it at any moment');

    // The banner is on every screen, not only the one they landed on.
    await page.goto(`/app/${ORG}/maintenance`, { waitUntil: 'domcontentloaded' });
    expect(await visibleText(page)).toContain('on a support session');

    // The menu offers maintenance, and not what the session does not carry.
    const nav = await page.locator('nav').first().innerText();
    expect(nav).toMatch(/Maintenance/i);
    expect(nav).not.toMatch(/Bank|Deposits/i);

    /* ------------------- and actually does the work, which is the point */

    await page.goto(`/app/${ORG}/maintenance/new`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Which unit?').selectOption({ index: 1 });
    await page.getByLabel('What kind of problem is it?').selectOption('plumbing');
    await page.getByLabel('What is the problem?').fill(
      'Raised by Spike support on the customer’s behalf: kitchen leak, re-filed from SPK-3301.',
    );
    await page.getByRole('button', { name: 'Log the request' }).click();
    // The form stays put and offers the new request, so the assertion belongs
    // on the request itself rather than on the panel saying it was logged.
    await expect(page.getByText('Logged')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: 'Open the request' }).click();
    await page.waitForURL(/\/maintenance\/[0-9a-f-]{36}/, { timeout: 60_000 });

    const ticket = await visibleText(page);
    expect(ticket).toContain('kitchen leak');
    // Still unmistakably somebody else's account, on the screen where the
    // change was just made.
    expect(ticket).toContain('on a support session');

    /* ------------------------------- 4. until the customer ends it */

    await page.context().clearCookies();
    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/settings/support-access`, { waitUntil: 'domcontentloaded' });
    // What Spike did is on the customer's own screen, counted against the
    // session rather than buried in a table only Spike can read.
    const seenByCustomer = await visibleText(page);
    expect(seenByCustomer).toContain('can also change');
    await page.getByRole('button', { name: /End .* access now/ }).first().click();
    await expect(page.getByText(/No open support sessions|Waiting for you/))
      .toBeVisible({ timeout: 30_000 });
    await page.context().clearCookies();

    await signIn(page, SUPPORT);
    await page.goto(`/app/${ORG}`, { waitUntil: 'domcontentloaded' });
    // Shut on the next click, not at the next expiry.
    await page.waitForURL(/\/app(\?|$)/, { timeout: 30_000 });
  });
});
