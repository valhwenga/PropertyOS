import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * A landlord asking for an account, and Spike answering.
 *
 * The integration suite proves the queue and the provisioning behind it. What
 * only the browser can prove is the part that matters to somebody who has
 * never heard of us: that the form is reachable with no session at all, that
 * submitting it says plainly a person will read it, and that the operator's
 * approval produces the same single-use invitation link the provisioning
 * screen does.
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

test.describe('asking for an account', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a stranger asks, an operator approves, and the account exists', async ({ page }) => {
    const stamp = String(Date.now()).slice(-6);
    const business = `Vaal Lettings ${stamp}`;
    const email = `owner.${stamp}@vaal.invalid`;

    /* ------------------------------------------- 1. with no session at all */

    await page.goto('/request-access', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Ask for an account' })).toBeVisible();
    // Not a sign-up, and the page says so before anything is typed.
    expect(await visibleText(page)).toContain('Someone reads every request');

    await page.getByLabel('What your business is called').fill(business);
    await page.getByLabel('Who will administer it').fill(`Owner ${stamp}`);
    await page.getByLabel('Their email address').fill(email);
    await page.getByLabel('How many units you manage').fill('18');
    await page.getByRole('button', { name: 'Send the request' }).click();

    await expect(page.getByText('we have your request')).toBeVisible({ timeout: 30_000 });
    const confirmation = await visibleText(page);
    expect(confirmation).toContain('no account exists yet');

    /* --------------------------------------------- 2. the operator reads it */

    await signIn(page, SUPPORT);
    await page.goto('/platform/signups', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Requests for an account' })).toBeVisible();

    const queue = await visibleText(page);
    expect(queue).toContain(business);
    expect(queue).toContain('says they manage 18 units');
    // The operator is told what they are looking at: an unverified claim.
    expect(queue).toContain('None of this is verified');

    /* ------------------------------------------------- 3. and approves it */

    const slug = `vaal-${stamp}`;
    const card = page.locator('form').filter({ has: page.locator(`input[value="${business}"]`) });
    await card.getByLabel('Address').fill(slug);
    await card.getByLabel('Registered legal name').fill(`${business} (Pty) Ltd`);
    await card.getByRole('button', { name: 'Approve and set up' }).click();

    await expect(page.getByText(`${slug} is set up`)).toBeVisible({ timeout: 60_000 });
    const approved = await visibleText(page);
    // The same thing the provisioning screen says: nothing was emailed, and
    // the link is shown once.
    expect(approved).toContain('No email has been sent');
    expect(approved).toContain(`/join/`);

    /* ------------------------------- 4. and the request cannot be done twice */

    await page.reload({ waitUntil: 'domcontentloaded' });
    const afterwards = await visibleText(page);
    expect(afterwards).toContain('set up');
    // No longer awaiting a decision: the approval form for it is gone.
    await expect(
      page.locator(`input[value="${business}"]`),
    ).toHaveCount(0);
  });
});
