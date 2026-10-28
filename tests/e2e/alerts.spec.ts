import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearAlertState, clearTestJobs, seedDeadJobs } from './demo-state';

/**
 * Being told, through the interface.
 *
 * The integration suites prove the conditions, the permissions and the
 * delivery. What the browser has to prove is the only thing that makes this
 * feature different from the counts that were already there: that an operator
 * who is doing something else entirely is told anyway.
 *
 * So the assertion that matters is on a page that has nothing to do with jobs.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const OPERATOR = 'support@demo.invalid';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

async function reveal(
  page: import('@playwright/test').Page, button: string, field: string,
): Promise<void> {
  await expect(async () => {
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByLabel(field)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
}

test.describe('being told', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearTestJobs();
    await clearAlertState();
  });

  test.afterAll(async () => { await clearTestJobs(); await clearAlertState(); });

  test('shouts on a page about something else, and can be quietened', async ({ page }) => {
    await seedDeadJobs('demo.spec.alerting', 2, 'TypeError: handler is not a function');

    await signIn(page, OPERATOR);

    // Somewhere with nothing to do with jobs: this is the whole point. Before
    // this, the only place that knew was a screen nobody had open.
    await page.goto('/platform/operators', { waitUntil: 'domcontentloaded' });
    const banner = page.getByRole('alert');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('given up on');
    // It says where to go rather than leaving a riddle.
    await expect(banner.getByRole('link', { name: 'Look' })).toBeVisible();

    // The home page carries the whole list, and what has been said about it.
    await page.goto('/platform', { waitUntil: 'domcontentloaded' });
    const home = await visibleText(page);
    expect(home).toContain('Needs attention');
    expect(home).toContain('given up on');
    expect(home).toContain('nobody has been told');

    // Known, and in hand: quietened with a reason, not hidden.
    const card = page.locator('[data-alert="jobs.dead"]');
    await expect(card).toBeVisible();
    await reveal(page, 'Known — stop telling me for now', 'Why');
    await page.getByLabel('Why').fill('Known: the handler fix deploys on Thursday, SPK-7310');
    await page.getByRole('button', { name: 'Silence it' }).click();

    // Still listed, with who and why — a colleague has to be able to see that
    // somebody quietened it.
    await expect(page.getByText(/Silenced until/)).toBeVisible({ timeout: 30_000 });
    const silenced = await visibleText(page);
    expect(silenced).toContain('SPK-7310');
    expect(silenced).toContain('Spike Support');
    expect(silenced).toContain('given up on');

    // And the banner has stopped shouting, everywhere.
    await page.goto('/platform/operators', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Lifting it brings the banner back, so nothing is lost by silencing.
    await page.goto('/platform', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Tell me about it again' }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  });

  test('says nothing when nothing is wrong', async ({ page }) => {
    await signIn(page, OPERATOR);
    await page.goto('/platform', { waitUntil: 'domcontentloaded' });

    // No banner at all, and the list says so in words rather than showing an
    // empty box.
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await visibleText(page)).toContain('Nothing is wrong');
  });
});
