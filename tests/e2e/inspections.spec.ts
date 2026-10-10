import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Inspections, through the interface.
 *
 * The module had five commands and no way to record what an inspector found:
 * `createInspection` pre-populated the checklist from its template with every
 * item unchecked, and nothing could then change them. A checklist nobody can
 * fill in is decorative, and a move-out deduction resting on it rests on
 * nothing.
 *
 * What the browser proves that the integration suite cannot: that an operator
 * can publish a checklist, perform an inspection against it, finalise it, and
 * see in words that fair wear and tear supports no deduction.
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

test.describe('inspections', () => {
  test.describe.configure({ timeout: 240_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a checklist is published, performed and finalised', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------------ 1. publish a checklist */

    await page.goto(`${org}/inspections`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Inspections', exact: true })).toBeVisible();

    const name = `Browser checklist ${String(Date.now()).slice(-6)}`;
    await page.getByRole('button', { name: 'Publish a checklist' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Items, one per line')
      .fill('Kitchen: Oven\nLounge: Carpet\nBathroom: Shower screen');
    await page.getByRole('button', { name: 'Publish', exact: true }).click();

    const published = page.getByText('Checklist published.');
    const publishFailed = page.getByText('Could not publish the checklist');
    await expect(published.or(publishFailed)).toBeVisible({ timeout: 20_000 });
    if (await publishFailed.isVisible().catch(() => false)) {
      throw new Error(`publishing was refused: ${await visibleText(page)}`);
    }

    /* ------------------------------------------------ 2. start an inspection */

    await page.goto(`${org}/inspections`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Start an inspection' }).click();

    const units = page.getByLabel('Unit');
    await units.selectOption({ index: 1 });
    await page.getByLabel('Type').selectOption('move_out');
    const checklist = page.getByLabel('Checklist');
    const templateValue = await checklist.locator('option').filter({ hasText: name })
      .first().getAttribute('value');
    expect(templateValue, 'the published checklist was not offered').toBeTruthy();
    await checklist.selectOption(templateValue!);
    await page.getByRole('button', { name: 'Create the checklist' }).click();

    // Creating redirects to the new inspection.
    await page.waitForURL(/\/inspections\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const detail = await visibleText(page);
    expect(detail).toContain('Being filled in');

    /* --------------------------------------------------- 3. record findings */

    // An unchecked item must stay unchecked: defaulting it to good would put
    // words in the inspector's mouth.
    expect(detail).toContain('Not checked');

    const rows = page.locator('select[name^="condition:"]');
    await expect(rows).toHaveCount(3);

    // Good, fair wear and tear, and real damage — the three cases that matter.
    await rows.nth(0).selectOption('good');
    await rows.nth(1).selectOption('poor');
    await page.locator('select[name^="damage:"]').nth(1).selectOption('fair_wear_and_tear');
    await page.locator('input[name^="note:"]').nth(1)
      .fill('Flattened in the traffic path after three years.');
    await rows.nth(2).selectOption('damaged');
    await page.locator('select[name^="damage:"]').nth(2).selectOption('damage');

    await page.getByRole('button', { name: 'Save findings' }).click();
    const saved = page.getByText('Findings saved.');
    const saveFailed = page.getByText('Findings not saved');
    await expect(saved.or(saveFailed)).toBeVisible({ timeout: 20_000 });
    if (await saveFailed.isVisible().catch(() => false)) {
      throw new Error(`recording findings was refused: ${await visibleText(page)}`);
    }

    /* ------------------------------------------------------- 4. finalise it */

    await page.getByRole('button', { name: 'Finalise this inspection' }).click();
    const confirming = await visibleText(page);
    expect(confirming).toContain('closes the findings to editing');

    await page.getByRole('button', { name: 'Finalise', exact: true }).click();

    const closed = page.getByText('Awaiting the resident');
    const finaliseFailed = page.getByText('Could not finalise');
    await expect(closed.or(finaliseFailed)).toBeVisible({ timeout: 20_000 });
    if (await finaliseFailed.isVisible().catch(() => false)) {
      throw new Error(`finalising was refused: ${await visibleText(page)}`);
    }

    const final = await visibleText(page);
    // The distinction the module exists for, stated rather than left to the reader.
    expect(final).toContain('Fair wear and tear — not deductible');
    expect(final).toContain('1 item is recorded as damage or missing');
    expect(final).toContain('separate decision');
    // And the findings are no longer editable from the page.
    await expect(page.locator('select[name^="condition:"]')).toHaveCount(0);
    // A correction supersedes rather than edits.
    await expect(page.getByRole('button', { name: 'Correct this inspection' })).toBeVisible();
  });
});
