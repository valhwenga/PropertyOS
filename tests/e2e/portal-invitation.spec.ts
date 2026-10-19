import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Inviting a resident to the portal, through the interface.
 *
 * `prepareInvitation`, `issueInvitation`, `acceptInvitation` and
 * `revokePortalAccess` have existed since §8 and not one of them had a screen.
 * So the resident portal could not be reached by any resident a customer
 * actually had: an operator could not issue an invitation, and no page existed
 * to redeem one.
 *
 * What the browser proves that the integration suite cannot: that an operator
 * can see who on a lease has access and who does not, that the name is
 * restated at the moment of sending — the mis-link the blueprint calls a
 * security incident risk — and that a resident with no account can open the
 * link and land on their own statement.
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

/**
 * Opens a disclosure and checks it opened.
 *
 * `within` is the locator the BUTTON is looked for in, which is not always the
 * page: a resident row and a co-lessee row offer the same buttons, so a
 * page-wide search can act on the wrong person.
 */
async function reveal(
  within: import('@playwright/test').Page | import('@playwright/test').Locator,
  button: string,
  field: import('@playwright/test').Locator,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await within.getByRole('button', { name: button }).first().click();
    if (await field.isVisible({ timeout: 4_000 }).catch(() => false)) return;
  }
  throw new Error(`"${button}" never revealed its form`);
}

test.describe('resident portal invitation', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an operator invites a resident, who opens their own tenancy', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    const stamp = String(Date.now()).slice(-6);
    const email = `co.lessee.${stamp}@demo.invalid`;
    const password = `ResidentPassword${stamp}!`;

    /* ------------------------------------------------ 1. who has access today */

    await page.goto(`${org}/leases`, { waitUntil: 'domcontentloaded' });
    const leaseHref = await page
      .locator('a[href*="/leases/"]:not([href$="/new"])')
      .first().getAttribute('href');
    expect(leaseHref, 'the demo has no lease to invite against').toBeTruthy();
    // Portal access lives under the lease's Parties tab, with the people it
    // concerns, rather than below the statement.
    const partiesHref = `${leaseHref}?tab=parties`;
    await page.goto(partiesHref, { waitUntil: 'domcontentloaded' });

    const panel = page.locator('section').filter({ hasText: 'Resident portal access' });
    await expect(panel).toHaveCount(1);
    const listed = await panel.innerText();
    // Every party, not only those who already have access: the question is
    // "why can this person not see their statement".
    expect(listed).toContain('Thandiwe Mokoena');
    expect(listed).toContain('Sipho Mokoena');
    // And whether each one would see the money, which is not the same question
    // as whether they can sign in.
    expect(listed).toMatch(/can see the money|cannot see the money/);

    /* ------------------------------------ 2. the name is restated before sending */

    const coLessee = panel.locator('li').filter({ hasText: 'Sipho Mokoena' });
    await expect(coLessee).toHaveCount(1);

    const inviteButton = coLessee.getByRole('button', { name: /Invite/ });
    if (await inviteButton.count() === 0) {
      // A previous run already invited them, or invited AND redeemed: an
      // invitation is withdrawn and live access is taken away, and the panel
      // says which, so this takes whichever it is offered. Assuming only the
      // first left the second run waiting five minutes for a button that was
      // never going to appear.
      // Scoped to this co-lessee's own row. Asked of the whole page, "Take
      // access away" matches the PRIMARY resident's row too — and taking her
      // access away broke every resident-portal spec that followed, which is a
      // far louder way to learn that a locator was too wide.
      const undo = (await coLessee
        .getByRole('button', { name: 'Withdraw the invitation' })
        .count()) > 0
        ? 'Withdraw the invitation'
        : 'Take access away';
      await reveal(coLessee, undo, page.getByLabel('Why'));
      await page.getByLabel('Why').fill(`Re-running the browser test ${stamp}.`);
      await page.getByRole('button', { name: 'Confirm' }).click();
      await page.waitForTimeout(2_000);
      await page.goto(partiesHref, { waitUntil: 'domcontentloaded' });
    }

    // Scoped to the portal panel. The Parties tab also lists the lease's
    // parties, so this co-lessee now appears in two lists on one page and an
    // unscoped match finds the one with no buttons in it.
    const row = panel.locator('li').filter({ hasText: 'Sipho Mokoena' }).first();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await row.getByRole('button', { name: /Invite/ }).click();
      if (await page.getByLabel('Their email address')
        .isVisible({ timeout: 4_000 }).catch(() => false)) break;
    }

    const confirming = await visibleText(page);
    // The mis-link guard, in the operator's own words.
    expect(confirming).toContain('You are inviting');
    expect(confirming).toContain('Sipho Mokoena');
    expect(confirming).toContain('shows them somebody else');

    await page.getByLabel('Their email address').fill(email);
    await page.getByRole('button', { name: 'Create the invitation' }).click();

    await expect(page.getByText('Invitation ready for Sipho Mokoena'))
      .toBeVisible({ timeout: 30_000 });

    const issued = await visibleText(page);
    // No provider is configured, so claiming an email was sent would be a lie
    // the resident discovers by never receiving one.
    expect(issued).toContain('No email has been sent');
    expect(issued).toContain('shown once');

    const link = (await page.locator('p.font-mono').first().innerText()).trim();
    expect(link).toContain('/tenancy/');

    /* -------------------------------- 3. the resident opens it with no account */

    const context = await page.context().browser()!.newContext();
    const resident = await context.newPage();
    await resident.goto(link, { waitUntil: 'domcontentloaded' });

    const invitation = await visibleText(resident);
    expect(invitation).toContain('Your tenancy with');
    expect(invitation).toContain('Sipho Mokoena');
    // Which unit, so a resident on two tenancies knows which one this is.
    expect(invitation).toContain('Protea');
    expect(invitation).toContain(email);

    await resident.getByLabel('Choose a password').fill(password);
    await resident.getByLabel('The same password again').fill(password);
    await resident.getByRole('button', { name: 'Open my tenancy' }).click();

    // Straight into the portal: a brand new account has no second factor to
    // get past.
    await resident.waitForURL(/\/portal/, { timeout: 30_000 });
    const portal = await visibleText(resident);
    expect(portal).toContain('Sipho Mokoena');

    /* ----------------------------------------- 4. and the link is now spent */

    await resident.goto(link, { waitUntil: 'domcontentloaded' });
    expect(await visibleText(resident)).toContain('This invitation is not valid');
    await context.close();

    /* ------------------------------------------ 5. the operator sees it taken up */

    await page.goto(partiesHref, { waitUntil: 'domcontentloaded' });
    const after = panel.locator('li').filter({ hasText: 'Sipho Mokoena' }).first();
    const afterText = await after.innerText();
    expect(afterText).toContain('has access');
    expect(afterText).toContain(email);

    /* ----------------------------------- 6. revoking says what it does not do */

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await after.getByRole('button', { name: 'Take access away' }).click();
      if (await page.getByLabel('Why').isVisible({ timeout: 4_000 }).catch(() => false)) break;
    }
    const revoking = await visibleText(page);
    expect(revoking).toContain('this is about the portal, not the tenancy');

    await page.getByLabel('Why').fill('Moved out at the end of the lease.');
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect(
      panel.locator('li').filter({ hasText: 'Sipho Mokoena' })
        .filter({ hasText: 'access revoked' }),
    ).toHaveCount(1, { timeout: 30_000 });
  });
});
