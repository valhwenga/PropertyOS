import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Approvals that act, through the interface — with two different people.
 *
 * The queue listed four kinds of work and could resolve one of them. The
 * deposit section read `deposit_events` where `approved_at is null`, a row the
 * database forbids outright, so it could never show anything; and there was no
 * way for one person to prepare a payout for another to approve, which is the
 * entire point of having two permissions. Maintenance quotations had no
 * approval interface anywhere in the product.
 *
 * This is the one test that cannot be done with a single sign-in: the rule
 * under test is that the person who asks is not the person who decides, and
 * proving it needs both of them. The operator raises a deduction and is
 * refused the approval of their own request; the finance approver then approves
 * it, and only then does the deposit balance fall.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const OPERATOR = 'admin@demo.invalid';
const APPROVER = 'finance@demo.invalid';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('body').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, style, template, noscript').forEach((n) => n.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

/** The "Held now" figure on a deposit page, in minor units. */
async function heldNow(page: import('@playwright/test').Page): Promise<number> {
  const text = await page.locator('dt', { hasText: 'Held now' })
    .locator('xpath=following-sibling::dd[1]').first().innerText();
  const match = text.match(/([\d,]+\.\d{2})/);
  if (!match) throw new Error(`could not read the held amount from "${text}"`);
  return Math.round(Number(match[1]!.replace(/,/g, '')) * 100);
}

/**
 * Clicks a button that reveals a form, and waits for the form.
 *
 * A click that lands before React has hydrated does nothing at all, which
 * presents as the revealed field never appearing. Retrying the click is the
 * honest fix: the button is idempotent, and the alternative is a sleep that
 * passes on a fast machine and fails on a slow one.
 */
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

