/**
 * Trials that end, and debts that get chased.
 *
 * Two revenue holes: a trial had no end date, so every customer ever
 * provisioned was free until somebody changed a dropdown; and an overdue
 * invoice was counted by an alert, which is not chasing.
 *
 * What these tests pin:
 *
 *   1. the ladder climbs on the thresholds, and each step is taken ONCE
 *      however often the pass runs — one step per invoice per day, so a
 *      backlog does not produce three contradictory messages in a minute;
 *   2. a reminder and a final notice are addressed to a real administrator;
 *   3. the pass cannot suspend anybody — the furthest it goes is proposing it;
 *   4. suspension is a person's act, names the invoice in its reason, and
 *      cannot be done twice;
 *   5. a customer who pays mid-ladder stops being chased, and one who is
 *      already suspended is not chased further.
 *
 * The trial ending lives in `subscription-billing.test.ts`, with the rest of
 * the run: it needs Spike's own invoicing identity, which is global, and a
 * file that writes it breaks the suite asserting what happens when it is
 * absent. Shared global state between test files, found the hard way.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withPrivilegedActor } from '@propertyos/db';
import {
  chaseOverdueInvoices, organisationDunningSteps, overdueLadder, stopChasing,
  suspendForNonPayment,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

async function createOperator(name: string): Promise<string> {
  const authUserId = await createAuthUser(name, {
    platformOperator: true, platformRoles: ['platform_admin'],
  });
  await ownerSql()`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
    values (${authUserId}, 'totp', 'JBSWY3DPEHPK3PXP', now())
    on conflict (auth_user_id, factor_type) do update set verified_at = now()
  `;
  return authUserId;
}

const asOperator = <T>(operator: string, fn: (tx: never) => Promise<T>): Promise<T> =>
  withPrivilegedActor({ authUserId: operator, assuranceLevel: 'aal2' },
    ({ tx }) => fn(tx as never));

/** An issued invoice that fell due `daysOverdue` ago. */
async function overdueInvoice(
  org: OrganisationFixture, daysOverdue: number, totalMinor = 115_000,
): Promise<{ id: string; number: string }> {
  const number = `SPK-DUN-${randomUUID().slice(0, 8)}`;
  const [row] = await ownerSql()<{ id: string }[]>`
    insert into subscription_invoices (
      organisation_id, invoice_number, period_start, period_end, issue_date, due_date,
      currency_code, plan_key, plan_name, included_units, billable_units, units_over,
      subtotal_minor, vat_rate_bp, vat_minor, total_minor, status
    ) values (
      ${org.organisationId}, ${number},
      (current_date - interval '120 days')::date,
      (current_date - interval '91 days')::date,
      (current_date - interval '90 days')::date,
      (current_date - make_interval(days => ${daysOverdue}))::date,
      'ZAR', 'starter', 'Starter', 10, 1, 0,
      ${Math.round(totalMinor / 1.15)}, 1500,
      ${totalMinor - Math.round(totalMinor / 1.15)}, ${totalMinor}, 'issued'
    )
    returning id::text
  `;
  return { id: row!.id, number };
}

const chase = () => ownerSql().begin(async (tx) => chaseOverdueInvoices(tx as never));

