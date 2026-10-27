import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearRecoveryRequests } from './demo-state';

/**
 * Getting back into an account, through the interface.
 *
 * The integration suite proves the refusals. What the browser has to prove is
 * that the loop actually closes for a real person: somebody who cannot sign in
 * asks, a colleague confirms it is them, and the link they are given really
 * does let them back in. Before this, that person's only route was a developer
 * with a database connection.
 *
 * It recovers a FORGOTTEN PASSWORD and sets the same password back, so the
 * demo data is unchanged afterwards — the authenticator is deliberately left
 * alone, which is also the behaviour worth asserting: a forgotten password is
 * not a lost second factor.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const LOCKED_OUT = 'finance@demo.invalid';
const COLLEAGUE = 'admin@demo.invalid';     // org_admin of the same landlord
const PASSWORD = process.env.SEED_PASSWORD ?? 'DemoPassword123!';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

/** Clicks a disclosure until what it reveals is really there (dev-mode hydration). */
async function reveal(
  page: import('@playwright/test').Page, button: string, field: string,
): Promise<void> {
  await expect(async () => {
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByLabel(field)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
}

test.describe('a way back in', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearRecoveryRequests();
  });

  test.afterAll(async () => { await clearRecoveryRequests(); });

  test('asked, confirmed by a colleague, and back in', async ({ page }) => {
    // 1. Locked out, and signed out.
    await page.goto('/sign-in', { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Cannot sign in?' }).click();
    await expect(page.getByRole('heading', { name: 'Cannot sign in?' })).toBeVisible();

    // The page sends them to the cheaper routes first.
    const asking = await visibleText(page);
    expect(asking).toContain('recovery codes');
    expect(asking).toContain('ringing them is faster');

    await page.getByLabel('The email address you sign in with').fill(LOCKED_OUT);
    await page.getByRole('radio', { name: /forgotten my password/i }).check();
    await page.getByLabel(/know it is you/i).fill('New laptop, cannot remember what I set');
    await page.getByRole('button', { name: 'Ask for a way back in' }).click();

    // Says nothing about whether that address has an account.
    await expect(page.getByText('Somebody will be in touch')).toBeVisible({ timeout: 30_000 });
    const answer = await visibleText(page);
    expect(answer).toContain('If that address has an account');
    expect(answer).not.toContain(LOCKED_OUT);

    // 2. The colleague who can tell whether it is really them.
    await signIn(page, COLLEAGUE);
    await page.goto('/app/demo-blue-crane/settings/staff', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Locked out' })).toBeVisible();

    const theirView = await visibleText(page);
    expect(theirView).toContain('Forgotten password');
    expect(theirView).toContain('New laptop');
    // The rule, said on the screen where it matters.
    expect(theirView).toContain('Spike does not see these while you can decide them');

    await reveal(page, 'It is really them', 'How you know it is them');
    await page.getByLabel('How you know it is them')
      .fill('She is at the desk opposite mine and I watched the laptop arrive');
    await page.getByRole('button', { name: 'Approve and make a link' }).click();

    // 3. The link, shown once, to be handed over rather than emailed.
    await expect(page.getByText('Send them this link')).toBeVisible({ timeout: 30_000 });
    const shown = await visibleText(page);
    expect(shown).toContain('Shown once and not stored');
    // Read from the element rather than matched out of the page text: a
    // sibling paragraph's first word runs straight onto the end of the token
    // in `textContent`, which cost an afternoon.
    const shownLink = (await page.locator('[data-recovery-link]').textContent()) ?? '';
    const token = shownLink.trim().split('/recover/')[1] ?? '';
    expect(token.length, `a recovery token should be on the page, got ${shownLink}`)
      .toBeGreaterThan(20);

    // 4. The locked-out person, signed out again, using it.
    await page.context().clearCookies();
    await page.goto(`/recover/${token}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Set yourself up again' })).toBeVisible();

    const linkPage = await visibleText(page);
    // It does only what was lost, and says so.
    expect(linkPage).toContain('Leaves your authenticator alone');

    await page.getByLabel('New password').fill(PASSWORD);
    await page.getByLabel('Again').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set my password' }).click();
    await expect(page.getByText('Done. Sign in.')).toBeVisible({ timeout: 30_000 });

    // 5. And the account really works — second factor still required, which is
    // what `signIn` proves by having to supply one.
    await signIn(page, LOCKED_OUT);
    await page.goto('/app/demo-blue-crane', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/app\/demo-blue-crane/);

    // 6. The link is spent.
    await page.context().clearCookies();
    await page.goto(`/recover/${token}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'This link cannot be used' }))
      .toBeVisible({ timeout: 30_000 });
  });

  test('Spike sees nothing it is not meant to', async ({ page }) => {
    // The same landlord, who has an administrator of their own.
    await page.goto('/recover', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('The email address you sign in with').fill(LOCKED_OUT);
    await page.getByRole('radio', { name: /forgotten my password/i }).check();
    await page.getByRole('button', { name: 'Ask for a way back in' }).click();
    await expect(page.getByText('Somebody will be in touch')).toBeVisible({ timeout: 30_000 });

    await signIn(page, 'support@demo.invalid');
    await page.goto('/platform/recoveries', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Locked out' })).toBeVisible();

    const operatorView = await visibleText(page);
    expect(operatorView).toContain('Nobody is waiting');
    // Not filtered out of a list: not readable. The page says which.
    expect(operatorView).toContain('not visible and refused: not readable');
    expect(operatorView).not.toContain(LOCKED_OUT);
  });
});
