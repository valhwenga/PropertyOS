import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Setting up a new customer, through the interface.
 *
 * `createOrganisationWithOwner` has existed since the first migration with no
 * screen, so every organisation in existence was created by the seed or by a
 * test: a new customer could not be set up in the product at all.
 *
 * What the browser proves that the integration suite cannot: that a Spike
 * operator can get from "they signed up" to that customer's own administrator
 * working in their own organisation, and that the operator is never a member
 * of what they created — the screen says so, and the operator's own customer
 * list cannot see inside it until somebody accepts.
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

test.describe('customer provisioning', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a Spike operator sets up a customer they are not a member of', async ({ page }) => {
    await signIn(page, SUPPORT);
    await page.goto('/platform', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Customer organisations' })).toBeVisible();

    const stamp = String(Date.now()).slice(-6);
    const slug = `karoo-${stamp}`;
    const email = `lerato.${stamp}@karoo.invalid`;
    const password = `FounderPassword${stamp}!`;

    /* --------------------------------------------------- 1. set one up */

    await page.getByRole('link', { name: 'Set up a customer' }).click();
    await page.waitForURL(/\/platform\/new/, { timeout: 30_000 });

    const form = await visibleText(page);
    // What Spike does not get, said before anything is created.
    expect(form).toContain('You will not be a member of it');

    await page.getByLabel('Trading name').fill(`Karoo Rentals ${stamp}`);
    await page.getByLabel('Address').fill(slug);
    await page.getByLabel('Legal entity').fill(`Karoo Rentals ${stamp} (Pty) Ltd`);
    await page.getByLabel('Plan').selectOption('portfolio');
    await page.getByLabel('Their administrator').fill(`Lerato Mahlangu ${stamp}`);
    await page.getByLabel('Their email').fill(email);
    await page.getByLabel('Why this account exists')
      .fill('Signed up by sales; two blocks in Graaff-Reinet.');
    await page.getByRole('button', { name: 'Set up the customer' }).click();

    const done = page.getByText(`${slug} is set up, with nobody in it`);
    const failed = page.getByText('Not provisioned');
    await expect(done.or(failed).first()).toBeVisible({ timeout: 30_000 });
    if (await failed.isVisible().catch(() => false)) {
      throw new Error(`provisioning was refused: ${await visibleText(page)}`);
    }

    const issued = await visibleText(page);
    // No Spike account inside customer data, and nothing to remember to remove.
    expect(issued).toContain('there never was one');
    expect(issued).toContain('No email has been sent');
    expect(issued).toContain('shown once');

    const link = (await page.locator('p.font-mono').first().innerText()).trim();
    expect(link).toContain('/join/');

    /* ------------------------------ 2. the operator cannot see inside it */

    await page.goto('/platform', { waitUntil: 'domcontentloaded' });
    const platform = await visibleText(page);
    expect(platform).toContain('Waiting to be taken up');
    expect(platform).toContain(slug);
    expect(platform).toContain('waiting to be accepted');
    // It is listed because nothing else can see it at all — which is the point
    // of the section existing.
    expect(platform).toContain('invisible to everybody');

    /* --------------------------------- 3. the founder takes it up */

    const context = await page.context().browser()!.newContext();
    const founder = await context.newPage();
    await founder.goto(link, { waitUntil: 'domcontentloaded' });

    const invitation = await visibleText(founder);
    expect(invitation).toContain(`Karoo Rentals ${stamp}`);
    expect(invitation).toContain('org_admin');
    expect(invitation).toContain(email);

    await founder.getByLabel('Choose a password').fill(password);
    await founder.getByLabel('The same password again').fill(password);
    await founder.getByRole('button', { name: /^Join / }).click();
    await founder.waitForURL(new RegExp(`/app/${slug}`), { timeout: 30_000 });

    const console_ = await visibleText(founder);
    expect(console_).toContain('Portfolio');
    expect(console_).toContain('Reconciliation');

    /* ------------- 4. and the state they land in is explained, not mysterious */

    await founder.goto(`/app/${slug}/settings/staff`, { waitUntil: 'domcontentloaded' });
    const staff = await visibleText(founder);

    // They hold org_admin, and at one factor the permission is withheld — the
    // role requires a second factor. That is correct, and a founding
    // administrator who cannot manage their own organisation deserves to be
    // told why rather than reading "you need a permission you already have".
    expect(staff).toContain('this session has only a password');
    expect(staff).toContain('Set up an authenticator');
    // Nothing from Spike is reachable from inside the customer either way.
    expect(staff).not.toContain('support@demo.invalid');
    await context.close();

    /* ------------------------------- 5. and it leaves the waiting list */

    await page.goto('/platform', { waitUntil: 'domcontentloaded' });
    const after = await visibleText(page);
    expect(after).toContain(slug);
    // Now an ordinary customer with one member, no longer waiting.
    const waiting = page.locator('section').filter({ hasText: 'Waiting to be taken up' });
    if (await waiting.count() > 0) {
      expect(await waiting.innerText()).not.toContain(slug);
    }
  });
});
