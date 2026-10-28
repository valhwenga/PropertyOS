/**
 * Taking the money a payer authorised.
 *
 * This is the only code in this product that causes money to leave somebody
 * else's bank account, so the tests are weighted accordingly: most of them are
 * about the amount, the authority behind it, and what happens when the bank
 * says no or the payer objects.
 *
 * What they pin:
 *
 *   1. a collection may never exceed what the payer authorised, asserted
 *      against the database rather than through the code that prepares it;
 *   2. nothing is collected against a mandate that is not authenticated — and
 *      a mandate cancelled between preparing and submitting stops the
 *      submission;
 *   3. the run collects what is OUTSTANDING, skips what it cannot collect and
 *      names who it skipped, and preparing twice does not produce two debits;
 *   4. only a verified provider event marks one successful;
 *   5. unpaid leaves the invoice owing with the bank's reason kept;
 *   6. a dispute reverses the settlement, because the money never really
 *      arrived.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withPrivilegedActor } from '@propertyos/db';
import {
  abandonCollection, collectionForSubmission, ingestCollectionEvent, listCollections,
  markCollectionSubmitted, organisationCollections, prepareCollections,
  type IncomingCollectionEvent,
} from '@propertyos/domain';
import {
  as, closeOwner, createAuthUser, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const PROVIDER = 'sandbox';

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

/** An authenticated mandate, the way a payer's bank leaves one. */
async function authenticateMandate(
  org: OrganisationFixture, authorisedMinor: number,
): Promise<string> {
  const sql = ownerSql();
  const [event] = await sql<{ id: string }[]>`
    insert into webhook_events (provider, provider_event_id, event_type, signature_verified, payload)
    values (${PROVIDER}, ${`man-${randomUUID()}`}, 'mandate.authenticated', true, '{}'::jsonb)
    returning id::text
  `;
  const reference = `MAN-${randomUUID().slice(0, 10)}`;
  await sql`
    insert into subscription_mandates (
      organisation_id, provider, reference, authorised_amount_minor, currency_code,
      collection_day, first_collection_on, account_holder, bank_name, branch_code,
      account_type, account_number_cipher, account_number_last4, status,
      authenticated_at, authentication_event_id
    ) values (
      ${org.organisationId}, ${PROVIDER}, ${reference}, ${authorisedMinor}, 'ZAR', 1,
      (date_trunc('month', current_date) - interval '1 month')::date,
      'Collected Co', 'Standard Bank', '051001', 'cheque', decode('00', 'hex'), '4567',
      'authenticated', now(), ${event!.id}
    )
  `;
  return reference;
}

let period = 0;
async function issueInvoice(org: OrganisationFixture, totalMinor: number): Promise<string> {
  period += 1;
  const [row] = await ownerSql()<{ id: string }[]>`
    insert into subscription_invoices (
      organisation_id, invoice_number, period_start, period_end, issue_date, due_date,
      currency_code, plan_key, plan_name, included_units, billable_units, units_over,
      subtotal_minor, vat_rate_bp, vat_minor, total_minor, status
    ) values (
      ${org.organisationId}, ${`SPK-COL-${randomUUID().slice(0, 8)}`},
      (date_trunc('month', current_date) - make_interval(months => ${period}))::date,
      (date_trunc('month', current_date) - make_interval(months => ${period})
        + interval '1 month - 1 day')::date,
      current_date, current_date + 14, 'ZAR', 'starter', 'Starter', 10, 1, 0,
      ${Math.round(totalMinor / 1.15)}, 1500,
      ${totalMinor - Math.round(totalMinor / 1.15)}, ${totalMinor}, 'issued'
    )
    returning id::text
  `;
  return row!.id;
}

function collectionEvent(
  reference: string,
  status: IncomingCollectionEvent['status'],
  amountMinor: number | null = null,
  eventId = `cevt-${randomUUID().slice(0, 12)}`,
): IncomingCollectionEvent {
  return {
    providerEventId: eventId,
    eventType: `collection.${status}`,
    reference,
    providerReference: `sbx-col-${randomUUID().slice(0, 8)}`,
    status,
    amountMinor,
    reason: status === 'unpaid' ? 'Insufficient funds' : status === 'disputed'
      ? 'The payer did not recognise the debit' : null,
  };
}

