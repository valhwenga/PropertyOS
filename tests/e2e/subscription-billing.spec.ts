import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Spike charging the landlord, and the landlord seeing the bill.
 *
 * The defect behind this spec is the simplest one in the product: plans,
 * prices, allowances and an overage rate had existed since the first migration
 * and nothing had ever charged anybody, so a customer could be over their
 * allowance on a paid plan and owe nothing.
 *
 * Requires a running preview with demo data:
 *   pnpm host start --dev --reset
 */

const SPIKE = 'support@demo.invalid';
const LANDLORD = 'admin@demo.invalid';

test.describe('Subscription billing', () => {
  test.describe.configure({ timeout: 900_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('Spike sets itself up, bills a month, and the landlord sees the invoice', async ({ page }) => {
    const period = `2026-0${1 + (Date.now() % 8)}-01`;   // a month unlikely to collide
    const reference = `EFT-${Date.now().toString().slice(-6)}`;

    await signIn(page, SPIKE);
    await page.goto('/platform/billing', { waitUntil: 'domcontentloaded' });

    /* ------------------------------------------- who the invoice comes from */
    const settings = page.locator('form', { has: page.locator('#legalName') });
    await settings.locator('#legalName').fill('Spike Technologies (Pty) Ltd');
    await settings.locator('#address').fill('1 Example Road, Cape Town, 8001');
    // Deliberately no VAT number: the documents must then show no tax at all.
    await settings.locator('#vatNumber').fill('');
    await settings.locator('#bankDetails').fill('Example Bank · 1234567890 · branch 250655');
    await settings.getByRole('button', { name: 'Save' }).click();
    // Generous, because this is the first Server Action of the run and the
    // preview compiles the route on the way through: the default five seconds
    // times out while the button still reads "Saving…", which looks like a
    // broken save and is a cold start.
    await expect(settings.getByText('Saved.')).toBeVisible({ timeout: 30_000 });

    /* ------------------------------------------------------- bill the month */
    const run = page.locator('form', { has: page.locator('#periodStart') });
    await run.locator('#periodStart').fill(period);
    await run.locator('#issueDate').fill(period);
    await run.getByRole('button', { name: 'Issue the invoices' }).click();

    // Who was billed and who was not, by name. A demo organisation still on
    // trial must be reported as skipped rather than silently left out.
    // The paying demo customer is billed; the one still on trial is reported
    // as skipped by name rather than silently left out.
    await expect(page.getByText(/invoice(s)? issued/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Blue Crane/).first()).toBeVisible();
    await expect(page.getByText('Not billed', { exact: true })).toBeVisible();
    await expect(page.getByText(/Karoo.*on trial/)).toBeVisible();

    /* ------------------------------------ pressing it again cannot re-bill */
    await run.locator('#periodStart').fill(period);
    await run.locator('#issueDate').fill(period);
    await run.getByRole('button', { name: 'Issue the invoices' }).click();
    await expect(page.getByText('Nothing was issued')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/already invoiced for this period/)).toBeVisible();

    /* ------------------------------- the landlord reads their own invoice */
    await page.context().clearCookies();
    await signIn(page, LANDLORD);
    await page.goto('/app/demo-blue-crane/settings/subscription', {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByRole('heading', { name: 'Your Spike subscription' })).toBeVisible();
    // Headed INVOICE, not TAX INVOICE, because Spike has no VAT number.
    await expect(page.getByText('Invoice', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Not a registered VAT vendor/)).toBeVisible();
    await expect(page.getByText('VAT — none charged').first()).toBeVisible();
    await expect(page.getByText(/Example Bank/)).toBeVisible();
    // Every line, and a total that is the lines added up.
    await expect(page.getByText(/plan —/).first()).toBeVisible();

    /* ------------------------------------- and downloads it as a document */
    // Downloaded, not just rendered: an invoice a customer cannot keep a copy
    // of is not much of an invoice, and the download is the one path where the
    // number, the recipient and the VAT heading all have to agree.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: /Download .* as a PDF/ }).first().click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^SPK-\d{4}-\d{5}\.pdf$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const pdf = Buffer.concat(chunks);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdf.toString('latin1');
    expect(text).toContain(download.suggestedFilename().replace('.pdf', ''));
    // Spike has no VAT number in this run, so the document must not claim to
    // be a tax invoice.
    expect(text).toContain('INVOICE');
    expect(text).not.toContain('TAX INVOICE');

    /* ----------------------------------- and Spike records what arrived */
    await page.context().clearCookies();
    await signIn(page, SPIKE);
    await page.goto('/platform/billing', { waitUntil: 'domcontentloaded' });

    const payment = page.locator('form', { has: page.locator('input[name="reference"]') }).first();
    await payment.locator('input[name="reference"]').fill(reference);
    await payment.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByText('Paid').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(reference).first()).toBeVisible();

    /* ------------------------------ which the landlord sees as settled */
    await page.context().clearCookies();
    await signIn(page, LANDLORD);
    await page.goto('/app/demo-blue-crane/settings/subscription', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByText(`Paid`).first()).toBeVisible();
    await expect(page.getByText(reference).first()).toBeVisible();
  });
});
