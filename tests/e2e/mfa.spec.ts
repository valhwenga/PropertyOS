import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { generateCode, timeStep } from '@propertyos/integrations';
import { signIn } from './sign-in';

/**
 * Setting up a second factor, and getting back in without the phone.
 *
 * The assurance machinery has existed since 0015 and there was no way for a
 * person to enrol: the only path was `pnpm db:mfa enrol`, run against the
 * database. So a colleague invited as a finance approver could sign in,
 * correctly see almost nothing, and have no way out of that state.
 *
 * What the browser proves that the integration suite cannot: that somebody who
 * has just joined can go from "I can see nothing" to a working second factor
 * without anybody touching the database, that they leave with recovery codes
 * in hand, and that one of those codes actually gets them back in afterwards.
 *
 * The colleague here is created by accepting a real invitation, so this also
 * exercises the state a new member genuinely lands in.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const ADMIN = 'admin@demo.invalid';
const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/propertyos_dev';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

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

/**
 * A code from a window nothing has spent.
 *
 * The authenticator app is the one thing a browser cannot be: this stands in
 * for it, deriving the code from the secret the screen displayed — which is
 * exactly what the app would do with the same secret.
 */
async function codeFor(secret: string, email: string): Promise<string> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const base = timeStep();
    for (let offset = 0; offset < 60; offset += 1) {
      const step = base + offset;
      const [used] = await sql<{ time_step: string }[]>`
        select c.time_step::text from auth_mfa_used_codes c
        join auth.users u on u.id = c.auth_user_id
        where u.email = ${email} and c.time_step = ${step}
      `;
      if (!used) return generateCode(secret, step);
    }
    throw new Error('no unused time step found');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.describe('second factor', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('a new colleague enrols, then signs in with a recovery code', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    const stamp = String(Date.now()).slice(-6);
    const email = `approver.${stamp}@demo.invalid`;
    const password = `ApproverPassword${stamp}!`;

    /* ----------------------- 1. invite an approver, who needs a second factor */

    await page.goto(`${org}/settings/staff`, { waitUntil: 'domcontentloaded' });
    await reveal(page, 'Invite a colleague', page.getByLabel('Their email'));
    await page.getByLabel('Their name').fill(`App Rover ${stamp}`);
    await page.getByLabel('Their email').fill(email);
    await page.getByLabel(/Finance approver/).check();
    await page.getByRole('button', { name: 'Create the invitation' }).click();

    await expect(page.getByText(`Invitation ready for ${email}`))
      .toBeVisible({ timeout: 30_000 });
    const link = (await page.locator('p.font-mono').first().innerText()).trim();

    /* --------------------------------------------- 2. they join and see little */

    const context = await page.context().browser()!.newContext();
    const joiner = await context.newPage();
    await joiner.goto(link, { waitUntil: 'domcontentloaded' });
    await joiner.getByLabel('Choose a password').fill(password);
    await joiner.getByLabel('The same password again').fill(password);
    await joiner.getByRole('button', { name: /^Join / }).click();
    await joiner.waitForURL(/\/app\//, { timeout: 30_000 });

    await joiner.goto('/account/security', { waitUntil: 'domcontentloaded' });
    const before = await visibleText(joiner);
    // The state enrolment exists to fix, stated on the screen.
    expect(before).toContain('password only');
    expect(before).toContain('you can sign in and will see very little');
    // And nobody else can do it for them.
    expect(before).toContain('not another administrator, and not Spike');

    /* ------------------------------------------------------- 3. they enrol */

    await joiner.getByRole('button', { name: 'Start setting one up' }).click();
    await expect(joiner.getByText('Add this to your authenticator app'))
      .toBeVisible({ timeout: 30_000 });

    const secret = (await joiner.locator('p.font-mono').first().innerText())
      .replace(/\s/g, '');
    expect(secret.length).toBeGreaterThan(20);

    const enrolling = await visibleText(joiner);
    // Honest about the absence of a QR code rather than silent about it.
    expect(enrolling).toContain('There is no QR code to scan');

    // A wrong code switches nothing on, and does not lose the secret.
    await joiner.getByLabel(/6-digit code/).fill('000000');
    await joiner.getByRole('button', { name: 'Confirm and switch it on' }).click();
    await expect(joiner.getByText('Not confirmed')).toBeVisible({ timeout: 30_000 });
    const afterBadCode = (await joiner.locator('p.font-mono').first().innerText())
      .replace(/\s/g, '');
    expect(afterBadCode).toBe(secret);

    await joiner.getByLabel(/6-digit code/).fill(await codeFor(secret, email));
    await joiner.getByRole('button', { name: 'Confirm and switch it on' }).click();

    // Waiting for the success marker alone, not for "success or failure".
    // The failure marker is already on screen from the deliberate bad code
    // above, so an "or" would match it instantly and report a refusal while
    // the real attempt was still in flight — which is exactly what it did.
    await expect(joiner.getByText('Your recovery codes — save them now'))
      .toBeVisible({ timeout: 30_000 });

    /* --------------------------- 4. the recovery codes arrive with enrolment */

    const codes = await joiner.locator('ul.font-mono li').allInnerTexts();
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const withCodes = await visibleText(joiner);
    // Why they matter, where they will not be shown again, and who cannot help.
    expect(withCodes).toContain('shown once');
    expect(withCodes).toContain('nobody at Spike can reset your authenticator');

    /* -------------------- 5. the authenticator works, and raises the session */

    // Clearing the cookie is the whole of signing out here: the session is a
    // signed cookie and nothing server-side holds it. `/sign-out` is POST only
    // — a GET that ends a session is a request any page could forge.
    await joiner.context().clearCookies();
    await joiner.goto('/sign-in', { waitUntil: 'domcontentloaded' });
    await joiner.getByLabel('Email address').fill(email);
    await joiner.getByLabel('Password').fill(password);
    await joiner.getByRole('button', { name: 'Sign in' }).click();

    await expect(joiner.getByLabel('Authentication code')).toBeVisible({ timeout: 30_000 });
    // The password has to go in again: the browser clears it between the two
    // steps and the field is required, so an empty one silently stops the
    // form. That is what the second-step wording now warns about.
    await joiner.getByLabel('Password, again').fill(password);
    await joiner.getByLabel('Authentication code').fill(await codeFor(secret, email));
    await joiner.getByRole('button', { name: 'Verify and sign in' }).click();
    await joiner.waitForURL(/\/(app|portal)/, { timeout: 30_000 });

    await joiner.goto('/account/security', { waitUntil: 'domcontentloaded' });
    const enrolled = await visibleText(joiner);
    expect(enrolled).toContain('two factors');
    expect(enrolled).toContain('10 recovery codes left');

    /* ------------------------------ 6. and a recovery code gets them back in */

    // Clearing the cookie is the whole of signing out here: the session is a
    // signed cookie and nothing server-side holds it. `/sign-out` is POST only
    // — a GET that ends a session is a request any page could forge.
    await joiner.context().clearCookies();
    await joiner.goto('/sign-in', { waitUntil: 'domcontentloaded' });
    await joiner.getByLabel('Email address').fill(email);
    await joiner.getByLabel('Password').fill(password);
    await joiner.getByRole('button', { name: 'Sign in' }).click();
    await expect(joiner.getByLabel('Authentication code')).toBeVisible({ timeout: 30_000 });

    await joiner.getByRole('button', { name: 'I cannot reach my authenticator app' }).click();
    const recoveryField = joiner.getByLabel('Recovery code');
    await expect(recoveryField).toBeVisible();
    await joiner.getByLabel('Password, again').fill(password);
    // The cost is stated before it is spent.
    expect(await visibleText(joiner)).toContain('used once and then gone');

    await recoveryField.fill(codes[0]!);
    await joiner.getByRole('button', { name: 'Verify and sign in' }).click();

    // Straight to the security page, because the reason to be here is a phone
    // that is gone.
    await joiner.waitForURL(/\/account\/security/, { timeout: 30_000 });
    const recovered = await visibleText(joiner);
    expect(recovered).toContain('that code is now spent');
    expect(recovered).toContain('9 recovery codes left');
    // A recovery code is a full second factor: otherwise they could not enrol
    // a replacement.
    expect(recovered).toContain('two factors');

    /* --------------------------------- 7. the same code does not work twice */

    // Clearing the cookie is the whole of signing out here: the session is a
    // signed cookie and nothing server-side holds it. `/sign-out` is POST only
    // — a GET that ends a session is a request any page could forge.
    await joiner.context().clearCookies();
    await joiner.goto('/sign-in', { waitUntil: 'domcontentloaded' });
    await joiner.getByLabel('Email address').fill(email);
    await joiner.getByLabel('Password').fill(password);
    await joiner.getByRole('button', { name: 'Sign in' }).click();
    await expect(joiner.getByLabel('Authentication code')).toBeVisible({ timeout: 30_000 });
    await joiner.getByRole('button', { name: 'I cannot reach my authenticator app' }).click();
    await joiner.getByLabel('Password, again').fill(password);
    await joiner.getByLabel('Recovery code').fill(codes[0]!);
    await joiner.getByRole('button', { name: 'Verify and sign in' }).click();

    await expect(joiner.getByText('already been used')).toBeVisible({ timeout: 30_000 });
    await context.close();
  });
});
