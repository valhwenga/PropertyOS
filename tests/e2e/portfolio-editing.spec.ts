import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Correcting the portfolio, through the interface.
 *
 * `createProperty` and `createUnit` existed; nothing could correct either. A
 * typo in a unit code or a street spelled wrong needed database access, which
 * in practice means it stays wrong.
 *
 * What the browser proves that the integration suite cannot: that the refusal
 * to retire an occupied unit happens BEFORE the operator fills anything in.
 * "Do not silently retire occupied units" is served better by never offering
 * to than by accepting a reason and then rejecting it.
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

/** A click that lands before hydration does nothing; retrying is the fix. */
async function reveal(
  page: import('@playwright/test').Page,
  button: string,
  field: import('@playwright/test').Locator,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByRole('button', { name: button }).first().click();
    if (await field.isVisible({ timeout: 4_000 }).catch(() => false)) return;
  }
  throw new Error(`"${button}" never revealed its form`);
}

test.describe('portfolio editing', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a property is corrected, and an occupied unit cannot be retired', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------------ 1. reach the property */

    await page.goto(`${org}/portfolio`, { waitUntil: 'domcontentloaded' });
    const propertyHref = await page
      .locator('a[href*="/portfolio/"]:not([href$="/new"])')
      .first().getAttribute('href');
    expect(propertyHref, 'the demo has no property to edit').toBeTruthy();
    await page.goto(propertyHref!, { waitUntil: 'domcontentloaded' });

    /* ------------------------------------------------- 2. correct the address */

    await page.getByRole('link', { name: 'Edit the property' }).click();
    await page.waitForURL(/\/portfolio\/[0-9a-f-]{36}\/edit/, { timeout: 30_000 });

    const editing = await visibleText(page);
    // The reassurance that makes editing safe to do at all.
    expect(editing).toContain('does not change anything already issued');
    expect(editing).toContain('does not restate a document somebody signed last year');

    const suburb = `Melville ${String(Date.now()).slice(-5)}`;
    await page.getByLabel('Suburb').fill(suburb);
    await page.getByLabel('Why it is being corrected')
      .fill('The deed records the suburb; the original capture left it out.');
    await page.getByRole('button', { name: 'Save the property' }).click();

    // Saving returns to the property, which is where the change is visible.
    await page.waitForURL(/\/portfolio\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    expect(await visibleText(page)).toContain(suburb);

    /* ------------------------------- 3. the occupied unit refuses up front */

    const unitHref = await page
      .locator('a[href*="/units/"]').first().getAttribute('href');
    expect(unitHref, 'the property lists no unit to open').toBeTruthy();
    await page.goto(unitHref!, { waitUntil: 'domcontentloaded' });

    const unit = await visibleText(page);
    const occupied = /is (active|notice given|awaiting execution)/.test(unit);
    expect(occupied, 'the demo unit is expected to carry a live lease').toBe(true);

    // The refusal is stated before anything is filled in, and names the lease.
    // Which lease depends on which property the demo lists first, and an
    // imported portfolio carries the operator's own references rather than the
    // seed's LSE-nnn — so this asks that a reference is named, not that it
    // looks like the seed's.
    expect(unit).toContain('cannot be retired');
    expect(unit).toMatch(/cannot be retired: lease \S+ is still/);
    expect(unit).toContain('would hide the arrangement rather than end it');
    await expect(page.getByRole('button', { name: 'Retire this unit' })).toHaveCount(0);

    /* --------------------------- 4. the advertised rent is not the rent */

    const advertised = page.getByLabel(/Advertised rent/);
    await expect(advertised).toBeVisible();
    expect(unit).toContain('changed by a renewal — never from here');

    // The lease on this unit, and the rent it is actually charging, read from
    // the row itself. Hard-coding the seed's R8,000 tied this assertion to
    // whichever property happened to sort first, and an imported portfolio put
    // a different one there — so the invariant was reported as broken when all
    // that had changed was the fixture.
    const leaseReference = /cannot be retired: lease (\S+) is still/.exec(unit)?.[1] ?? '';
    expect(leaseReference, 'the unit did not name the lease on it').toBeTruthy();

    await page.goto(propertyHref!, { waitUntil: 'domcontentloaded' });
    const row = page.locator('tr', { hasText: leaseReference }).first();
    const moneyBefore = (await row.innerText()).match(/R[\d,]+\.\d{2}/g) ?? [];
    const leaseRent = moneyBefore[0];
    expect(leaseRent, 'the unit row shows no rent').toBeTruthy();
    await page.goto(unitHref!, { waitUntil: 'domcontentloaded' });

    const rand = 7000 + Number(String(Date.now()).slice(-3));
    const marker = `${rand}.00`;
    // What the table will actually render: grouped with commas and carrying the
    // symbol. Node's own `toLocaleString('en-ZA')` groups with spaces, so
    // borrowing it here would assert a format the app never produces.
    const rendered = `R${String(rand).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.00`;
    await page.getByLabel(/Advertised rent/).fill(marker);
    await page.getByRole('button', { name: 'Save the unit' }).click();
    await page.waitForURL(/\/portfolio\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const afterRow = await page.locator('tr', { hasText: leaseReference }).first().innerText();
    // The advertised figure moved; the lease's own rent did not follow it.
    expect(afterRow).toContain(rendered);
    expect(afterRow).toContain(leaseRent!);

    /* ----------------------- 5. archiving refuses while units are active */

    await page.goto(`${propertyHref!}/edit`, { waitUntil: 'domcontentloaded' });
    const archiving = await visibleText(page);
    expect(archiving).toContain('active unit');
    expect(archiving).toContain('without anybody seeing which were still let');
    await expect(page.getByRole('button', { name: 'Archive this property' })).toHaveCount(0);
  });

  test('an empty unit is retired with a reason, and put back', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');

    /* ------------------------------------------- an empty unit to work with */

    const code = `T${String(Date.now()).slice(-5)}`;
    await page.goto(`${org}/portfolio`, { waitUntil: 'domcontentloaded' });
    const propertyHref = await page
      .locator('a[href*="/portfolio/"]:not([href$="/new"])')
      .first().getAttribute('href');
    await page.goto(propertyHref!, { waitUntil: 'domcontentloaded' });

    // Added through the interface, so the test does not reach into the
    // database for its own fixture. `createUnit` had no screen at all until
    // now: a property kept whatever units it was born with.
    await page.goto(`${propertyHref!}/edit`, { waitUntil: 'domcontentloaded' });
    await reveal(page, 'Add a unit', page.getByLabel('Unit code'));
    await page.getByLabel('Unit code').fill(code);
    await page.getByLabel('Bedrooms').fill('2');
    await page.getByRole('button', { name: 'Add the unit' }).click();
    await page.waitForURL(/\/portfolio\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    expect(await visibleText(page)).toContain(code);

    /* ------------------------------------------------- retire, then reinstate */

    await page.getByRole('link', { name: code, exact: true }).click();
    await page.waitForURL(/\/units\/[0-9a-f-]{36}/, { timeout: 30_000 });

    await reveal(page, 'Retire this unit', page.getByLabel('Why it is being retired'));
    const confirming = await visibleText(page);
    // Retiring reads like deleting and is not, so the form says so.
    expect(confirming).toContain('not deleting');
    expect(confirming).toContain('nothing in the ledger moves');

    await page.getByLabel('Why it is being retired')
      .fill('Taken off the market pending roof repairs.');
    await page.getByRole('button', { name: 'Retire the unit' }).click();

    const retired = page.getByText('This unit is retired');
    const failed = page.getByText('Not retired');
    await expect(retired.or(failed).first()).toBeVisible({ timeout: 30_000 });
    if (await failed.isVisible().catch(() => false)) {
      throw new Error(`retiring was refused: ${await visibleText(page)}`);
    }

    await page.getByLabel('Why it is coming back').fill('Roof repaired, back on the market.');
    await page.getByRole('button', { name: 'Put the unit back' }).click();

    await expect(
      page.getByRole('button', { name: 'Retire this unit' }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
