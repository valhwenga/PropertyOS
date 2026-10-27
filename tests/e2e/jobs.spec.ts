import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearTestJobs, seedDeadJobs } from './demo-state';

/**
 * The job queue, through the interface.
 *
 * The integration suite proves the decisions and the policies. What the
 * browser has to prove is the part this screen exists for: that an operator
 * opening it after a failure can tell WHAT broke and WHY without a database
 * connection, and that the two decisions available are honest about what they
 * do.
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

test.describe('background work', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearTestJobs();
  });

  test.afterAll(async () => { await clearTestJobs(); });

  test('says what failed and why, and runs it again', async ({ page }) => {
    await seedDeadJobs('demo.spec.broken', 3, 'TypeError: handler is not a function');

    await signIn(page, SUPPORT);
    await page.goto('/platform/jobs', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Background work' })).toBeVisible();

    const text = await visibleText(page);
    // The honest line about what a retry is and is not.
    expect(text).toContain('only whether it runs');
    // Grouped by cause, because one broken handler is one cause.
    expect(text).toContain('What is failing');
    expect(text).toContain('demo.spec.broken');
    expect(text).toContain('3 dead jobs');
    // The error, in full, which is the thing you would otherwise open psql for.
    expect(text).toContain('handler is not a function');

    // All three in one decision.
    const cause = page.locator('div').filter({ hasText: 'demo.spec.broken' }).first();
    await cause.getByRole('button', { name: /Run all 3 again/ }).click();
    await page.getByLabel('What was fixed').first()
      .fill('SPK-9400: the handler was registered and deployed');
    await page.getByRole('button', { name: /Run all 3 again/ }).last().click();

    // The cause disappearing is the feedback: a successful bulk retry empties
    // it from the page, so there is no success line to wait for.
    await expect(page.getByText('demo.spec.broken')).toHaveCount(0, { timeout: 30_000 });

    // And they really are queued rather than merely hidden.
    await page.goto('/platform/jobs?status=queued', { waitUntil: 'domcontentloaded' });
    expect(await visibleText(page)).toContain('demo.spec.broken');
  });

  test('abandons one, keeping the evidence and clearing the count', async ({ page }) => {
    await seedDeadJobs('demo.spec.hopeless', 1, 'ReferenceError: lease was deleted');

    await signIn(page, SUPPORT);
    await page.goto('/platform/jobs', { waitUntil: 'domcontentloaded' });

    const row = page.locator('[data-job]').filter({ hasText: 'demo.spec.hopeless' }).first();
    await row.getByRole('button', { name: 'It will never run' }).click();

    // The screen says what abandoning does before it is done.
    const beforeText = await visibleText(page);
    expect(beforeText).toContain('The row and its attempts stay');
    expect(beforeText).toContain('stops being counted as outstanding');

    await row.getByLabel('Why it can never run').fill('The lease it refers to was deleted');
    await row.getByRole('button', { name: 'Abandon it' }).click();

    await expect(page.getByText(/Nothing has been given up on/))
      .toBeVisible({ timeout: 30_000 });

    // Still there under abandoned, with the reason and the person.
    await page.goto('/platform/jobs?status=abandoned', { waitUntil: 'domcontentloaded' });
    const abandoned = await visibleText(page);
    expect(abandoned).toContain('demo.spec.hopeless');
    expect(abandoned).toContain('The lease it refers to was deleted');
    expect(abandoned).toContain('Spike Support');
  });
});