describe('trials ending and debts being chased', () => {
  let org: OrganisationFixture;
  let operator: string;

  beforeAll(async () => {
    org = await createOrganisation('Chased Co', { planKey: 'starter' });
    operator = await createOperator('Spike Chaser');
  });

  beforeEach(async () => {
    await ownerSql()`
      delete from subscription_dunning_steps where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`
      delete from subscription_invoices where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`
      delete from notifications where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`
      update organisations set status = 'trial' where id = ${org.organisationId}::uuid
    `;
    await ownerSql()`
      update subscriptions set status = 'trialing', trial_ends_on = current_date + 10
      where organisation_id = ${org.organisationId}::uuid
    `;
  });

  afterAll(async () => {
    await ownerSql()`
      delete from subscription_dunning_steps where organisation_id = ${org.organisationId}::uuid
    `;
    await closeOwner();
  });

  it('climbs the ladder on the thresholds, once each', async () => {
    await ownerSql()`
      update organisations set status = 'active' where id = ${org.organisationId}::uuid
    `;
    const invoice = await overdueInvoice(org, 4);

    // Four days over: a first reminder and nothing else.
    const first = await chase();
    expect(first.reminders).toBeGreaterThan(0);

    let [ladder] = (await asOperator(operator, (tx) => overdueLadder(tx, operator)))
      .filter((l) => l.invoiceNumber === invoice.number);
    expect(ladder?.steps.map((s) => s.step)).toEqual(['first_reminder']);
    expect(ladder?.awaitingDecision).toBe(false);

    // Running again changes nothing: the step is keyed in the database.
    await chase();
    await chase();
    [ladder] = (await asOperator(operator, (tx) => overdueLadder(tx, operator)))
      .filter((l) => l.invoiceNumber === invoice.number);
    expect(ladder?.steps).toHaveLength(1);

    // The reminder was addressed to a real administrator.
    const [notice] = await ownerSql()<{ recipient_email: string; status: string }[]>`
      select recipient_email, status from notifications
      where organisation_id = ${org.organisationId}::uuid order by created_at desc limit 1
    `;
    expect(notice?.recipient_email).toContain('@');
    expect(notice?.status).toBe('queued');

    // Eleven days over. The issue date moves with it: the schema requires
    // due_date >= issue_date, which is right, and an invoice cannot fall due
    // before it was issued however much a test would like it to.
    await ownerSql()`
      update subscription_invoices set due_date = current_date - 11
      where id = ${invoice.id}::uuid
    `;
    // A day has to have passed: the pass takes one step per invoice per day,
    // so that a backlog climbs the ladder in order rather than sending three
    // contradictory messages in one minute.
    await ownerSql()`
      update subscription_dunning_steps set taken_at = now() - interval '2 days'
      where invoice_id = ${invoice.id}::uuid
    `;
    await chase();
    [ladder] = (await asOperator(operator, (tx) => overdueLadder(tx, operator)))
      .filter((l) => l.invoiceNumber === invoice.number);
    expect(ladder?.steps.map((s) => s.step)).toEqual(['first_reminder', 'final_notice']);

    // Twenty-two days over: proposed for suspension, and still not suspended.
    await ownerSql()`
      update subscription_invoices set due_date = current_date - 22
      where id = ${invoice.id}::uuid
    `;
    await ownerSql()`
      update subscription_dunning_steps set taken_at = now() - interval '2 days'
      where invoice_id = ${invoice.id}::uuid
    `;
    await chase();
    [ladder] = (await asOperator(operator, (tx) => overdueLadder(tx, operator)))
      .filter((l) => l.invoiceNumber === invoice.number);
    expect(ladder?.steps.map((s) => s.step))
      .toEqual(['first_reminder', 'final_notice', 'suspension_proposed']);
    expect(ladder?.awaitingDecision).toBe(true);

    // The pass cannot suspend. That is the whole point of proposing.
    const [organisation] = await ownerSql()<{ status: string }[]>`
      select status::text from organisations where id = ${org.organisationId}::uuid
    `;
    expect(organisation?.status).toBe('active');

    // A proposal is for Spike to read: no message was sent to the customer
    // threatening a suspension nobody has decided on.
    const [messages] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from notifications
      where organisation_id = ${org.organisationId}::uuid
    `;
    expect(Number(messages?.count)).toBe(2);
  });

  it('suspends only when a person says so, naming the invoice', async () => {
    await ownerSql()`
      update organisations set status = 'active' where id = ${org.organisationId}::uuid
    `;
    const invoice = await overdueInvoice(org, 25);
    await chase();

    await asOperator(operator, (tx) => suspendForNonPayment(tx, operator, {
      invoiceId: invoice.id, reason: 'Unpaid after final notice, SPK-8100',
    }));

    const [organisation] = await ownerSql()<{ status: string }[]>`
      select status::text from organisations where id = ${org.organisationId}::uuid
    `;
    expect(organisation?.status).toBe('suspended');

    // The suspension and the debt are one record, not two unrelated ones.
    const [audit] = await ownerSql()<{ reason: string }[]>`
      select reason from audit_events
      where organisation_id = ${org.organisationId}::uuid
        and action = 'platform.account.status_changed'
      order by occurred_at desc limit 1
    `;
    expect(audit?.reason).toContain(invoice.number);
    expect(audit?.reason).toMatch(/days overdue/i);

    // Not twice.
    await expect(asOperator(operator, (tx) => suspendForNonPayment(tx, operator, {
      invoiceId: invoice.id, reason: 'Trying again',
    }))).rejects.toThrow();

    // And a suspended customer is not chased further: the lever has been
    // pulled and more reminders are noise.
    const before = await ownerSql()<{ count: string }[]>`
      select count(*)::text from subscription_dunning_steps
      where organisation_id = ${org.organisationId}::uuid
    `;
    await chase();
    const after = await ownerSql()<{ count: string }[]>`
      select count(*)::text from subscription_dunning_steps
      where organisation_id = ${org.organisationId}::uuid
    `;
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('stops chasing when somebody is dealing with it, without suspending', async () => {
    await ownerSql()`
      update organisations set status = 'active' where id = ${org.organisationId}::uuid
    `;
    const invoice = await overdueInvoice(org, 25);
    await chase();

    await asOperator(operator, (tx) => stopChasing(tx, operator, {
      invoiceId: invoice.id, reason: 'They rang; paying by transfer on Friday',
    }));

    const [ladder] = (await asOperator(operator, (tx) => overdueLadder(tx, operator)))
      .filter((l) => l.invoiceNumber === invoice.number);
    expect(ladder?.settled).toBe(true);
    expect(ladder?.awaitingDecision).toBe(false);

    // The invoice still says what it says: stopping the chasing is not a
    // write-off of the debt.
    const [row] = await ownerSql()<{ status: string; total_minor: string }[]>`
      select status::text, total_minor::text from subscription_invoices
      where id = ${invoice.id}::uuid
    `;
    expect(row?.status).toBe('issued');
    expect(Number(row?.total_minor)).toBe(115_000);

    // And the account was never suspended.
    const [organisation] = await ownerSql()<{ status: string }[]>`
      select status::text from organisations where id = ${org.organisationId}::uuid
    `;
    expect(organisation?.status).toBe('active');
  });

  it('stops chasing an invoice that gets paid', async () => {
    await ownerSql()`
      update organisations set status = 'active' where id = ${org.organisationId}::uuid
    `;
    const invoice = await overdueInvoice(org, 4);
    await chase();

    await ownerSql()`
      update subscription_invoices set status = 'paid', paid_on = current_date,
             paid_minor = total_minor
       where id = ${invoice.id}::uuid
    `;

    // It drops out of the ladder entirely, so nothing escalates.
    await ownerSql()`
      update subscription_invoices set due_date = current_date - 30
      where id = ${invoice.id}::uuid
    `;
    await chase();

    const ladder = (await asOperator(operator, (tx) => overdueLadder(tx, operator)))
      .filter((l) => l.invoiceNumber === invoice.number);
    expect(ladder).toHaveLength(0);

    const [steps] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from subscription_dunning_steps
      where invoice_id = ${invoice.id}::uuid
    `;
    expect(Number(steps?.count)).toBe(1);
  });

  /**
   * Who can see that a customer is being chased.
   *
   * The customer's own administrator can, because being chased in silence is
   * how a suspension arrives as a surprise. Nobody else can — not a member of
   * the same organisation who does not run it, and not another customer's
   * administrator, which is the one that would be a leak rather than merely
   * an oversight.
   */
  it('shows the chasing to the customer who is being chased, and to nobody else', async () => {
    await ownerSql()`
      update organisations set status = 'active' where id = ${org.organisationId}::uuid
    `;
    const invoice = await overdueInvoice(org, 5);
    await chase();

    const mine = await as(org.adminUserId, (tx) =>
      organisationDunningSteps(tx, org.organisationId));
    expect(mine.some((s) => s.invoiceNumber === invoice.number && s.step === 'first_reminder'))
      .toBe(true);

    // A contractor in the same organisation, who does not run it.
    const member = await addMember(org.organisationId, 'Dunning Contractor', ['contractor']);
    const theirs = await as(member, (tx) =>
      organisationDunningSteps(tx, org.organisationId));
    expect(theirs).toHaveLength(0);

    // And another customer's administrator, asking for this one's rows by id.
    const other = await createOrganisation('Unchased Co', { planKey: 'starter' });
    const across = await as(other.adminUserId, (tx) =>
      organisationDunningSteps(tx, org.organisationId));
    expect(across).toHaveLength(0);
  });

  it('will not show the ladder to a customer, however senior', async () => {
    await expect(
      as(org.adminUserId, (tx) => overdueLadder(tx, org.adminUserId)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
