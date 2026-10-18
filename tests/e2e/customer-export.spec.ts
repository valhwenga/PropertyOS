import { test, expect } from '@playwright/test';
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { signIn } from './sign-in';

/**
 * Leaving with your own data, through the interface.
 *
 * The domain tests prove the archive's contents and its refusals. What a
 * browser proves is the part that decides whether any of that is real to a
 * customer: that an administrator can find the export, that clicking it hands
 * over a file their computer will open, and that the page says what is not in
 * it before they discover the gap themselves.
 *
 * One sign-in: each spends a single-use authentication code.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';

/** Reads an archive through its central directory, as an unzip tool would. */
function readZip(archive: Buffer): Record<string, string> {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd, 'the download is not a ZIP archive').toBeGreaterThan(-1);
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  const files: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const dataStart =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    files[name] = inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize)).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('customer export', () => {
  test.describe.configure({ timeout: 240_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an administrator downloads the whole organisation, and is told what is missing', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------ it is offered in settings */

    await page.goto(`${org}/settings`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: 'Export your data' })).toBeVisible();
    await page.goto(`${org}/settings/export`, { waitUntil: 'domcontentloaded' });

    const offered = await visibleText(page);
    // The honest half of the page, before anybody downloads anything.
    expect(offered).toContain('What is deliberately not in it');
    expect(offered).toContain('The attachment files themselves');
    expect(offered).toContain('Full identity and bank account numbers');
    expect(offered).toContain('recorded in the audit trail');

    /* --------------------------------------------- the file itself */

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download the archive' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^propertyos-.*\.zip$/);

    const path = await file.path();
    const files = readZip(readFileSync(path));

    for (const expected of [
      'README.txt', 'properties.csv', 'units.csv', 'residents.csv', 'leases.csv',
      'charge_documents.csv', 'charge_lines.csv', 'receipts.csv',
      'payment_allocations.csv', 'deposit_accounts.csv', 'deposit_events.csv',
      'expenses.csv', 'attachments.csv',
    ]) {
      expect(Object.keys(files), `${expected} is missing from the archive`).toContain(expected);
    }

    // The demo portfolio is in it, by its own references.
    expect(files['leases.csv']).toContain('LSE-000001');
    expect(files['properties.csv']).toContain('14 Protea Street');
    // Amounts are whole cents, so nothing rounded on the way out.
    expect(files['charge_lines.csv']).toMatch(/\b800000\b/);
    // And the README explains that, which is what makes the figure usable.
    expect(files['README.txt']).toContain('185000 is R1,850.00');

    /* ----------------------------------------- and the trail recorded it */

    // Filtered to the action, so this is the entry itself rather than the
    // filter's own option carrying the same words.
    await page.goto(`${org}/settings/audit?action=customer.exported`, { waitUntil: 'domcontentloaded' });
    const entry = page.locator('li, tr, article').filter({ hasText: 'customer.exported' }).first();
    await expect(entry).toBeVisible({ timeout: 20_000 });
    // Who took it, not merely that something happened.
    await expect(entry).toContainText('Nomsa');
  });
});
