import { deflateSync } from 'node:zlib';
import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Making the product look like the landlord's own.
 *
 * Three claims a browser is the only place to settle. That choosing an accent
 * actually repaints the console rather than only writing a row. That a logo
 * an administrator uploads is the thing that appears in the sidebar. And that
 * a file which is not an image is refused with a reason, not stored and then
 * served to every resident.
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

/** A real 48×48 PNG, built here so the test carries no binary fixture. */
function pngBytes(): Buffer {
  const header = Buffer.alloc(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(48, 16);
  header.writeUInt32BE(48, 20);
  return header;
}

/**
 * A COMPLETE 16×16 PNG — signature, IHDR, a deflated IDAT and IEND.
 *
 * `pngBytes` above is a header only, which is all the upload validator reads.
 * The PDF writer has to decode the whole file, so a statement can only carry a
 * real one.
 */
function wholePngBytes(): Buffer {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  // 16 is the smallest side the uploader accepts, so this is the smallest
  // whole file that is also a legitimate logo.
  const size = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour
  // Each scanline is a filter byte (0: no prediction) then RGB triples.
  const raw = Buffer.concat(Array.from({ length: size }, (_, row) => Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: size }, (_, column) => Buffer.from(
      (row + column) % 2 === 0 ? [20, 90, 60] : [240, 240, 240],
    )),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A real PNG of any size, in two solid bands so it compresses small.
 *
 * The point of the test is the DIMENSIONS, so the pixels themselves are as
 * cheap as possible: a 3000x1200 image is 10MB raw and a few hundred bytes
 * deflated.
 */
function hugePngBytes(width: number, height: number): Buffer {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour
  const raw = Buffer.concat(Array.from({ length: height }, (_, row) => Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3, row < height / 2 ? 31 : 240),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.describe('appearance', () => {
  test.describe.configure({ timeout: 240_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('an administrator sets the accent, uploads a logo, and is refused a script', async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    await page.goto(`${org}/settings/appearance`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();

    /* ------------------------------------------- 1. the accent is applied */

    await page.getByRole('radio', { name: /Ocean/ }).check({ force: true });
    await page.getByRole('button', { name: 'Save appearance' }).click();
    await expect(page.getByText(/Saved\./).first()).toBeVisible({ timeout: 30_000 });

    // The console itself, not the form: the shell carries the chosen accent on
    // every page, which is what makes a primary button change colour.
    await page.goto(`${org}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-brand="ocean"]').first()).toBeVisible({ timeout: 30_000 });

    /* ----------------------------------------------- 2. a logo, and only a logo */

    await page.goto(`${org}/settings/appearance`, { waitUntil: 'domcontentloaded' });

    // A script dressed as a PNG. The name and the content type both claim an
    // image; the bytes do not, and the bytes are what decides.
    await page.setInputFiles('#logo', {
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByText(/not a PNG or a JPEG/)).toBeVisible({ timeout: 30_000 });
    expect(await visibleText(page)).toContain('SVG is not accepted');

    await page.setInputFiles('#logo', {
      name: 'brand.png', mimeType: 'image/png', buffer: pngBytes(),
    });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByAltText(/logo as it appears/)).toBeVisible({ timeout: 30_000 });

    // And it is served: the sidebar on the next page shows the uploaded file
    // rather than the Spike wordmark.
    await page.goto(`${org}`, { waitUntil: 'domcontentloaded' });
    const logo = page.locator('aside img').first();
    await expect(logo).toBeVisible({ timeout: 30_000 });
    const served = await page.request.get(`${org}/brand-logo`);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toContain('image/png');
    // Never rendered as a document, whatever got through.
    expect(served.headers()['x-content-type-options']).toBe('nosniff');

    /* -------------------------------------------------- 3. put it back */

    await page.goto(`${org}/settings/appearance`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Remove logo' }).click();
    await expect(page.getByText(/No logo yet/)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('radio', { name: /Spike purple/ }).check({ force: true });
    await page.getByRole('button', { name: 'Save appearance' }).click();
    await expect(page.getByText(/Saved\./).first()).toBeVisible({ timeout: 30_000 });
  });

  test('the brand reaches the tab, the statement and the landlord’s sign-in page', async ({
    page, browser,
  }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();
    const slug = org!.replace('/app/', '');

    await page.goto(`${org}/settings/appearance`, { waitUntil: 'domcontentloaded' });
    await page.setInputFiles('#logo', {
      name: 'whole.png', mimeType: 'image/png', buffer: wholePngBytes(),
    });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByAltText(/logo as it appears/)).toBeVisible({ timeout: 30_000 });

    /* --------------------------------------------------- 1. the browser tab */

    // The tab, the bookmark and the history entry say whose console this is —
    // on the overview, which states its own title, and on a page further in,
    // which inherits the organisation's template.
    await page.goto(`${org}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveTitle(/Spike PropertyOS/);
    await expect(page).toHaveTitle(/Blue Crane/);
    const icon = await page.locator('link[rel~="icon"]').first().getAttribute('href');
    expect(icon).toContain(`/app/${slug}/brand-logo`);

    await page.goto(`${org}/leases`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveTitle(/Spike PropertyOS/);

    /* ------------------------------------- 2. the logo is IN the statement PDF */

    await page.goto(`${org}/leases`, { waitUntil: 'domcontentloaded' });
    // A lease's own page, by id — not "new", not a filter link.
    const leaseHref = await page.locator('a[href*="/leases/"]').evaluateAll((links) =>
      links.map((l) => (l as HTMLAnchorElement).getAttribute('href') ?? '')
        .find((href) => /\/leases\/[0-9a-f-]{36}$/.test(href)) ?? null);
    expect(leaseHref, 'the demo has at least one lease to draw a statement for').toBeTruthy();
    const pdf = await page.request.get(`${leaseHref}/statement.pdf`);
    expect(pdf.status()).toBe(200);
    const body = (await pdf.body()).toString('latin1');
    // An embedded image object the page actually draws — not merely a file
    // that opens.
    expect(body).toContain('/Subtype /Image');
    expect(body).toContain('/Im1 Do');
    // And the attribution is one small line rather than the mark at the top.
    expect(body).toContain('Prepared with Spike PropertyOS');

    /* ----------------------------------- 3. their own sign-in page, signed out */

    // A brand new context: no session, no storage, nothing carried over. This
    // is the page a member of their staff reaches before signing in.
    const anonymous = await browser.newContext();
    const fresh = await anonymous.newPage();
    await fresh.goto(`/sign-in/${slug}`, { waitUntil: 'domcontentloaded' });
    await expect(fresh.locator(`img[src="/sign-in/${slug}/brand-logo"]`))
      .toBeVisible({ timeout: 30_000 });
    await expect(fresh.getByLabel('Email')).toBeVisible();
    // Served without a session, and still never renderable as a document.
    const served = await fresh.request.get(`/sign-in/${slug}/brand-logo`);
    expect(served.status()).toBe(200);
    expect(served.headers()['x-content-type-options']).toBe('nosniff');

    // A slug that matches nothing is the plain page, not an error: the URL
    // cannot be used to find out who uses this product.
    await fresh.goto('/sign-in/not-a-customer', { waitUntil: 'domcontentloaded' });
    await expect(fresh.getByLabel('Email')).toBeVisible();
    expect(await visibleText(fresh)).toContain('Spike');
    await anonymous.close();

    /* ------------------------------------------------------ 4. put it back */

    await page.goto(`${org}/settings/appearance`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Remove logo' }).click();
    await expect(page.getByText(/No logo yet/)).toBeVisible({ timeout: 30_000 });
  });

  test('the theme choice is saved against the account, not the browser', async ({ page }) => {
    await signIn(page, 'thandiwe@demo.invalid');
    await page.goto('/account', { waitUntil: 'domcontentloaded' });

    await page.getByRole('radio', { name: 'Dark' }).check();
    await page.getByRole('button', { name: 'Save for my account' }).click();
    await expect(page.getByText(/follow you to your next device/)).toBeVisible({
      timeout: 30_000,
    });

    // A different browser session entirely — no localStorage, nothing carried
    // over but the account. The server renders the saved theme itself.
    const fresh = await page.context().newPage();
    await fresh.goto('/portal', { waitUntil: 'domcontentloaded' });
    await expect(fresh.locator('html')).toHaveAttribute('data-theme', 'dark');
    await fresh.close();

    // Left as it was found, so the rest of the suite sees the light theme.
    await page.goto('/account', { waitUntil: 'domcontentloaded' });
    await page.getByRole('radio', { name: 'Follow my device' }).check();
    await page.getByRole('button', { name: 'Save for my account' }).click();
    await expect(page.getByText(/follow you to your next device/)).toBeVisible({
      timeout: 30_000,
    });
  });

  test('a large logo is fitted by the browser rather than refused', async ({ page }) => {
    // The complaint this answers: the product refused anything over 1024px and
    // left the landlord to go and shrink it in an image editor they do not
    // have open. A 3000x1200 brand asset is an ordinary thing to be handed.
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');

    await page.goto(`${org}/settings/appearance`, { waitUntil: 'domcontentloaded' });
    await page.setInputFiles('#logo', {
      name: 'enormous-brand-asset.png',
      mimeType: 'image/png',
      buffer: hugePngBytes(3000, 1200),
    });

    // The browser says what it did, in words, before anything is sent.
    await expect(page.getByText(/Resized from 3000×1200 to 1024×410/))
      .toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByAltText(/logo as it appears/)).toBeVisible({ timeout: 30_000 });

    // Stored at the fitted size, with the proportions intact: 3000/1200 = 2.5,
    // and 1024/410 is the same ratio to within half a pixel.
    await expect(page.getByText('1024×410 pixels')).toBeVisible({ timeout: 30_000 });

    // Put it back.
    await page.getByRole('button', { name: 'Remove logo' }).click();
    await expect(page.getByText(/No logo yet/)).toBeVisible({ timeout: 30_000 });
  });
});
