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
 * a phone can reach every section without scrolling sideways, that the
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
    // the loading boundary is on screen until it is not. The h1 is the
    // LAYOUT's — it is there during loading — so waiting on it waits for
    // nothing. Wait for something only the finished page has.
    await expect(page.getByText('Outstanding balance')).toBeVisible({ timeout: 30_000 });
  });

  test('answers what is owed and how to pay it on the first page', async ({ page }) => {
    const text = await visibleText(page);

    /* ------------------------------------------------- 1. what is owed */

    expect(text).toContain('Outstanding balance');
    expect(text).toContain('R1,850.00');
    // Three measures, not one: the whole receivable is not "due now".
    expect(text).toContain('Overdue');
    expect(text).toContain('Not yet due');
    // Evidence sits with the figure it does not change.
    expect(text).toContain('Bank confirmation pending');
    expect(text).toContain('Bank confirmation is pending');
    // The deposit is the resident's money, held separately, and never nets off.
    expect(text).toContain('Deposit recorded as held');
    expect(text).toContain('not paid to Spike');

    /* --------------------------------------------------- 2. how to pay */

    expect(text).toContain('How to pay');
    expect(text).toContain('Blue Crane Bank');
    // The reference is the thing that stops a payment sitting in suspense.
    expect(text).toContain('Reference to use');
    expect(text).toContain('LSE-000001');
    // Only the last four digits: the full number is sealed and does not travel
    // to a web page.
    expect(text).toMatch(/•••• \d{4}/);
    // The full number is not in the page until it is asked for.
    expect(text).not.toContain('62000000001');
    // The anti-redirection warning, which is the reason this panel exists.
    expect(text).toContain('do not pay');
    expect(text).toContain('phone your landlord');

  });

  test('reaches every section from the bottom bar, and marks where you are', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await expect(nav).toBeVisible();

    /* ------------------------------------------ what happened to it */

    await nav.getByRole('link', { name: 'Maintenance' }).click();
    await page.waitForURL(/\/requests$/, { timeout: 30_000 });
    // The bar marks the section as soon as the URL changes, which is correct
    // and is not the page arriving. Wait for the page.
    await expect(page.getByText('If it cannot wait')).toBeVisible({ timeout: 30_000 });
    await expect(nav.getByRole('link', { name: 'Maintenance' }))
      .toHaveAttribute('aria-current', 'page');
    const requests = await visibleText(page);
    expect(requests).toContain('shower screen');
    expect(requests).toMatch(/Received|Under review|Scheduled|In progress/);
    // A portal ticket is not an emergency service, and says so.
    expect(requests).toContain('not an emergency service');

    /* --------------------------------------------------- who to ask */

    // Lease details lives behind More, with the account actions.
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('link', { name: 'Lease details' }).click();
    await page.waitForURL(/\/lease$/, { timeout: 30_000 });
    await expect(page.getByText('Who to contact')).toBeVisible({ timeout: 30_000 });
    const lease = await visibleText(page);
    expect(lease).toContain('Who to contact');
    expect(lease).toContain('+27 21 000 0000');
    // The landlord's identity number is on the same database row as these
    // contact fields and must never come with them.
    expect(lease).not.toMatch(/\b\d{13}\b/);

    /* ------------------------------- and the form keeps its section */

    await nav.getByRole('link', { name: 'Maintenance' }).click();
    await page.waitForURL(/\/requests$/, { timeout: 30_000 });
    await expect(page.getByText('If it cannot wait')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Report a problem' }).first().click();
    await page.waitForURL(/\/requests\/new$/, { timeout: 30_000 });
    await expect(nav.getByRole('link', { name: 'Maintenance' }))
      .toHaveAttribute('aria-current', 'page');
  });

  test('puts the statement figures on screen rather than off the edge', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Statement' }).click();
    await page.waitForURL(/\/statement$/, { timeout: 30_000 });
    await expect(page.getByText('Closing balance')).toBeVisible({ timeout: 30_000 });

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

  test('gives the PDF the same period as the screen', async ({ page }) => {
    await page.goto(`${page.url().replace(/\/$/, '')}/statement?from=2026-01-01&to=2026-01-31`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByText('Closing balance')).toBeVisible({ timeout: 30_000 });
    const shown = await visibleText(page);
    expect(shown).toContain('01/01/2026 to 31/01/2026');

    // The route used to read only the cut-off, so a resident who chose a
    // period and then downloaded got a different document from the one they
    // were looking at.
    const href = await page.getByRole('link', { name: 'Download PDF' }).getAttribute('href');
    expect(href).toContain('from=2026-01-01');
    expect(href).toContain('cutOff=2026-01-31');

    const pdf = await page.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('pdf');
    // The cut-off is in the file's own name, so two downloads are not two
    // files called the same thing.
    expect(pdf.headers()['content-disposition']).toContain('2026-01-31');
  });

  test('downloads a document the landlord shared', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Documents' }).click();
    await page.waitForURL(/\/documents$/, { timeout: 30_000 });
    const link = page.locator('main a[href*="/documents/"]').first();
    await expect(link).toBeVisible({ timeout: 30_000 });
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
    await page.goto(page.url().replace(/\/?$/, '') + '/documents', {
      waitUntil: 'domcontentloaded',
    });
    const link = await page.locator('a[href*="/documents/"]').first().getAttribute('href');
    const base = link!.replace(/[^/]+$/, '');
    // A well-formed id that is not this resident's shared document. The
    // refusal is "not found", never "forbidden": a 403 would confirm that the
    // document exists.
    const response = await page.request.get(`${base}11111111-1111-1111-1111-111111111111`);
    expect(response.status()).toBe(404);
  });
});

