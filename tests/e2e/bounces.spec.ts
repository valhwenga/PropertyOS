import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';
import { clearSuppressions, suppressAddress } from './demo-state';

/**
 * Being told to stop emailing somebody.
 *
 * The integration suite proves the endpoint: an event is verified or it
 * changes nothing, a hard bounce suppresses the address, a soft one does not.
 * What the browser has to prove is the half that makes any of it useful — that
 * the landlord, who has the person's phone number, is actually told, in words
 * that name nobody else's customer.
 *
 * Requires a running preview with demo data:
 *   ./scripts/host.sh start --dev
 */

const ADMIN = 'admin@demo.invalid';
const SLUG = 'demo-blue-crane';
const BOUNCING = 'thandiwe@demo.invalid';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('a dead address', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
    await clearSuppressions();
  });

  test.afterAll(async () => { await clearSuppressions(); });

  test('tells the landlord to contact the resident another way', async ({ page }) => {
    await signIn(page, ADMIN);

    // Before: nothing is said, because nothing has bounced.
    await page.goto(`/app/${SLUG}/residents`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Residents' })).toBeVisible({ timeout: 30_000 });
    expect(await visibleText(page)).not.toContain('contact them another way');

    // The provider reports the mailbox is gone.
    await suppressAddress(BOUNCING, 'hard_bounce');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('email bounces — contact them another way').first())
      .toBeVisible({ timeout: 30_000 });

    // A complaint reads differently, and in neither case does the landlord
    // learn whose mail was complained about.
    await clearSuppressions();
    await suppressAddress(BOUNCING, 'complaint');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('asked not to receive email — contact them another way').first())
      .toBeVisible({ timeout: 30_000 });

    const shown = await visibleText(page);
    expect(shown).not.toContain('spam');
    expect(shown).not.toContain('complaint');
  });
});