const ingest = (event: IncomingCollectionEvent | null, verified = true) =>
  ownerSql().begin(async (tx) => ingestCollectionEvent(tx as never, {
    provider: PROVIDER, signatureVerified: verified, payload: { raw: 'as it arrived' }, event,
  }));

const asOperator = <T>(operator: string, fn: (tx: never) => Promise<T>): Promise<T> =>
  withPrivilegedActor({ authUserId: operator, assuranceLevel: 'aal2' },
    ({ tx }) => fn(tx as never));

describe('collecting on the mandate', () => {
  let org: OrganisationFixture;
  let operator: string;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    org = await createOrganisation('Collected Co', { planKey: 'starter' });
    operator = await createOperator('Spike Collector');
  });

  beforeEach(async () => {
    await ownerSql()`
      delete from subscription_collections where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`
      delete from subscription_mandates where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`
      delete from subscription_invoices where organisation_id = ${org.organisationId}::uuid
    `;
  });

  afterAll(async () => {
    await ownerSql()`
      delete from subscription_collections where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`
      delete from subscription_mandates where organisation_id = ${org.organisationId}::uuid
    `;
    await closeOwner();
  });

  it('prepares what is outstanding, once', async () => {
    await authenticateMandate(org, 200_000);
    const invoiceId = await issueInvoice(org, 115_000);
    // Part of it already paid: a debit order must not take it twice.
    await ownerSql()`
      update subscription_invoices set paid_minor = 15_000 where id = ${invoiceId}::uuid
    `;

    const run = await asOperator(operator, (tx) =>
      prepareCollections(tx, operator, { actionDate: today }));
    const mine = run.prepared.filter((p) => p.organisationName === 'Collected Co');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.amountMinor).toBe(100_000);

    // Preparing again produces nothing new for this invoice.
    const again = await asOperator(operator, (tx) =>
      prepareCollections(tx, operator, { actionDate: today }));
    expect(again.prepared.filter((p) => p.organisationName === 'Collected Co')).toHaveLength(0);
    expect(again.skipped.some((s) => s.reason.includes('already has a collection'))).toBe(true);
  });

  it('refuses to collect more than the payer authorised', async () => {
    const mandate = await authenticateMandate(org, 100_000);
    const invoiceId = await issueInvoice(org, 250_000);

    // The run skips it and says why, rather than taking the cap and leaving an
    // invoice short-paid that nobody decided to short-pay.
    const run = await asOperator(operator, (tx) =>
      prepareCollections(tx, operator, { actionDate: today }));
    const skip = run.skipped.find((s) => s.organisationName === 'Collected Co');
    expect(skip?.reason).toMatch(/authorised/i);
    expect(run.prepared.some((p) => p.organisationName === 'Collected Co')).toBe(false);

    // And the database refuses it directly, which is where the rule lives.
    await expect(ownerSql()`
      insert into subscription_collections (
        mandate_id, organisation_id, invoice_id, reference, provider, amount_minor,
        currency_code, action_date
      )
      select m.id, m.organisation_id, ${invoiceId}::uuid, 'COL-OVER', ${PROVIDER},
             250000, 'ZAR', ${today}::date
        from subscription_mandates m where m.reference = ${mandate}
    `).rejects.toThrow(/exceeds the 100000 this payer authorised/i);
  });

  it('collects nothing against a mandate that is not authenticated', async () => {
    const invoiceId = await issueInvoice(org, 50_000);
    const [event] = await ownerSql()<{ id: string }[]>`
      insert into webhook_events (provider, provider_event_id, event_type, signature_verified, payload)
      values (${PROVIDER}, ${`man-${randomUUID()}`}, 'mandate.requested', true, '{}'::jsonb)
      returning id::text
    `;
    await ownerSql()`
      insert into subscription_mandates (
        organisation_id, provider, reference, authorised_amount_minor, currency_code,
        collection_day, first_collection_on, account_holder, bank_name, branch_code,
        account_type, account_number_cipher, account_number_last4, status
      ) values (
        ${org.organisationId}, ${PROVIDER}, 'MAN-WAITING', 100000, 'ZAR', 1,
        (date_trunc('month', current_date) - interval '1 month')::date,
        'Collected Co', 'Standard Bank', '051001', 'cheque', decode('00', 'hex'), '4567', 'requested'
      )
    `;
    expect(event).toBeTruthy();

    const run = await asOperator(operator, (tx) =>
      prepareCollections(tx, operator, { actionDate: today }));
    expect(run.prepared.some((p) => p.organisationName === 'Collected Co')).toBe(false);

    await expect(ownerSql()`
      insert into subscription_collections (
        mandate_id, organisation_id, invoice_id, reference, provider, amount_minor,
        currency_code, action_date
      )
      select m.id, m.organisation_id, ${invoiceId}::uuid, 'COL-NOAUTH', ${PROVIDER},
             50000, 'ZAR', ${today}::date
        from subscription_mandates m where m.reference = 'MAN-WAITING'
    `).rejects.toThrow(/is requested, so nothing may be collected/i);
  });

  it('will not submit one whose mandate was withdrawn in the meantime', async () => {
    await authenticateMandate(org, 200_000);
    await issueInvoice(org, 115_000);
    await asOperator(operator, (tx) => prepareCollections(tx, operator, { actionDate: today }));

    const [collection] = await asOperator(operator, (tx) =>
      listCollections(tx, operator, { status: 'prepared' }));

    // The payer cancels on the 30th; the run was prepared on the 29th.
    await ownerSql()`
      update subscription_mandates
         set status = 'cancelled', cancelled_at = now(), cancelled_by_payer = true,
             cancellation_reason = 'Withdrawn at the bank'
       where organisation_id = ${org.organisationId}::uuid
    `;

    await expect(asOperator(operator, (tx) =>
      collectionForSubmission(tx, operator, collection!.id)))
      .rejects.toThrow(/mandate is cancelled/i);
  });

  it('succeeds only on a verified event, and settles the invoice', async () => {
    await authenticateMandate(org, 200_000);
    const invoiceId = await issueInvoice(org, 115_000);
    await asOperator(operator, (tx) => prepareCollections(tx, operator, { actionDate: today }));
    const [prepared] = await asOperator(operator, (tx) =>
      listCollections(tx, operator, { status: 'prepared' }));

    const forSubmission = await asOperator(operator, (tx) =>
      collectionForSubmission(tx, operator, prepared!.id));
    expect(forSubmission?.accountHolder).toBe('Collected Co');
    await asOperator(operator, (tx) => markCollectionSubmitted(tx, operator, {
      collectionId: prepared!.id, providerReference: 'sbx-col-probe',
    }));

    // Unverified: recorded, changes nothing.
    expect(await ingest(collectionEvent(prepared!.reference, 'successful'), false))
      .toMatchObject({ outcome: 'unverified' });
    let [invoice] = await ownerSql()<{ status: string }[]>`
      select status::text from subscription_invoices where id = ${invoiceId}::uuid
    `;
    expect(invoice?.status).toBe('issued');

    // The database refuses the state directly too.
    const [unverified] = await ownerSql()<{ id: string }[]>`
      select id::text from webhook_events where signature_verified = false limit 1
    `;
    await expect(ownerSql()`
      update subscription_collections
         set status = 'successful', outcome_at = now(),
             webhook_event_id = ${unverified!.id}::uuid
       where id = ${prepared!.id}::uuid
    `).rejects.toThrow(/signature was verified/i);

    // Verified: the money arrived.
    const event = collectionEvent(prepared!.reference, 'successful', 115_000);
    expect(await ingest(event)).toMatchObject({
      outcome: 'recorded', status: 'successful', invoiceSettled: true,
    });
    [invoice] = await ownerSql()<{ status: string }[]>`
      select status::text from subscription_invoices where id = ${invoiceId}::uuid
    `;
    expect(invoice?.status).toBe('paid');

    // A replay changes nothing.
    expect(await ingest(event)).toMatchObject({ outcome: 'duplicate' });
  });

  it('leaves the invoice owing when the bank says unpaid, with the reason', async () => {
    await authenticateMandate(org, 200_000);
    const invoiceId = await issueInvoice(org, 115_000);
    await asOperator(operator, (tx) => prepareCollections(tx, operator, { actionDate: today }));
    const [prepared] = await asOperator(operator, (tx) =>
      listCollections(tx, operator, { status: 'prepared' }));

    expect(await ingest(collectionEvent(prepared!.reference, 'unpaid')))
      .toMatchObject({ outcome: 'recorded', status: 'unpaid', invoiceSettled: false });

    const [invoice] = await ownerSql()<{ status: string; paid_minor: string | null }[]>`
      select status::text, paid_minor::text from subscription_invoices
      where id = ${invoiceId}::uuid
    `;
    expect(invoice?.status).toBe('issued');
    expect(invoice?.paid_minor).toBeNull();

    const [collection] = await ownerSql()<{ status: string; unpaid_reason: string }[]>`
      select status, unpaid_reason from subscription_collections where id = ${prepared!.id}::uuid
    `;
    expect(collection?.status).toBe('unpaid');
    expect(collection?.unpaid_reason).toBe('Insufficient funds');

    // An unpaid one can be given up on, and then the invoice is collectable
    // again by a later run.
    await asOperator(operator, (tx) => abandonCollection(tx, operator, {
      collectionId: prepared!.id, reason: 'Customer paid by transfer instead',
    }));
    const run = await asOperator(operator, (tx) =>
      prepareCollections(tx, operator, { actionDate: today }));
    expect(run.prepared.some((p) => p.organisationName === 'Collected Co')).toBe(true);
  });

  it('reverses the settlement when the payer disputes it', async () => {
    await authenticateMandate(org, 200_000);
    const invoiceId = await issueInvoice(org, 115_000);
    await asOperator(operator, (tx) => prepareCollections(tx, operator, { actionDate: today }));
    const [prepared] = await asOperator(operator, (tx) =>
      listCollections(tx, operator, { status: 'prepared' }));

    await ingest(collectionEvent(prepared!.reference, 'successful', 115_000));
    let [invoice] = await ownerSql()<{ status: string }[]>`
      select status::text from subscription_invoices where id = ${invoiceId}::uuid
    `;
    expect(invoice?.status).toBe('paid');

    // Weeks later: the payer says they did not recognise it, and their bank
    // reverses it. The money never really arrived.
    expect(await ingest(collectionEvent(prepared!.reference, 'disputed')))
      .toMatchObject({ outcome: 'recorded', status: 'disputed' });

    [invoice] = await ownerSql()<{ status: string; paid_minor: string | null; paid_on: string | null }[]>`
      select status::text, paid_minor::text, paid_on::text from subscription_invoices
      where id = ${invoiceId}::uuid
    `;
    expect(invoice?.status).toBe('issued');
    expect(invoice?.paid_minor).toBeNull();
    expect(invoice?.paid_on).toBeNull();

    const [collection] = await ownerSql()<{ status: string; dispute_reason: string }[]>`
      select status, dispute_reason from subscription_collections where id = ${prepared!.id}::uuid
    `;
    expect(collection?.status).toBe('disputed');
    expect(collection?.dispute_reason).toMatch(/did not recognise/i);
  });

  it('shows the customer what will be taken, and never the account number', async () => {
    await authenticateMandate(org, 200_000);
    await issueInvoice(org, 115_000);
    await asOperator(operator, (tx) => prepareCollections(tx, operator, { actionDate: today }));

    const theirs = await as(org.adminUserId, (tx) =>
      organisationCollections(tx, org.organisationId));
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.amountMinor).toBe(115_000);
    expect(theirs[0]?.accountNumberLast4).toBe('4567');
    expect(JSON.stringify(theirs)).not.toContain('62001234567');
  });
});