test.describe('approvals', () => {
  test.describe.configure({ timeout: 300_000 });

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project only: a TOTP code is single use');
  });

  test('one person requests a deposit payout, another approves it', async ({ page }) => {
    /* ------------------------------------------- the operator raises it */

    await signIn(page, OPERATOR);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    await page.goto(`${org}/deposits`, { waitUntil: 'domcontentloaded' });
    const depositHref = await page.locator('a[href*="/deposits/"]').first().getAttribute('href');
    expect(depositHref, 'the demo has no deposit account to act on').toBeTruthy();
    await page.goto(depositHref!, { waitUntil: 'domcontentloaded' });

    const heldBefore = await heldNow(page);
    expect(heldBefore).toBeGreaterThan(0);

    const marker = `Shower screen ${String(Date.now()).slice(-6)}`;
    const amount = page.getByLabel('Amount');
    await reveal(page, 'Request a deduction or refund', amount
      .or(page.getByText('No document is attached to this lease')));

    const noEvidence = page.getByText('No document is attached to this lease');
    if (await noEvidence.isVisible().catch(() => false)) {
      throw new Error('the demo lease carries no document, so the request form cannot open');
    }

    await amount.fill('1200.00');
    await page.getByLabel('What it is for').fill(marker);
    await page.getByLabel('Evidence').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Raise the request' }).click();

    // Wait for THIS request, not for the heading: an earlier run may have left
    // its own request pending, in which case "Waiting for a decision" is
    // already on the page and proves nothing about this submission.
    const raisedRow = page.getByText(marker);
    const refused = page.getByText('Request not raised');
    await expect(raisedRow.or(refused).first()).toBeVisible({ timeout: 30_000 });
    if (await refused.isVisible().catch(() => false)) {
      throw new Error(`raising the request was refused: ${await visibleText(page)}`);
    }

    /* ---------------------------------------- it has moved no money at all */

    const afterRequest = await visibleText(page);
    expect(afterRequest).toContain(marker);
    // The invariant: asking is not the thing happening.
    expect(await heldNow(page)).toBe(heldBefore);
    // And the operator cannot approve what they asked for, however much
    // permission they hold. There is no approve button for them at all.
    expect(afterRequest).toContain('somebody else must approve it');
    const raised = page.locator('li').filter({ hasText: marker }).first();
    await expect(raised.getByRole('button', { name: 'Approve and pay out' })).toHaveCount(0);
    await expect(raised.getByRole('button', { name: 'Withdraw this request' })).toBeVisible();

    /* ----------------------------------------- and it reaches the queue */

    await page.goto(`${org}/approvals`, { waitUntil: 'domcontentloaded' });
    const queue = await visibleText(page);
    expect(queue).toContain(marker);
    expect(queue).toContain('a request holds nothing until it is approved');
    // Every row leads somewhere a decision can be made.
    await expect(
      page.getByRole('link', { name: 'Decide' }).first(),
    ).toHaveAttribute('href', new RegExp('/deposits/'));

    /* ---------------------------------------------- the approver decides */

    // Signing out is a POST — a GET that ends a session is a request any page
    // could forge — so the button is the only way out.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/sign-in/, { timeout: 20_000 });
    await page.context().clearCookies();
    await signIn(page, APPROVER);
    await page.goto(depositHref!, { waitUntil: 'domcontentloaded' });

    const approverView = await visibleText(page);
    expect(approverView).toContain(marker);
    expect(await heldNow(page)).toBe(heldBefore);

    // Scoped to this test's own request: an earlier run may have left others
    // pending on the same deposit, and approving the wrong one would both pass
    // and prove nothing.
    const mine = page.locator('li').filter({ hasText: marker }).first();
    const reasonField = page.getByLabel('Why you are approving it');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await mine.getByRole('button', { name: 'Approve and pay out' }).click();
      if (await reasonField.isVisible({ timeout: 4_000 }).catch(() => false)) break;
    }
    const confirming = await visibleText(page);
    // The confirmation names the requester, read from the stored request
    // rather than typed by the approver.
    expect(confirming).toContain('as requested by');
    expect(confirming).toContain('owed that much less afterwards');

    await reasonField.fill('Quotation seen and the damage is on the move-out inspection.');
    await page.getByRole('button', { name: 'Approve and record' }).click();

    // Again scoped to this request: wait for its own row to carry the approval.
    const approved = page.locator('li').filter({ hasText: marker })
      .filter({ hasText: 'approved' });
    const approveFailed = page.getByText('Could not approve');
    await expect(approved.or(approveFailed).first()).toBeVisible({ timeout: 30_000 });
    if (await approveFailed.isVisible().catch(() => false)) {
      throw new Error(`approving was refused: ${await visibleText(page)}`);
    }

    /* ------------------------------------------------ now the money moves */

    const afterApproval = await visibleText(page);
    expect(await heldNow(page)).toBe(heldBefore - 120_000);
    expect(afterApproval).toContain('approved');
    // The movement is on the record with both names on it.
    expect(afterApproval).toContain('Every movement');

    // And the queue no longer asks for a decision that has been made.
    await page.goto(`${org}/approvals`, { waitUntil: 'domcontentloaded' });
    expect(await visibleText(page)).not.toContain(marker);
  });
  test('a quotation becomes a work order, and the invoice becomes a draft expense', async ({ page }) => {
    await signIn(page, OPERATOR);
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org).toBeTruthy();

    /* -------------------------------------------- 1. record a quotation */

    await page.goto(`${org}/maintenance`, { waitUntil: 'domcontentloaded' });
    // Not just any /maintenance/ link: "Log a request" points at
    // /maintenance/new, which is a form, not a request to quote on.
    const ticketHref = await page
      .locator('a[href*="/maintenance/"]:not([href$="/new"])')
      .first().getAttribute('href');
    expect(ticketHref, 'the demo has no maintenance request to quote on').toBeTruthy();
    await page.goto(ticketHref!, { waitUntil: 'domcontentloaded' });

    const quoted = `${4200 + Math.floor(Math.random() * 400)}.00`;
    await reveal(page, 'Record a quotation', page.getByLabel('Amount quoted'));
    await page.getByLabel('Contractor', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Amount quoted').fill(quoted);
    await page.getByRole('button', { name: 'Record the quotation' }).click();

    const waitingDecision = page.getByText('is waiting for a decision');
    const quoteFailed = page.getByText('Quotation not recorded');
    await expect(waitingDecision.or(quoteFailed).first()).toBeVisible({ timeout: 30_000 });
    if (await quoteFailed.isVisible().catch(() => false)) {
      throw new Error(`recording the quotation was refused: ${await visibleText(page)}`);
    }

    // Recording authorises nothing, and the page says so rather than leaving
    // the reader to assume a recorded quotation is an approved one.
    const recorded = await visibleText(page);
    expect(recorded).toContain('Recording a quotation authorises nothing');

    /* ------------------------------------------ 2. it reaches the queue */

    await page.goto(`${org}/approvals`, { waitUntil: 'domcontentloaded' });
    const queue = await visibleText(page);
    expect(queue).toContain('Maintenance quotations');
    // The row leads to a decision, which is the whole complaint about the old
    // queue: it listed quotations and offered nothing to do about them.
    await expect(
      page.getByRole('link', { name: 'Approve or decline' }).first(),
    ).toHaveAttribute('href', new RegExp('/maintenance/'));

    /* ------------------------------- 3. approve it into a work order */

    await page.goto(ticketHref!, { waitUntil: 'domcontentloaded' });
    await reveal(page, 'Approve and issue a work order', page.getByLabel('Scope of the work'));

    const confirming = await visibleText(page);
    expect(confirming).toContain('Nothing is posted to the books yet');

    await page.getByLabel('Scope of the work')
      .fill('Replace the cracked shower screen in the main bathroom.');
    await page.getByRole('button', { name: 'Approve and issue' }).click();

    const issued = page.getByText('No expense recorded yet');
    const approveFailed = page.getByText('Could not approve');
    await expect(issued.or(approveFailed).first()).toBeVisible({ timeout: 30_000 });
    if (await approveFailed.isVisible().catch(() => false)) {
      throw new Error(`approving the quotation was refused: ${await visibleText(page)}`);
    }

    /* --------------------------- 4. the invoice becomes a draft expense */

    const invoiceRef = `INV-${String(Date.now()).slice(-7)}`;
    await reveal(page, 'Record completion and invoice', page.getByLabel('Invoice number'));

    const completing = await visibleText(page);
    // Approved spending is not a posted cost. The form is explicit.
    expect(completing).toContain('as a draft');
    expect(completing).toContain('cannot be recorded twice');

    await page.getByLabel('What was done')
      .fill('Shower screen replaced; silicone resealed.');
    await page.getByLabel('Invoice number').fill(invoiceRef);
    await page.getByLabel('Invoice amount').fill(quoted);
    await page.getByRole('button', { name: 'Record completion' }).click();

    const expensed = page.getByText('Expense recorded');
    const completeFailed = page.getByText('Could not record completion');
    await expect(expensed.or(completeFailed).first()).toBeVisible({ timeout: 30_000 });
    if (await completeFailed.isVisible().catch(() => false)) {
      throw new Error(`recording completion was refused: ${await visibleText(page)}`);
    }

    // And it is waiting in the expense queue as a draft, not quietly posted.
    await page.goto(`${org}/approvals`, { waitUntil: 'domcontentloaded' });
    const finalQueue = await visibleText(page);
    expect(finalQueue).toContain('Draft expenses');
    expect(finalQueue).toContain(invoiceRef);
    expect(finalQueue).toContain('it pays nobody');
  });
});
