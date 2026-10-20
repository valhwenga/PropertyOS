import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Telling a resident what they owe.
 *
 * What only a browser can settle here: that a landlord can write the message
 * in their own words, mark a month's invoices ready, send them in one action,
 * and then be told the truth about what happened to each one. This deployment
 * has no email provider, so the truth is that nothing was delivered — and the
 * screen has to say exactly that rather than show a tick.
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

test.describe('sending invoices', () => {
  test.describe.configure({ timeout: 600_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a month is marked ready, sent, and reported honestly', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* ------------------------------------------- 1. the message is the landlord's */

    await page.goto(`${org}/settings/messages`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Message to residents' })).toBeVisible();

    // A field the product does not fill in is refused rather than sent with
    // the braces showing.
    await page.getByRole('textbox', { name: 'Message' }).fill('Dear {{tenant.name}}, you owe {{invoice.total}}.');
    await page.getByRole('button', { name: 'Save this message' }).click();
    await expect(page.getByText('Not saved')).toBeVisible({ timeout: 30_000 });
    expect(await visibleText(page)).toContain('does not fill in');

    const marker = `Reference ${String(Date.now()).slice(-5)}`;
    await page.getByRole('textbox', { name: 'Message' }).fill(
      `Dear {{resident.first_name}},\n\n${marker}\n\nYour invoice {{invoice.number}} for `
      + '{{invoice.period}} comes to {{invoice.total}}, due {{invoice.due_date}}.\n\n'
      + 'See your statement at {{portal.link}}\n\n{{landlord.name}}',
    );
    await page.getByRole('button', { name: 'Save this message' }).click();
    await expect(page.getByText(/applies to invoices sent from now on/))
      .toBeVisible({ timeout: 30_000 });

    // The preview shows it filled in, so nobody saves a message they have not read.
    expect(await visibleText(page)).toContain('Thandiwe');

    /* --------------------------------------------- 2. the invoices for a month */

    await page.goto(`${org}/billing/invoices`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Sending invoices' })).toBeVisible();

    // Whatever the demo holds, the screen is explicit that nothing is sent yet
    // and that only posted invoices can be.
    const opened = await visibleText(page);
    expect(opened).toContain('Only a posted invoice can be sent');

    // A previous run of this spec may have left these sent or undelivered,
    // which is a fine state to continue from: an undelivered invoice is meant
    // to be sendable again once somebody has fixed the reason.
    const retry = page.getByRole('button', { name: 'Try again' });
    while (await retry.count() > 0) {
      await retry.first().click();
      await page.waitForTimeout(1_500);
    }

    if (await page.locator('input[type="checkbox"][name="documentId"]').count() > 0) {
      await page.getByRole('button', { name: /^Select all/ }).click();
      await page.getByRole('button', { name: /^Mark \d+ ready to send$/ }).click();
      await expect(page.getByText(/marked ready/i)).toBeVisible({ timeout: 30_000 });
      expect(await visibleText(page)).toContain('Nothing has been sent yet');
    }
    await expect(page.getByRole('button', { name: /^Send all \d+ ready invoice/ }))
      .toBeVisible({ timeout: 30_000 });

    /* ------------------------------------------------- 3. the dashboard knows */

    await page.goto(`${org}`, { waitUntil: 'domcontentloaded' });
    const overview = page.locator('#main');
    await expect(overview.getByText('Invoices ready to send')).toBeVisible({ timeout: 60_000 });

    await overview.getByText('Invoices ready to send').click();
    await page.waitForURL(/billing\/invoices/, { timeout: 30_000 });

    /* ----------------------------------------------------- 4. send them all */

    await page.getByRole('button', { name: /^Send all \d+ ready invoice/ }).click();
    const confirm = await visibleText(page);
    expect(confirm).toContain('There is no unsending');
    // The deployment's actual capability, said before the click rather than
    // discovered afterwards.
    expect(confirm).toContain('No email provider is configured');

    await page.getByRole('button', { name: 'Yes, send them' }).click();
    await expect(page.getByText(/queued for sending|Nothing was queued/))
      .toBeVisible({ timeout: 60_000 });

    /* ------------------------------- 5. and the outcome is reported truthfully */

    // The worker picks the messages up; whatever it finds, the screen must
    // never claim delivery. Poll for the state to settle.
    let settled = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.goto(`${org}/billing/invoices`, { waitUntil: 'domcontentloaded' });
      settled = await visibleText(page);
      if (settled.includes('Not delivered') || settled.includes('Nobody to send to')) break;
      await page.waitForTimeout(3_000);
    }
    expect(settled).toMatch(/Not delivered|Nobody to send to/);
    expect(settled).not.toContain('The provider accepted it');
  });
});
