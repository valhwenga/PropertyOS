import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Importing a portfolio, through the interface.
 *
 * The import has had domain tests since it was written, and the blueprint's two
 * requirements for it — the fixed order properties → units → residents →
 * leases → schedules → balances, and errors shown by row and field before
 * anything is committed — were answered there. Neither had ever been driven
 * through the running product, which is this project's standing lesson: a dead
 * link, a silent email and a fallback PDF all passed their domain tests.
 *
 * What a browser proves that the integration suite cannot: that an operator can
 * carry one portfolio from a spreadsheet to a resident statement without
 * leaving the product, that a file with a bad row is refused with the row and
 * the column named, and that the opening balance which results is an opening
 * balance — not a month of rent nobody owes.
 *
 * One sign-in: each spends a single-use authentication code.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';

/** Distinct codes per run, so a second run does not collide with the first. */
const RUN = String(Date.now()).slice(-6);
const PROPERTY = `IMP${RUN}`;
const RESIDENT = `IMPRES${RUN}`;
const LEASE = `IMPL${RUN}`;

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

/** Uploads a CSV and waits for the review step to answer. */
async function check(
  page: import('@playwright/test').Page,
  org: string,
  kind: string,
  csv: string,
): Promise<void> {
  await page.goto(`${org}/onboarding?kind=${kind}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Import your portfolio' })).toBeVisible();

  await page.getByLabel('CSV file').setInputFiles({
    name: `${kind}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await page.getByRole('button', { name: 'Check the file' }).click();

  const reviewed = page.getByRole('heading', { name: '2. Review' });
  const refused = page.getByText('Could not read the file');
  await expect(reviewed.or(refused)).toBeVisible({ timeout: 30_000 });
  if (await refused.isVisible().catch(() => false)) {
    throw new Error(`the ${kind} file was not read: ${await visibleText(page)}`);
  }
}

/** Checks a file and imports it, failing with the page's own words if refused. */
async function importCsv(
  page: import('@playwright/test').Page,
  org: string,
  kind: string,
  csv: string,
): Promise<void> {
  await check(page, org, kind, csv);

  const problems = page.getByText('to fix', { exact: false });
  if (await problems.first().isVisible().catch(() => false)) {
    throw new Error(`the ${kind} file was rejected: ${await visibleText(page)}`);
  }

  await page.getByRole('button', { name: /^Import \d+ row/ }).click();
  const done = page.getByText('Imported', { exact: false });
  const failed = page.getByText('Nothing was imported');
  await expect(done.or(failed).first()).toBeVisible({ timeout: 30_000 });
  if (await failed.isVisible().catch(() => false)) {
    throw new Error(`importing ${kind} failed: ${await visibleText(page)}`);
  }
}

test.describe('portfolio import', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a spreadsheet becomes a resident statement, and a bad row never gets in', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* -------------------------------------------- 1. a file with a bad row */

    // Row 3 names a property type that does not exist. The operator should be
    // told which row and which column, not "import failed".
    await check(
      page,
      org!,
      'properties',
      [
        'code,name,property_type,address_line1,suburb,city,province,postal_code,portfolio_code',
        `${PROPERTY},12 Jacaranda Avenue,house,12 Jacaranda Avenue,Rosebank,Johannesburg,Gauteng,2196,`,
        `${PROPERTY}X,8 Aloe Close,castle,8 Aloe Close,Rosebank,Johannesburg,Gauteng,2196,`,
      ].join('\n'),
    );

    const rejected = await visibleText(page);
    expect(rejected).toContain('to fix');
    expect(rejected).toContain('is not valid');

    // Row and column, in the table, as the blueprint asks: the row number must
    // match the operator's own file, counting the header line they can see.
    const problem = page.getByRole('row').filter({ hasText: 'property_type' }).first();
    await expect(problem).toBeVisible();
    const cells = problem.getByRole('cell');
    await expect(cells.nth(0)).toHaveText('3');
    await expect(cells.nth(1)).toHaveText('property_type');
    // Nothing may be offered until the file is clean.
    await expect(page.getByRole('heading', { name: '3. Import' })).toHaveCount(0);

    // And nothing was written: the good row in a bad file is not a half import.
    // The codes are unique to this run, so their absence is the real check —
    // the page lists the whole portfolio, including what earlier runs imported.
    await page.goto(`${org}/portfolio`, { waitUntil: 'domcontentloaded' });
    const portfolio = await visibleText(page);
    expect(portfolio).not.toContain(PROPERTY);

    /* ---------------------------- 1b. a big file, and the product's own limit */

    // Every upload in this product goes through a Server Action, and Next caps
    // an action's body at 1 MB unless told otherwise. A 1.6 MB spreadsheet —
    // well inside the 5 MB the screen advertises — used to answer "A server
    // error occurred", because the framework rejected the request before any of
    // the product's own checks ran. Both sides of that limit are pinned here.

    const bigRows = ['code,name,property_type,address_line1,suburb,city,province,postal_code,portfolio_code'];
    for (let i = 0; i < 16_000; i += 1) {
      bigRows.push(`${PROPERTY}B${i},Big ${i},house,${i} Long Street,Rosebank,Johannesburg,Gauteng,2196,`);
    }
    const big = bigRows.join('\n');
    expect(Buffer.byteLength(big)).toBeGreaterThan(1024 * 1024);

    await check(page, org!, 'properties', big);
    // It is read, and judged on its contents rather than on its size.
    await expect(page.getByRole('heading', { name: '2. Review' })).toBeVisible();

    // Past the product's own limit, the product's own words answer — not a 500.
    const huge = [bigRows[0], ...Array.from({ length: 70_000 }, (_unused, i) =>
      `${PROPERTY}H${i},Huge ${i},house,${i} Long Street,Rosebank,Johannesburg,Gauteng,2196,`)].join('\n');
    expect(Buffer.byteLength(huge)).toBeGreaterThan(5 * 1024 * 1024);

    await page.goto(`${org}/onboarding?kind=properties`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('CSV file').setInputFiles({
      name: 'huge.csv', mimeType: 'text/csv', buffer: Buffer.from(huge, 'utf8'),
    });
    await page.getByRole('button', { name: 'Check the file' }).click();
    await expect(page.getByText('larger than 5 MB')).toBeVisible({ timeout: 60_000 });

    /* ------------------------------------------ 2. the blueprint's order */

    await importCsv(
      page,
      org!,
      'properties',
      [
        'code,name,property_type,address_line1,suburb,city,province,postal_code,portfolio_code',
        `${PROPERTY},12 Jacaranda Avenue,house,12 Jacaranda Avenue,Rosebank,Johannesburg,Gauteng,2196,`,
      ].join('\n'),
    );

    await importCsv(
      page,
      org!,
      'units',
      [
        'property_code,code,rentable_type,bedrooms,bathrooms,advertised_rent',
        `${PROPERTY},MAIN,whole_property,2,1,9500.00`,
      ].join('\n'),
    );

    await importCsv(
      page,
      org!,
      'residents',
      [
        'reference,first_name,last_name,email,phone',
        `${RESIDENT},Lerato,Dlamini,${RESIDENT.toLowerCase()}@demo.invalid,+27 82 555 0199`,
      ].join('\n'),
    );

    await importCsv(
      page,
      org!,
      'leases',
      [
        'reference,property_code,unit_code,primary_resident_reference,co_lessee_references,start_date,end_date,rent,billing_day,deposit_required',
        `${LEASE},${PROPERTY},MAIN,${RESIDENT},,2026-01-01,2026-12-31,9500.00,1,9500.00`,
      ].join('\n'),
    );

    /* ------------------------------------- 3. opening balances need three things */

    await check(
      page,
      org!,
      'opening_balances',
      [
        'lease_reference,description,amount,due_date',
        `${LEASE},"Rent arrears, November 2025",1000.00,2025-11-01`,
      ].join('\n'),
    );

    // The file is clean, so the import step is offered — but withheld until the
    // operator says, in their own name, that they have checked the figures.
    await expect(page.getByRole('heading', { name: '3. Import' })).toBeVisible();
    const importButton = page.getByRole('button', { name: /^Import \d+ row/ });
    await expect(importButton).toBeDisabled();

    const beforeApproval = await visibleText(page);
    expect(beforeApproval).toContain('Cut-off date');
    expect(beforeApproval).toContain('Where these figures came from');
    expect(beforeApproval).toContain('My name will be recorded as the approver');

    await page.getByLabel('Cut-off date').fill('31/12/2025');
    await page
      .getByLabel('Where these figures came from')
      .fill('Accountant ledger export, signed 31 December 2025');
    await page.getByRole('checkbox').check();
    await expect(importButton).toBeEnabled();

    await importButton.click();
    const imported = page.getByText('Imported', { exact: false });
    const failed = page.getByText('Nothing was imported');
    await expect(imported.or(failed).first()).toBeVisible({ timeout: 30_000 });
    if (await failed.isVisible().catch(() => false)) {
      throw new Error(`the opening balance was refused: ${await visibleText(page)}`);
    }

    /* ---------------------------------- 4. the resident's own statement */

    await page.goto(`${org}/leases?q=${LEASE}`, { waitUntil: 'domcontentloaded' });
    const href = await page.getByRole('link', { name: new RegExp(LEASE) }).first().getAttribute('href');
    expect(href, 'the imported lease did not appear in the list').toBeTruthy();
    await page.goto(href!, { waitUntil: 'domcontentloaded' });

    const lease = await visibleText(page);
    expect(lease).toContain('Lerato');
    // R1,000 of arrears, and nothing that calls it rent for a month nobody billed.
    expect(lease).toMatch(/R\s?1[,\s]?000\.00/);
    expect(lease).not.toContain('Monthly rent, November 2025');
  });
});
