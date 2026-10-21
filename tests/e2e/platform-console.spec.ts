import { test, expect } from '@playwright/test';
import { clearSupportAccess } from './demo-state';
import { signIn } from './sign-in';

/**
 * The Spike side of the product, driven the way an operator would drive it.
 *
 * The defects behind this spec, all of them found by looking for the screen
 * rather than the function:
 *
 *   * `changePlan`, `setAccountStatus`, `openSupportSession` and
 *     `closeSupportSession` had no screen anywhere, so the commercial operation
 *     of the business needed a database connection;
 *   * suspending a customer did nothing at all — no policy, no permission
 *     function and no guard read `organisations.status`;
 *   * the customer's own page said "You can revoke access at any time" and had
 *     no button, over a domain function that reported success when row-level
 *     security had refused the update.
 *
 * Requires a running preview with demo data:
 *   pnpm host start --dev --reset
 */

const SPIKE = 'support@demo.invalid';
const LANDLORD = 'admin@demo.invalid';
const RESIDENT = 'thandiwe@demo.invalid';

test.describe('Spike platform console', () => {
  test.describe.configure({ timeout: 900_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a plan is changed, a support session opened, and the customer ends it', async ({ page }) => {
    // Unique per run: the demo database is not reset between runs, and a
    // reason reused from a previous run matches two rows in the history.
    const ticket = `SPK-9002-${Date.now().toString().slice(-6)}`;

    // No window open and nothing already approved, whatever an earlier run
    // left behind: this test is about a session that has to be approved.
    await clearSupportAccess('demo-blue-crane');

    await signIn(page, SPIKE);
    await page.goto('/platform', { waitUntil: 'domcontentloaded' });

    // Named, not "the first row". The two demo organisations are created in
    // one transaction and share a timestamp, so before the ordering tie-break
    // this picked a different customer on different runs — and the rest of the
    // test then operated on an organisation the landlord account is not in.
    const customer = page.locator('a[href="/platform/customers/demo-blue-crane"]');
    await expect(customer).toBeVisible();
    await customer.click();
    await page.waitForURL('**/platform/customers/demo-blue-crane');

    /* ------------------------------------------------------------ the plan */
    await expect(page.getByRole('heading', { name: /What they are on/i })).toBeVisible();
    const allowances = page.getByText(/left of|beyond the allowance|no limit on this plan/).first();
    await expect(allowances).toBeVisible();

    const planPanel = page.locator('form', { has: page.locator('select#planKey') });
    await planPanel.locator('select#planKey').selectOption('professional');
    const planTicket = `SPK-9001-${Date.now().toString().slice(-6)}`;
    await planPanel.locator('#plan-reason').fill(`Upgrade agreed on the call, ticket ${planTicket}`);
    await planPanel.getByRole('button', { name: 'Change plan' }).click();
    await expect(page.getByText('Plan changed.')).toBeVisible();

    // The audit trail is the assertion that it actually happened: it is read
    // from `platform.%` audit entries, which are written by the domain
    // function rather than by the screen.
    const trail = page.locator('section', { hasText: 'What Spike has done to this account' });
    await expect(trail.getByText('Plan changed').first()).toBeVisible();
    await expect(trail.getByText(planTicket).first()).toBeVisible();

    /* -------------------------------------------------- a support session */
    const supportPanel = page.locator('form', { has: page.locator('#support-reason') });
    await supportPanel.locator('#support-reason').fill(
      `${ticket}: duplicate receipt on the March statement, approved by the administrator on the call`,
    );
    await supportPanel.locator('#hours').selectOption('2');
    await supportPanel.getByRole('button', { name: 'Open session' }).click();

    const sessions = page.locator('section', { hasText: 'Support access' });
    await expect(sessions.getByText(ticket).first()).toBeVisible();
    // Asked for, not taken: until the customer approves it, the session reads
    // nothing. This used to say "Open" the instant Spike created it.
    await expect(sessions.getByText('Waiting on the customer').first()).toBeVisible();
    await expect(sessions.getByText('reaches nothing yet').first()).toBeVisible();

    /* ------------------------------- and the customer ends it themselves */
    await page.context().clearCookies();
    await signIn(page, LANDLORD);
    await page.goto('/app', { waitUntil: 'domcontentloaded' });
    const org = new URL(page.url()).pathname.startsWith('/app/')
      ? new URL(page.url()).pathname.split('/').slice(0, 3).join('/')
      : (await page.locator('a[href^="/app/"]').first().getAttribute('href'))!;

    await page.goto(`${org}/settings/support-access`, { waitUntil: 'domcontentloaded' });

    // The request is waiting for them, with who asked and why.
    const waiting = page.locator('section', { hasText: 'Waiting for you' });
    await expect(waiting.getByText(ticket).first()).toBeVisible();
    await expect(waiting.getByText(/reaches nothing until you approve it/)).toBeVisible();

    await waiting.getByRole('button', { name: /Let .* in/ }).first().click();

    // The page itself is the confirmation: the row moves out of "waiting for
    // you" and into an open session. Asserting a message beside the button
    // would be asserting something that cannot render — the button is gone.
    await expect(page.getByText(/support session is open/)).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(ticket) })).toContainText('Open');

    // And ending it is one click, which is what this page has always promised.
    await page.getByRole('button', { name: /End .* access now/ }).first().click();
    await expect(page.getByText('No open support sessions')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(ticket) })).toContainText('Ended');
    await expect(page.getByRole('button', { name: /End .* access now/ })).toHaveCount(0);
  });

  test('a window the customer opens lets support in without asking again', async ({ page }) => {
    const ticket = `SPK-9003-${Date.now().toString().slice(-6)}`;

    /* --------------------------------- the customer opens the window first */
    await clearSupportAccess('demo-blue-crane');
    await signIn(page, LANDLORD);
    await page.goto('/app/demo-blue-crane/settings/support-access', {
      waitUntil: 'domcontentloaded',
    });
    const windowForm = page.locator('form', { has: page.locator('#window-reason') });
    await windowForm.locator('#window-reason').fill('Raising a query about the March statement');
    await windowForm.locator('#hours').selectOption('4');
    await windowForm.getByRole('button', { name: 'Open the window' }).click();
    await expect(page.getByText(/Support may let itself in until/)).toBeVisible();

    /* ------------------------------- and Spike's session arrives approved */
    await page.context().clearCookies();
    await signIn(page, SPIKE);
    await page.goto('/platform/customers/demo-blue-crane', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/They have let support in until/)).toBeVisible();

    const supportPanel = page.locator('form', { has: page.locator('#support-reason') });
    await supportPanel.locator('#support-reason').fill(
      `${ticket}: looking at the March statement as agreed`,
    );
    await supportPanel.locator('#hours').selectOption('2');
    await supportPanel.getByRole('button', { name: 'Open session' }).click();

    const sessions = page.locator('section', { hasText: 'Support access' });
    await expect(sessions.getByRole('row', { name: new RegExp(ticket) })).toContainText('Approved');
    await expect(sessions.getByText('approved in advance').first()).toBeVisible();

    /* ------------------------ the customer can shut the window, and does */
    await page.context().clearCookies();
    await signIn(page, LANDLORD);
    await page.goto('/app/demo-blue-crane/settings/support-access', {
      waitUntil: 'domcontentloaded',
    });
    // Scoped to the history table: this page has two tables, and a reference
    // that appears in both matches two rows.
    const history = page.getByRole('table', { name: 'Spike support access history' });
    await expect(history.getByRole('row', { name: new RegExp(ticket) })).toContainText('in advance');
    await page.getByRole('button', { name: 'Close the window' }).click();
    await expect(page.getByText(/Support may let itself in until/)).toHaveCount(0);

    // Closing the window does not silently end the session opened under it:
    // that is a separate record with its own expiry, and the customer ends it
    // themselves so they can see what they are taking away.
    await expect(history.getByRole('row', { name: new RegExp(ticket) })).toContainText('Open');
    await page.getByRole('button', { name: /End .* access now/ }).first().click();
    await expect(page.getByText('No open support sessions')).toBeVisible();
  });

  test('suspending stops the console, and stops nothing else', async ({ page }) => {
    // Starts from an account its staff can sign in to, whatever an earlier run
    // left behind — including this spec's own earlier run, interrupted before
    // it restored the account.
    await clearSupportAccess('demo-blue-crane');
    await signIn(page, SPIKE);
    await page.goto('/platform', { waitUntil: 'domcontentloaded' });
    // The landlord account signed in further down is a member of this one.
    const slug = 'demo-blue-crane';
    await page.goto(`/platform/customers/${slug}`, { waitUntil: 'domcontentloaded' });

    const statusForm = page.locator('form', { has: page.locator('select#status') });
    await statusForm.locator('select#status').selectOption('suspended');
    await statusForm.locator('#status-reason').fill('Non-payment, third notice sent 14 March');
    await statusForm.getByRole('button', { name: 'Change status' }).click();
    await expect(page.getByText('Account status changed.')).toBeVisible();
    await expect(page.getByText(/is suspended, so its staff cannot open the console/)).toBeVisible();

    /* ----------------------------------------- the landlord's staff are out */
    await page.context().clearCookies();
    await signIn(page, LANDLORD);
    await page.goto(`/app/${slug}/leases`, { waitUntil: 'domcontentloaded' });
    // Not a blank page and not a crash: the explanation, at a URL outside the
    // guarded segment so the guard cannot redirect to a page it guards.
    await page.waitForURL(new RegExp(`/account-suspended/${slug}`));
    await expect(page.getByText('Nothing has been deleted.')).toBeVisible();

    /* ------------------------------------- the resident is NOT locked out */
    await page.context().clearCookies();
    await signIn(page, RESIDENT);
    await page.goto('/portal', { waitUntil: 'domcontentloaded' });
    // The portal is reached through a lease rather than through the console
    // guard. A landlord's dispute with Spike is not a reason to take a
    // tenant's statements away from them.
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('suspended');

    /* ------------------------------------------------- and it is reversible */
    await page.context().clearCookies();
    await signIn(page, SPIKE);
    await page.goto(`/platform/customers/${slug}`, { waitUntil: 'domcontentloaded' });
    const restore = page.locator('form', { has: page.locator('select#status') });
    await restore.locator('select#status').selectOption('active');
    await restore.locator('#status-reason').fill('Paid in full, restored on the call');
    await restore.getByRole('button', { name: 'Change status' }).click();
    await expect(page.getByText('Account status changed.')).toBeVisible();

    await page.context().clearCookies();
    await signIn(page, LANDLORD);
    await page.goto(`/app/${slug}`, { waitUntil: 'domcontentloaded' });
    await expect(new URL(page.url()).pathname).toBe(`/app/${slug}`);
  });
});