/**
 * The checks that are about the shape of the thing rather than its content.
 *
 * Every width a South African resident is likely to hold: 360 is the floor
 * this product has always been built to, 390 is an iPhone, 430 is the large
 * one. A fixed bottom bar makes two new ways to fail — content underneath it,
 * and a page that scrolls sideways because the bar does.
 */
test.describe('the portal at the sizes people hold', () => {
  test.describe.configure({ timeout: 300_000 });

  for (const width of [360, 390, 430]) {
    test(`fits, and hides nothing behind the bar, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      await page.goto('/sign-in');
      await page.getByLabel('Email address').fill(RESIDENT);
      await page.getByLabel('Password').fill(process.env.SEED_PASSWORD ?? 'DemoPassword123!');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(/\/portal\//, { timeout: 30_000 });
      await expect(page.getByText('Outstanding balance')).toBeVisible({ timeout: 30_000 });
      const base = page.url().split('?')[0]!;

      const sections = [
        ['', 'Outstanding balance'],
        ['/statement', 'Closing balance'],
        ['/requests', 'If it cannot wait'],
        ['/documents', 'Your documents'],
        // Not "Lease details" — that is also the sidebar link, which is
        // hidden at these widths, and `.first()` would wait for it forever.
        ['/lease', 'Notice to end the lease'],
      ] as const;

      for (const [path, marker] of sections) {
        await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30_000 });

        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        expect(overflows, `${path || '/'} scrolls sideways at ${width}px`).toBe(false);

        // Scroll to the bottom and check the last thing on the page is above
        // the bar. A submit button under a fixed bar is unreachable.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(150);
        const clear = await page.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="Sections"]');
          const footer = document.querySelector('footer');
          if (!nav || !footer) return true;
          return footer.getBoundingClientRect().bottom <= nav.getBoundingClientRect().top + 1;
        });
        expect(clear, `${path || '/'} has content under the bar at ${width}px`).toBe(true);
      }
    });
  }

  test('shows the full account number only when asked, and copies it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(RESIDENT);
    await page.getByLabel('Password').fill(process.env.SEED_PASSWORD ?? 'DemoPassword123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/portal\//, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });

    // Not in the page as served.
    expect(await visibleText(page)).not.toContain('62000000001');

    await page.getByRole('button', { name: 'Show the full number' }).click();
    await expect(page.getByText('62000000001')).toBeVisible({ timeout: 30_000 });

    // And the copy control reports what happened, in a live region as well as
    // on its face.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: /Copy payment reference/ }).click();
    await expect(page.getByRole('button', { name: /Copied/ })).toBeVisible();
  });

  test('keeps the keyboard able to reach the sections', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(RESIDENT);
    await page.getByLabel('Password').fill(process.env.SEED_PASSWORD ?? 'DemoPassword123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/portal\//, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });

    const statement = page.getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Statement' });

    // Tab to it rather than calling focus(): `:focus-visible` is the
    // browser's judgement about whether the focus came from a keyboard, and
    // programmatic focus does not qualify. A test that uses focus() would
    // report "no ring" on a page that rings perfectly well for a person.
    await page.keyboard.press('Tab');
    for (let i = 0; i < 40 && !(await statement.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(statement).toBeFocused();
    const outline = await statement.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline, 'the section link has no visible focus ring').not.toBe('none');
  });
});
