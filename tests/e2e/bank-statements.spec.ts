import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Importing a bank statement, through the interface.
 *
 * The tables existed from the start with nothing able to write to them, so the
 * one thing a landlord does every month had no support at all.
 *
 * What the browser proves that the integration suite cannot: that an operator
 * can get from "here is my statement" to "that R7,500 was Mokoena's rent"
 * without leaving the product — and that at no point does the product decide
 * for them who paid. The import is previewed before it commits, a duplicate
 * import is refused with the reason, and a line that is not a receipt can be
 * set aside with a reason rather than left on the list forever.
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

test.describe('bank statements', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a statement is previewed, imported, and its lines identified', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    // Unique amounts, so a second run of this spec against the same demo
    // database does not collide with the first run's lines.
    const stamp = String(Date.now()).slice(-5);
    const rent = `7${stamp}.00`;
    const charge = `5${stamp.slice(-2)}.00`;
    const csv = [
      'Date,Description,Amount',
      `07/01/2026,EFT MOKOENA PROTEA14 ${stamp},${rent}`,
      `05/01/2026,BANK CHARGES ${stamp},-${charge}`,
    ].join('\n');

    /* -------------------------------------------------- 1. the worklist */

    await page.goto(`${org}/reconciliation`, { waitUntil: 'domcontentloaded' });
    const reconciliation = await visibleText(page);
    // The page no longer claims import does not exist.
    expect(reconciliation).toContain('Importing creates no receipt and moves no balance');

    await page.getByRole('link', { name: 'Bank statements →' }).click();
    await page.waitForURL(/\/reconciliation\/statements/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Bank statements' })).toBeVisible();

    const intro = await visibleText(page);
    // Said plainly, because it is the thing that matters.
    expect(intro).toContain('it is not a receipt');
    expect(intro).toContain('No bank is contacted');

    /* ------------------------------------------- 2. preview before commit */

    await page.getByRole('button', { name: 'Paste the rows' }).click();
    const pasted = page.getByLabel('Rows, with a header line');
    await expect(pasted).toBeVisible({ timeout: 10_000 });
    await pasted.fill(csv);
    await page.getByRole('button', { name: 'Check the file' }).click();

    const checked = page.getByText('What this will do');
    const unreadable = page.getByText('Could not read that file');
    await expect(checked.or(unreadable).first()).toBeVisible({ timeout: 30_000 });
    if (await unreadable.isVisible().catch(() => false)) {
      throw new Error(`the file was refused: ${await visibleText(page)}`);
    }

    const preview = await visibleText(page);
    expect(preview).toContain('Will import');
    // Money in and money out are separated: a debit is not a receipt of
    // anything and must not be counted as one.
    expect(preview).toMatch(/Money in ?R?7/);

    /* -------------------------------------------------------- 3. commit */

    await page.getByRole('button', { name: /^Import 2 lines$/ }).click();
    const imported = page.getByText('No receipt was created and no balance moved');
    const refused = page.getByText('Nothing was imported');
    await expect(imported.or(refused).first()).toBeVisible({ timeout: 30_000 });
    if (await refused.isVisible().catch(() => false)) {
      throw new Error(`the import was refused: ${await visibleText(page)}`);
    }

    /* ------------------------------------- 4. the same file is refused */

    await page.goto(`${org}/reconciliation/statements`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Paste the rows' }).click();
    await page.getByLabel('Rows, with a header line').fill(csv);
    await page.getByRole('button', { name: 'Check the file' }).click();
    await expect(page.getByText('What this will do')).toBeVisible({ timeout: 30_000 });

    const second = await visibleText(page);
    expect(second).toContain('Already imported');
    expect(second).toContain('nothing to import');
    // And there is no button to do it anyway.
    await expect(page.getByRole('button', { name: /^Import \d+ line/ })).toHaveCount(0);

    /* --------------------------------- 5. suggest a payer, do not decide */

    await page.goto(`${org}/reconciliation/statements`, { waitUntil: 'domcontentloaded' });
    const rentLine = page.locator('li').filter({ hasText: `EFT MOKOENA PROTEA14 ${stamp}` });
    await expect(rentLine).toHaveCount(1);
    expect(await rentLine.innerText()).toContain('Not identified');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await rentLine.getByRole('button', { name: 'Who might this be?' }).click();
      if (await page.getByText('Suggestions, not answers')
        .isVisible({ timeout: 4_000 }).catch(() => false)) break;
      if (await page.getByText('Nothing in the description')
        .isVisible({ timeout: 1_000 }).catch(() => false)) break;
    }

    const suggested = await visibleText(page);
    expect(suggested).toContain('Suggestions, not answers');
    // The reason is in words, not a score.
    expect(suggested).toContain('the description contains "Mokoena"');
    // Even one candidate is not applied for them.
    expect(suggested).toContain('it is still your decision');

    /* ------------------------------ 6. recording the receipt links them */

    await rentLine.getByRole('link', { name: /Record a receipt against this lease/ }).click();
    await page.waitForURL(/\/reconciliation\?/, { timeout: 30_000 });

    const prefilled = await visibleText(page);
    expect(prefilled).toContain('the amount and date come from the bank');
    // The bank's own figures are carried over rather than retyped.
    await expect(page.getByLabel('Amount received')).toHaveValue(rent);
    await expect(page.getByLabel('Date received')).toHaveValue('2026-01-07');

    await page.getByRole('button', { name: 'Record receipt' }).click();
    const recorded = page.getByText('Receipt recorded.');
    const notSaved = page.getByText('Not saved');
    await expect(recorded.or(notSaved).first()).toBeVisible({ timeout: 30_000 });
    if (await notSaved.isVisible().catch(() => false)) {
      throw new Error(`recording the receipt was refused: ${await visibleText(page)}`);
    }

    // The line is off the worklist and names the receipt it became, so nobody
    // receipts it a second time.
    await page.goto(`${org}/reconciliation/statements?show=all`, { waitUntil: 'domcontentloaded' });
    const afterReceipt = page.locator('li').filter({ hasText: `EFT MOKOENA PROTEA14 ${stamp}` });
    const afterText = await afterReceipt.innerText();
    expect(afterText).toContain('Receipted');
    expect(afterText).toMatch(/RCT/);

    /* --------------------------------------- 7. a debit is set aside */

    await page.goto(`${org}/reconciliation/statements`, { waitUntil: 'domcontentloaded' });
    const chargeLine = page.locator('li').filter({ hasText: `BANK CHARGES ${stamp}` });
    await expect(chargeLine).toHaveCount(1);
    // A debit is not a receipt of anything, so it is not offered a payer.
    await expect(chargeLine.getByRole('button', { name: 'Who might this be?' })).toHaveCount(0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await chargeLine.getByRole('button', { name: 'Not a receipt' }).click();
      if (await page.getByLabel('Why it is not a receipt')
        .isVisible({ timeout: 4_000 }).catch(() => false)) break;
    }
    await page.getByLabel('Why it is not a receipt')
      .fill('Monthly bank charges, recorded as an expense instead.');
    await page.getByRole('button', { name: 'Set it aside' }).click();

    await expect(
      page.locator('li').filter({ hasText: `BANK CHARGES ${stamp}` }),
    ).toHaveCount(0, { timeout: 30_000 });

    // Set aside, not deleted, and it can be put back.
    await page.goto(`${org}/reconciliation/statements?show=all`, { waitUntil: 'domcontentloaded' });
    const asideLine = page.locator('li').filter({ hasText: `BANK CHARGES ${stamp}` });
    expect(await asideLine.innerText()).toContain('Set aside');
    await expect(
      asideLine.getByRole('button', { name: 'Put back on the worklist' }),
    ).toBeVisible();

    // And the import is on the record with who did it.
    const history = await visibleText(page);
    expect(history).toContain('Statements imported');
    expect(history).toContain('imported by');
  });
});
