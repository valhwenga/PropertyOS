import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Reading the audit trail, through the interface.
 *
 * Every command writes an entry in the same transaction as the change it
 * describes, and nothing could read one back: the trail existed for a dispute
 * nobody could open.
 *
 * What the browser proves that the integration suite cannot: that a change
 * made through the interface shows up in the trail with the reason the
 * operator typed, that one record's history is reachable from the record
 * itself, and that the page says plainly that nothing in it can be edited.
 *
 * One sign-in — each spends a single-use authentication code.
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

test.describe('audit trail', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a change made now is readable, with the reason that was typed', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* -------------------------------------------- 1. make a change to find */

    await page.goto(`${org}/portfolio`, { waitUntil: 'domcontentloaded' });
    const propertyHref = await page
      .locator('a[href*="/portfolio/"]:not([href$="/new"])')
      .first().getAttribute('href');
    expect(propertyHref).toBeTruthy();

    const reason = `Deed correction ${String(Date.now()).slice(-6)}`;
    const suburb = `Melville ${String(Date.now()).slice(-4)}`;
    await page.goto(`${propertyHref!}/edit`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Suburb').fill(suburb);
    await page.getByLabel('Why it is being corrected').fill(reason);
    await page.getByRole('button', { name: 'Save the property' }).click();
    await page.waitForURL(/\/portfolio\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    /* ------------------------------ 2. one record's history from the record */

    await page.goto(`${propertyHref!}/edit`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: /Every change to this property/ }).click();
    await page.waitForURL(/\/settings\/audit\?/, { timeout: 30_000 });

    const history = await visibleText(page);
    // It is one record's history, not a filtered slice of the whole trail, and
    // it says which.
    expect(history).toContain('one record');
    expect(history).toContain('property.updated');
    expect(history).toContain(reason);
    // The change itself, before and after, not two JSON blobs to diff by eye.
    expect(history).toContain('Suburb');
    expect(history).toContain(suburb);
    // The promise the page has to earn.
    expect(history).toContain('Nothing on this page can be changed');
    expect(history).toContain('not to an administrator, and not to Spike support');

    /* --------------------------------------------- 3. the whole trail, filtered */

    await page.getByRole('link', { name: /Show the whole trail/ }).click();
    await page.waitForURL(/\/settings\/audit$/, { timeout: 30_000 });

    // The filters are offered from what the trail actually contains, so every
    // option matches something.
    const actions = page.getByLabel('Action');
    await expect(actions).toBeVisible();
    await actions.selectOption({ value: 'property.updated' });
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL(/action=property.updated/, { timeout: 30_000 });

    const filtered = await visibleText(page);
    expect(filtered).toContain(reason);

    // Scoped to the entries, not the whole page: every action in the trail is
    // named in the filter dropdown, so a page-wide "does not contain" would
    // only be testing that the dropdown is empty.
    const entries = page.locator('li').filter({ hasText: 'Reason given' });
    expect(await entries.count()).toBeGreaterThan(0);
    for (const entry of await entries.all()) {
      expect(await entry.innerText()).toContain('property.updated');
    }

    /* ------------------------------------------- 4. a range that cannot be */

    await page.goto(
      `${org}/settings/audit?from=2026-03-31&to=2026-01-01`,
      { waitUntil: 'domcontentloaded' },
    );
    const refused = await visibleText(page);
    // A refusal is information, not a crash.
    expect(refused).toContain('The start of the range is after its end');
    await expect(page.getByRole('button', { name: 'Apply' })).toHaveCount(0);

    /* ----------------------------------- 5. a filter that matches nothing */

    await page.goto(
      `${org}/settings/audit?from=2020-01-01&to=2020-01-02`,
      { waitUntil: 'domcontentloaded' },
    );
    const empty = await visibleText(page);
    expect(empty).toContain('Nothing matches');
    // And it says the trail itself is not empty, so nobody reads an empty
    // result as "nothing ever happened".
    expect(empty).toContain('The trail itself is not empty');
  });
});
