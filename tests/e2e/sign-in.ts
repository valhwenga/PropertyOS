import postgres from 'postgres';
import { generateCode } from '@propertyos/integrations';

/**
 * Signing in, including the second factor.
 *
 * Shared because three specs need it and a second copy had already started to
 * drift. The TOTP handling is the fiddly part: a code is valid for one 30-second
 * window and for exactly one use, so the helper waits for a fresh window rather
 * than racing the one it found.
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

/**
 * A code from a window this account has definitely not used yet.
 *
 * `freshCode` only waits when the current window is nearly over, which is right
 * for signing in. It is wrong immediately AFTER signing in: that sign-in just
 * consumed this window's code, and a code is single-use, so re-verifying with
 * it is correctly refused. Anything that re-authenticates in the same test has
 * to wait for the next window.
 */
export async function unusedCode(email: string): Promise<string> {
  await waitForNextWindow();
  return currentCode(email);
}

export async function freshCode(email: string): Promise<string> {
  if (secondsLeftInWindow() < 5) await waitForNextWindow();
  return currentCode(email);
}

/**
 * Signs in, completing the second factor only when one is actually demanded.
 * Which accounts have a factor enrolled is exactly the sort of thing that
 * drifts, so this detects it rather than assuming it.
 */
export async function signIn(page: import('@playwright/test').Page, email: string): Promise<void> {
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
