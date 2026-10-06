import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { generateCode } from '@propertyos/integrations';

/**
 * Smoke checks for a local preview.
 *
 * These answer one question: is the preview this developer just started actually
 * usable, or does it merely render? A preview that signs you in and then shows
 * nothing — which is what happens when no second factor is enrolled, because
 * elevated roles are MFA-gated inside `app.has_permission` — looks broken, and
 * the failure is silent. So the operator path is walked all the way to a figure
 * on the page, and tenant isolation is checked while we are here.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 *
 * Run with:
 *   pnpm preview:check
 */

const PASSWORD = process.env.SEED_PASSWORD ?? 'DemoPassword123!';
const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/propertyos_dev';

/**
 * Reads the account's TOTP secret and derives the current code in process.
 *
 * Deliberately not a subprocess: `execFileSync` blocks Node's event loop, so a
 * slow or stuck child stops Playwright's own timeouts from firing and the test
 * hangs instead of failing. This is also the same code path the server verifies
 * with, so the test is not reimplementing TOTP.
 */
async function currentCode(email: string): Promise<string> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [factor] = await sql<{ secret: string }[]>`
      select f.secret
      from auth_mfa_factors f
      join auth.users u on u.id = f.auth_user_id
      where u.email = ${email} and f.factor_type = 'totp' and f.verified_at is not null
    `;
    if (!factor) throw new Error(`${email} has no verified TOTP factor; run: pnpm db:mfa enrol ${email}`);
    return generateCode(factor.secret);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Seconds left in the current 30-second TOTP window.
 *
 * A code read near the end of a window can expire before it is submitted, which
 * looks exactly like a broken preview. Waiting for a fresh window first makes
 * this deterministic rather than timing-dependent.
 */
function secondsLeftInWindow(): number {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

async function waitForNextWindow(): Promise<void> {
  await new Promise((r) => setTimeout(r, (secondsLeftInWindow() + 1) * 1000));
}

async function freshCode(email: string): Promise<string> {
  if (secondsLeftInWindow() < 5) await waitForNextWindow();
  return currentCode(email);
}

/**
 * Signs in, completing the second factor only when one is actually demanded.
 * Which accounts have a factor enrolled is exactly the sort of thing that
 * drifts, so this detects it rather than assuming it.
 */
async function signIn(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Either we are through, or a code is being asked for. Poll for whichever
  // happens first: a fixed delay here would eat into the 30-second window the
  // code then has to be used in.
  const codeField = page.getByLabel('Authentication code');
  const onSignInPage = () => new URL(page.url()).pathname.startsWith('/sign-in');
  const firstRoundDeadline = Date.now() + 20_000;
  while (Date.now() < firstRoundDeadline) {
    if (!onSignInPage()) return;
    if (await codeField.isVisible().catch(() => false)) break;
    await page.waitForTimeout(200);
  }
  if (!onSignInPage()) return;
  if (!(await codeField.isVisible().catch(() => false))) {
    throw new Error(`sign-in as ${email} failed and no second factor was requested`);
  }

  // Poll only for success, and consult the error banner only once that has
  // timed out.
  //
  // Racing the two is what kept breaking this. A refused attempt leaves its
  // banner on screen, so the next attempt sees a stale "Could not sign in" the
  // instant it starts — before its own navigation has landed — reads that as a
  // fresh refusal, and goes round again against a page that has in fact signed
  // in. Success is unambiguous and arrives in about a second; a banner is only
  // meaningful when success has not come at all.
  const signedIn = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!onSignInPage()) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };

  // Two attempts, not three: a code is single-use, so a run following a recent
  // sign-in as this account within the same 30-second window is handed a spent
  // one and the server is right to refuse it. Waiting out the window fixes that
  // case. A second refusal is not a timing problem and should surface.
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.getByLabel('Password').fill(PASSWORD);
    await codeField.fill(await freshCode(email));
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    if (await signedIn(15_000)) return;
    if (attempt < 2) await waitForNextWindow();
  }
  const detail = (await page.textContent('body'))?.match(/Could not sign in.{0,120}/s);
  throw new Error(
    `could not complete the second factor for ${email} in two attempts` +
      (detail ? `: ${detail[0].replace(/\s+/g, ' ')}` : ''),
  );
}

test.describe('local preview', () => {
  // Completing a second factor can need to wait out a 30-second TOTP window
  // before retrying, which does not fit the default 30-second budget.
  test.describe.configure({ timeout: 120_000 });

  // One project only. These checks ask whether the preview works at all, which
  // is not device-specific — and a TOTP code is good for exactly one sign-in, so
  // running the same account twice inside one 30-second window would have the
  // second run rejected as a replay. Device coverage lives in portal.spec.ts.
  // An empty pattern is Playwright's documented way to take no fixtures while
  // still reading testInfo, so the rule is wrong here rather than the code.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'preview checks run on one project only');
  });

  // Warm the server-action path before any test spends a one-time code.
  //
  // The first sign-in against a freshly started server is markedly slower than
  // the rest — enough to outlast a 30-second TOTP window. Paying that cost here,
  // with an account that needs no second factor, means the operator test is not
  // racing initialisation with the lifetime of its code. It is also why this
  // cannot simply be the first test: whichever test ran first would pay it.
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await signIn(page, 'thandiwe@demo.invalid');
    } finally {
      await page.close();
    }
  });

  test('the landlord operator gets past the second factor and sees real figures', async ({ page }) => {
    await signIn(page, 'admin@demo.invalid');
    await page.goto('/app');

    // Demo data is labelled, so its presence is also proof we are not looking at
    // anything real.
    await expect(page.getByText(/\[DEMO\]/).first()).toBeVisible();

    // The organisation name is not itself the link, so follow the first link
    // into an organisation rather than guessing at its accessible name.
    await page.locator('a[href^="/app/"]').first().click();

    // Asserting on the content rather than waiting for 'networkidle': the console
    // keeps connections open, so network idle never arrives and the wait times
    // out even though the page rendered. The assertion below retries on its own.
    //
    // An MFA-gated account with no factor reaches this page and sees nothing. A
    // rendered amount is what distinguishes a working preview from that.
    await expect(page.getByText(/R[\d  ,]+\.\d\d/).first()).toBeVisible({ timeout: 20_000 });
  });

  test("the resident sees the blueprint's closing balance", async ({ page }) => {
    await signIn(page, 'thandiwe@demo.invalid');
    await page.goto('/portal');
    await expect(page.getByText('R1,850.00').first()).toBeVisible();
  });

  test('the second landlord sees none of the first landlord’s portfolio', async ({ page }) => {
    await signIn(page, 'other-admin@demo.invalid');
    await page.goto('/app');
    await expect(page.getByText('[DEMO] Karoo Letting').first()).toBeVisible();
    await expect(page.getByText('[DEMO] Blue Crane Rentals')).toHaveCount(0);
  });

  test('healthz reports the database and tenant isolation', async ({ request }) => {
    const response = await request.get('/healthz');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'healthy',
      checks: { database: 'ok', tenantIsolation: 'ok' },
    });
  });
});
