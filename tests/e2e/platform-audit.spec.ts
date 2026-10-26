import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearSupportAccess } from './demo-state';

/**
 * Reviewing Spike's own conduct, through the interface.
 *
 * The integration suite proves the policy boundary and the filters. What the
 * browser has to prove is that the screen answers the question somebody opens
 * it with — "has anybody been inside a customer's records, and did the
 * customer agree to it" — and that the file it produces says what it covers,
 * because a row torn out of context is how an audit extract misleads.
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

test.describe('what Spike has done', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an action taken inside a customer’s records shows up for review', async ({ page }) => {
    await clearSupportAccess(ORG);

    /* -------- the customer allows a change, and support makes one -------- */

    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/settings/support-access`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('What this is for').fill('Ticket SPK-4410: re-file the leak');
    await page.getByLabel('Maintenance', { exact: false }).first().check();
    await page.getByRole('button', { name: 'Open the window' }).click();
    await expect(page.getByRole('button', { name: 'Close the window' }))
      .toBeVisible({ timeout: 30_000 });
    await page.context().clearCookies();

    await signIn(page, SUPPORT);
    await page.goto(`/platform/customers/${ORG}`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Reason, including the ticket reference')
      .fill('SPK-4410: re-filing the leak ticket, for the audit view');
    await page.getByLabel('maintenance', { exact: true }).check();
    await page.getByRole('button', { name: 'Open session' }).click();
    await expect(page.getByRole('link', { name: /Open their console/ }))
      .toBeVisible({ timeout: 30_000 });

    await page.goto(`/app/${ORG}/maintenance/new`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Which unit?').selectOption({ index: 1 });
    await page.getByLabel('What kind of problem is it?').selectOption('plumbing');
    await page.getByLabel('What is the problem?').fill(
      'Logged by Spike support for the audit view: kitchen tap dripping, SPK-4410.',
    );
    await page.getByRole('button', { name: 'Log the request' }).click();
    await expect(page.getByText('Logged')).toBeVisible({ timeout: 60_000 });

    /* ---------------------------- and the review finds it ---------------- */

    await page.goto('/platform/audit', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'What Spike has done' })).toBeVisible();

    const everything = await visibleText(page);
    // The promise the page makes about itself.
    // Matched loosely on purpose: the apostrophe in the rendered copy is a
    // plain one and asserting the typographic form fails for no good reason.
    expect(everything).toMatch(/Their ordinary work never appears here/);
    expect(everything).toContain('Changes inside customer records');

    // Narrow to the thing a reviewer actually came for.
    await page.goto('/platform/audit?kind=support', { waitUntil: 'domcontentloaded' });
    const inside = await visibleText(page);
    expect(inside).toContain('Spike Support');
    expect(inside).toContain('Blue Crane');
    expect(inside).toContain('inside their records');
    // The three things that make it legitimate travel with the row.
    expect(inside).toContain('allowed: Maintenance');
    expect(inside).toContain('approved by');

    /* ---------------------------- and the file says what it covers ------- */

    const download = await page.request.get('/platform/audit/export.csv?kind=support');
    expect(download.status()).toBe(200);
    expect(download.headers()['content-type']).toContain('text/csv');
    const csv = await download.text();
    expect(csv).toContain('what Spike has done');
    expect(csv).toContain('changes inside customer records, under authorised sessions');
    expect(csv).toMatch(/A customer.s ordinary work does not appear/);
    expect(csv).toContain('Spike Support');
    // The filter is in the file, so a row cannot be read out of context later.
    expect(csv).toContain('Rows matching the filters');
  });

  test('the landlord’s own work is not in Spike’s review screen', async ({ page }) => {
    // The landlord does something ordinary, under nobody's session.
    await signIn(page, ADMIN);
    await page.goto(`/app/${ORG}/residents/new`, { waitUntil: 'domcontentloaded' });
    const stamp = String(Date.now()).slice(-6);
    await page.getByLabel('First name').fill(`Ayanda${stamp}`);
    await page.getByLabel('Last name').fill('Private');
    await page.getByRole('button', { name: /Save|Add|Create/ }).first().click();
    await page.waitForLoadState('domcontentloaded');
    await page.context().clearCookies();

    await signIn(page, SUPPORT);
    const file = await page.request.get('/platform/audit/export.csv');
    const csv = await file.text();
    // In the same table, in an account Spike can name, and none of Spike's
    // business.
    expect(csv).not.toContain(`Ayanda${stamp}`);
  });
});
