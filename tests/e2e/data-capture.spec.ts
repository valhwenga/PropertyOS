import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Agreement data capture, through the interface.
 *
 * Two things only a browser can establish. First, that an operator can actually
 * correct a resident and capture an identity number — the domain commands for
 * both existed for weeks with no screen that reached them, which is not the
 * same as the feature existing. Second, that the identity number never comes
 * back to a page after it is stored, which is a claim about rendering and so
 * cannot be proved anywhere else.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';
const IDENTITY = '9001015800085';

/** Page text with Next's inline scripts stripped, which otherwise match anything. */
async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

/**
 * Opens an actual resident, not the "Add resident" link.
 *
 * `a[href*="/residents/"]` matches `/residents/new` too, and following that
 * lands on an empty creation form where nothing the test is looking for exists.
 * Matching a UUID is what distinguishes a record from a route.
 */
async function openFirstResident(page: import('@playwright/test').Page): Promise<void> {
  const link = page.locator('a[href*="/residents/"]:not([href$="/new"])').first();
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await page.waitForLoadState('domcontentloaded');
  // The identity control, which exists only on a resident's own page. Matched
  // by role so it cannot also match the "Identity number" field label.
  await expect(
    page.getByRole('button', { name: /(Capture|Replace) (an|the) identity number/ }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe('resident data capture', () => {
  test.describe.configure({ timeout: 180_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an operator can edit a resident and capture a sealed identity number', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');

    await page.goto(`${org}/residents`, { waitUntil: 'domcontentloaded' });
    await openFirstResident(page);

    /* ------------------------------------------------------------ editing */

    await page.getByRole('button', { name: 'Edit this resident' }).click();

    // §3: suspension is not deletion. Archiving is offered; deleting is not.
    // Asserted here rather than in a test of its own, because each sign-in
    // consumes a single-use authentication code and a second one would spend
    // thirty seconds waiting for a window it is allowed to use.
    await expect(page.getByLabel('Status')).toBeVisible();
    await expect(page.getByRole('option', { name: 'Archived' })).toBeAttached();
    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);

    const phone = `082 ${String(Date.now()).slice(-7)}`;
    await page.getByLabel('Phone').fill(phone);
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByText(phone)).toBeVisible({ timeout: 15_000 });

    /* --------------------------------------------------- identity capture */

    await page
      .getByRole('button', { name: /(Capture|Replace) (an|the) identity number/ })
      .click();
    await page.getByLabel('Identity or passport number').fill(IDENTITY);
    await page.getByRole('button', { name: 'Store it' }).click();

    // Masked, and the full number is nowhere on the page it was just typed on.
    await expect(page.getByText('••••••• 0085')).toBeVisible({ timeout: 15_000 });
    const body = await visibleText(page);
    expect(body).not.toContain(IDENTITY);
    expect(body).not.toContain('900101580');

    // And it is still absent after a reload, which is the case a form that
    // helpfully re-populates itself would fail.
    await page.reload({ waitUntil: 'domcontentloaded' });
    const afterReload = await visibleText(page);
    expect(afterReload).not.toContain(IDENTITY);
    expect(afterReload).toContain('••••••• 0085');
  });

});
