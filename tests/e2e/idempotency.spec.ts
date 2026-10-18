import { test, expect } from '@playwright/test';
import postgres from 'postgres';

/**
 * A second click, through the interface.
 *
 * The integration suite proves the key's four bindings and the concurrent
 * case. What a browser proves is the part that actually happens to people: a
 * resident on a slow connection taps "Send" twice, and their landlord does not
 * end up with two claims to review and a conversation about which one is real.
 *
 * The double submission is done the way a browser does it — the same form, the
 * same hidden key, posted twice without waiting — rather than by calling the
 * action twice from a test.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const RESIDENT = 'thandiwe@demo.invalid';
const PASSWORD = process.env.SEED_PASSWORD ?? 'DemoPassword123!';
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/propertyos_dev';

async function evidenceCount(amountMinor: number): Promise<number> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text from payment_evidence where claimed_amount_minor = ${amountMinor}
    `;
    return Number(row!.count);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.describe('a second click', () => {
  test.describe.configure({ timeout: 180_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only');
  });

  test('submitting proof of payment twice records it once', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(RESIDENT);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/portal\//);

    const lease = new URL(page.url()).pathname.split('/')[2];
    await page.goto(`/portal/${lease}/payments`, { waitUntil: 'domcontentloaded' });

    // A distinctive amount, so the count is about this submission only.
    const cents = 100000 + Math.floor(Math.random() * 89999);
    const amount = (cents / 100).toFixed(2);
    expect(await evidenceCount(cents)).toBe(0);

    await page.getByLabel('How much did you pay?').fill(amount);
    await page.getByLabel('When did you pay?').fill('01/10/2026');
    await page.getByLabel(/Payment reference/).fill('Double tap test');

    // The button disables itself while the first submission is in flight, so a
    // literal second click cannot land — the screen already guards that much.
    // What it cannot guard is the REQUEST arriving twice: a resubmission after
    // a dropped connection, a proxy retry, a restored page. So the submission
    // is intercepted and sent twice, byte for byte, which is precisely the
    // case the key exists for.
    let duplicated = false;
    await page.route(`**/portal/${lease}/payments`, async (route) => {
      if (route.request().method() !== 'POST' || duplicated) return route.continue();
      duplicated = true;
      const first = await route.fetch();
      await route.fetch();
      await route.fulfill({ response: first });
    });

    await page.getByRole('button', { name: 'Record this payment' }).click();

    await expect(page.getByText('Thank you')).toBeVisible({ timeout: 30_000 });
    expect(duplicated, 'the submission was never intercepted').toBe(true);

    // The claim exists once. Without the key this read returned two, and an
    // operator had two identical claims to reconcile against one payment.
    expect(await evidenceCount(cents)).toBe(1);
  });
});
