import { test, expect } from '@playwright/test';

/**
 * Whether a notice actually reaches the person it is about.
 *
 * The integration suite proves the dispatch rules and the refusals. What the
 * browser has to prove is the whole chain, through the real worker: a resident
 * does something in the portal, the event goes to the outbox, the worker picks
 * it up, and the resident finds a readable message in the inbox the product
 * actually shows them — with the reference filled in, not `{{reference}}`, and
 * a link that goes somewhere.
 *
 * None of this worked until 0087. The notice was written with no recipient, so
 * no inbox could show it, and recorded as sent.
 *
 * Requires a running preview with demo data and its worker:
 *   ./scripts/host.sh start --dev
 */

const RESIDENT = 'thandiwe@demo.invalid';
const PASSWORD = process.env.SEED_PASSWORD ?? 'DemoPassword123!';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('a notice reaches the resident', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: one resident, one inbox');
  });

  test('a request raised in the portal comes back as a readable notice', async ({ page }) => {
    await page.goto('/sign-in', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email address').fill(RESIDENT);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/portal\//, { timeout: 60_000 });
    const portal = new URL(page.url()).pathname.split('/').slice(0, 3).join('/');

    /* ------------------------------------------- 1. the resident asks for help */

    await page.goto(`${portal}/requests/new`, { waitUntil: 'domcontentloaded' });
    const detail = `The kitchen tap drips. Logged by a test at ${Date.now()}.`;
    await page.getByLabel('What kind of problem is it?').selectOption('plumbing');
    await page.getByLabel('Describe the problem').fill(detail);
    await page.getByRole('button', { name: 'Send request' }).click();

    // The form answers in place with the reference it was given, so that is
    // where it is read from. The first draft of this pattern-matched the whole
    // page for something reference-shaped, picked up the LEASE reference in
    // the header, and then asserted that the inbox mentioned the lease — a
    // test that could only fail, and that said nothing about why.
    await expect(page.getByText('Request logged')).toBeVisible({ timeout: 60_000 });
    const reference = (await visibleText(page))
      .match(/Your reference is ([A-Z]{2,4}-\d{4,})/)?.[1];
    expect(reference, 'the request should be given a reference').toBeTruthy();

    /* ------------------- 2. the worker turns the event into a notice, in time */

    let inbox = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.goto('/account/notifications', { waitUntil: 'domcontentloaded' });
      inbox = await visibleText(page);
      if (inbox.includes(reference!)) break;
      await page.waitForTimeout(3_000);
    }

    /* ------------------------------- 3. and it is a message, not a template */

    expect(inbox).toContain(reference!);
    expect(inbox).not.toContain('{{');
    expect(inbox).toContain('Maintenance request');

    // The link on it goes to the request itself. A notice that tells somebody
    // something happened and gives them nowhere to look is half a message.
    await page.getByRole('link', { name: 'Open →' }).first().click();
    await page.waitForURL(/\/requests\/[0-9a-f-]{36}/, { timeout: 30_000 });
    // Waited for rather than read: in dev the tenancy shell renders
    // "Loading your tenancy" first, and reading the text at that moment
    // asserts against the spinner.
    await expect(page.getByText(reference!).first()).toBeVisible({ timeout: 30_000 });
  });
});
