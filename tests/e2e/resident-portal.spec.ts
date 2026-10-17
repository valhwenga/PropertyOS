import { test, expect } from '@playwright/test';

/**
 * The resident portal, after the design pass.
 *
 * The portal answered "what do I owe" and "what does my lease say". It could
 * not answer the two questions that come between them — how do I pay, and what
 * happened to the thing I reported — and the documents it listed all linked to
 * a route that did not exist, so every one of them answered 404. An operator
 * never sees this page, so the link checker never found it.
 *
 * What the browser proves that the suites beside it cannot: that a resident on
 * a phone can read the whole tenancy without scrolling sideways, that the
 * statement's money columns are on screen rather than off the right-hand edge,
 * and that a shared document actually downloads.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const RESIDENT = 'thandiwe@demo.invalid';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

test.describe('resident portal, on a phone', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(RESIDENT);
    await page.getByLabel('Password').fill(process.env.SEED_PASSWORD ?? 'DemoPassword123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/portal\//, { timeout: 30_000 });
    // The URL changes while the page is still being built on the server, and
    // the loading boundary is on screen until it is not. Reading the text at
    // that moment reads the skeleton, which is a test racing the product
    // rather than checking it.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
  });

  test('answers what is owed, how to pay it, and what happened to the request', async ({ page }) => {
    const text = await visibleText(page);

    /* ------------------------------------------------- 1. what is owed */

    expect(text).toContain('Due now');
    expect(text).toContain('R1,850.00');
    // Evidence sits with the figure it does not change.
    expect(text).toContain('Awaiting verification');
    expect(text).toContain('has not changed yet');
    // The deposit is the resident's money, held separately, and never nets off.
    expect(text).toContain('does not reduce the balance above');

    /* --------------------------------------------------- 2. how to pay */

    expect(text).toContain('How to pay');
    expect(text).toContain('Blue Crane Bank');
    // The reference is the thing that stops a payment sitting in suspense.
    expect(text).toContain('Reference to use');
    expect(text).toContain('LSE-000001');
    // Only the last four digits: the full number is sealed and does not travel
    // to a web page.
    expect(text).toMatch(/•••• \d{4}/);
    expect(text).not.toContain('62000000001');
    // The anti-redirection warning, which is the reason this panel exists.
    expect(text).toContain('do not pay');
    expect(text).toContain('phone your landlord');

    /* ------------------------------------------ 3. what happened to it */

    expect(text).toContain('Your requests');
    expect(text).toContain('shower screen');
    expect(text).toMatch(/Received|Being assessed|Contractor assigned|Work in progress/);
    // A portal ticket is not an emergency service, and says so.
    expect(text).toContain('not an emergency service');

    /* -------------------------------------------------- 4. who to ask */

    expect(text).toContain('Who to contact');
    expect(text).toContain('+27 21 000 0000');
    // The landlord's identity number is on the same database row as these
    // contact fields and must never come with them.
    expect(text).not.toMatch(/\b\d{13}\b/);
  });

  test('puts the statement figures on screen rather than off the edge', async ({ page }) => {
    // The table this replaces is 640px wide at minimum. On a 390px screen the
    // two columns that matter — what it cost and what the balance became —
    // were the two beyond the right-hand edge.
    const text = await visibleText(page);
    expect(text).toContain('Statement');
    for (const figure of ['R1,000.00', 'R8,000.00', 'R350.00', 'R1,850.00']) {
      expect(text, `${figure} is not on the page`).toContain(figure);
    }
    expect(text).toContain('balance');

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, 'the page scrolls sideways on a phone').toBe(false);
  });

  test('downloads a document the landlord shared', async ({ page }) => {
    const link = page.locator('a[href*="/documents/"]').first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');

    // Every one of these answered 404 before: the portal listed documents and
    // linked to a route nobody had built.
    const response = await page.request.get(href!);
    expect(response.status(), `${href} did not resolve`).toBe(200);
    // Deliberately octet-stream and an attachment, whatever the file really
    // is: an uploaded file must never render inside the app's own origin.
    expect(response.headers()['content-type']).toBe('application/octet-stream');
    expect(response.headers()['content-disposition']).toContain('attachment');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('refuses a document that was never shared', async ({ page }) => {
    const link = await page.locator('a[href*="/documents/"]').first().getAttribute('href');
    const base = link!.replace(/[^/]+$/, '');
    // A well-formed id that is not this resident's shared document. The
    // refusal is "not found", never "forbidden": a 403 would confirm that the
    // document exists.
    const response = await page.request.get(`${base}11111111-1111-1111-1111-111111111111`);
    expect(response.status()).toBe(404);
  });
});
