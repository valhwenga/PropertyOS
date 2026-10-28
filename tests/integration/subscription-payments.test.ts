/**
 * Paying one of Spike's invoices.
 *
 * ADR 0004: payment state is only ever advanced to `confirmed` by verified
 * funds, and a browser redirect proves nothing. Until now that was a sentence
 * in a document with no code under it. These tests are mostly about the ways
 * this refuses to believe things.
 *
 * What they pin:
 *
 *   1. a customer's administrator can start a payment for what is outstanding,
 *      and cannot start two, and cannot insert one that is already confirmed —
 *      the insert policy refuses the shape, not just the intent;
 *   2. nothing confirms without a VERIFIED provider event, asserted against
 *      the database rather than the code path that is supposed to be careful;
 *   3. a replayed event settles nothing twice, and neither does a second
 *      confirmation under a fresh event id;
 *   4. a short payment is recorded as what arrived and leaves the invoice
 *      issued, exactly as the manual path has always done;
 *   5. an unverified or unknown event is still recorded, because an attacker
 *      posting at the notification endpoint is worth being able to see.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ingestProviderEvent, invoicePaymentAttempts, markPaymentPending, startPayment,
  type IncomingProviderEvent,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const PROVIDER = 'sandbox';

/**
 * One issued invoice.
 *
 * `monthsAgo` is not decoration: the schema allows one invoice per
 * organisation per period, correctly, so a test that needs two has to bill two
 * periods.
 */
let period = 0;
async function issueInvoice(
  org: OrganisationFixture, totalMinor: number, number = `SPK-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  period += 1;
  const monthsAgo = period;
  const [row] = await ownerSql()<{ id: string }[]>`
    insert into subscription_invoices (
      organisation_id, invoice_number, period_start, period_end, issue_date, due_date,
      currency_code, plan_key, plan_name, included_units, billable_units, units_over,
      subtotal_minor, vat_rate_bp, vat_minor, total_minor, status
    ) values (
      ${org.organisationId}::uuid, ${number},
      (date_trunc('month', current_date) - make_interval(months => ${monthsAgo}))::date,
      (date_trunc('month', current_date) - make_interval(months => ${monthsAgo})
        + interval '1 month - 1 day')::date,
      current_date, current_date + 14, 'ZAR', 'starter', 'Starter', 10, 1, 0,
      ${Math.round(totalMinor / 1.15)}, 1500, ${totalMinor - Math.round(totalMinor / 1.15)},
      ${totalMinor}, 'issued'
    )
    returning id::text
  `;
  return row!.id;
}

/** What the notification endpoint hands the domain once a signature checks out. */
function providerEvent(
  reference: string,
  status: IncomingProviderEvent['status'],
  amountMinor: number | null,
  eventId = `evt-${randomUUID().slice(0, 12)}`,
): IncomingProviderEvent {
  return {
    providerEventId: eventId,
    eventType: `payment.${status}`,
    reference,
    providerReference: `pf-${randomUUID().slice(0, 8)}`,
    status,
    amountMinor,
    feeMinor: amountMinor === null ? null : Math.round(amountMinor * 0.029),
    netMinor: amountMinor === null ? null : amountMinor - Math.round(amountMinor * 0.029),
  };
}

const ingest = (event: IncomingProviderEvent | null, verified = true) =>
  ownerSql().begin(async (tx) => ingestProviderEvent(tx as never, {
    provider: PROVIDER,
    signatureVerified: verified,
    payload: { raw: 'as it arrived' },
    event,
  }));

describe('paying one of Spike invoices', () => {
  let org: OrganisationFixture;
  let member: string;

  beforeAll(async () => {
    org = await createOrganisation('Paying Properly', { planKey: 'starter' });
    member = await addMember(org.organisationId, 'Ordinary Member', ['property_manager']);
  });

  beforeEach(async () => {
    await ownerSql()`
      delete from subscription_payment_attempts where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`delete from webhook_events where provider = ${PROVIDER}`;
    await ownerSql()`
      delete from subscription_invoices where organisation_id = ${org.organisationId}::uuid
    `;
  });

  afterAll(async () => {
    await ownerSql()`
      delete from subscription_payment_attempts where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`delete from webhook_events where provider = ${PROVIDER}`;
    await closeOwner();
  });

  it('starts a payment for what is outstanding, and only once', async () => {
    const invoiceId = await issueInvoice(org, 115_000);

    const started = await as(org.adminUserId, (tx) =>
      startPayment(tx, org.adminUserId, { invoiceId, provider: PROVIDER }));
    expect(started.amountMinor).toBe(115_000);
    expect(started.reference).toMatch(/^SPK-/);

    // Two tabs, two references, two confirmations, one double payment and a
    // support call nobody wants.
    await expect(as(org.adminUserId, (tx) =>
      startPayment(tx, org.adminUserId, { invoiceId, provider: PROVIDER })))
      .rejects.toThrow(/has not finished/i);

    // A member who does not administer the organisation cannot pay its bills.
    const other = await issueInvoice(org, 50_000);
    await expect(as(member, (tx) => startPayment(tx, member, { invoiceId: other, provider: PROVIDER })))
      .rejects.toThrow();
  });

  it('asks for the remainder when part of it has already been paid', async () => {
    const invoiceId = await issueInvoice(org, 100_000);
    await ownerSql()`
      update subscription_invoices set paid_minor = 40_000 where id = ${invoiceId}::uuid
    `;
    const started = await as(org.adminUserId, (tx) =>
      startPayment(tx, org.adminUserId, { invoiceId, provider: PROVIDER }));
    expect(started.amountMinor).toBe(60_000);
  });

  it('refuses an attempt that arrives already confirmed', async () => {
    const invoiceId = await issueInvoice(org, 115_000);

    // Straight at the table as the customer's administrator, bypassing the
    // domain entirely: the insert policy has to refuse the SHAPE.
    await expect(as(org.adminUserId, (tx) => tx`
      insert into subscription_payment_attempts (
        invoice_id, organisation_id, provider, reference, amount_minor, currency_code,
        status, started_by, confirmed_at, amount_confirmed_minor
      ) values (
        ${invoiceId}::uuid, ${org.organisationId}::uuid, ${PROVIDER}, 'forged-1',
        115000, 'ZAR', 'confirmed', ${org.adminUserId}::uuid, now(), 115000
      )
    `)).rejects.toThrow();

    const [count] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from subscription_payment_attempts where reference = 'forged-1'
    `;
    expect(Number(count?.count)).toBe(0);
  });

  it('will not confirm without a verified event, whatever the code asks for', async () => {
    const invoiceId = await issueInvoice(org, 115_000);
    const started = await as(org.adminUserId, (tx) =>
      startPayment(tx, org.adminUserId, { invoiceId, provider: PROVIDER }));

    // An unverified notification: recorded, and it changes nothing.
    const refused = await ingest(providerEvent(started.reference, 'confirmed', 115_000), false);
    expect(refused.outcome).toBe('unverified');

    const [attempt] = await ownerSql()<{ status: string }[]>`
      select status from subscription_payment_attempts where reference = ${started.reference}
    `;
    expect(attempt?.status).toBe('created');

    const [invoice] = await ownerSql()<{ status: string }[]>`
      select status::text from subscription_invoices where id = ${invoiceId}::uuid
    `;
    expect(invoice?.status).toBe('issued');

    // But it is on the record, which is the only place anybody could ever see
    // somebody posting rubbish at the endpoint.
    const [event] = await ownerSql()<{ signature_verified: boolean; processing_result: string }[]>`
      select signature_verified, processing_result from webhook_events
      where provider = ${PROVIDER} order by received_at desc limit 1
    `;
    expect(event?.signature_verified).toBe(false);
    expect(event?.processing_result).toMatch(/could not be verified/i);

    // And the database itself refuses the state, not just this path: the
    // trigger checks the event behind a confirmation.
    const [unverified] = await ownerSql()<{ id: string }[]>`
      select id::text from webhook_events where signature_verified = false limit 1
    `;
    await expect(ownerSql()`
      update subscription_payment_attempts
         set status = 'confirmed', confirmed_at = now(), amount_confirmed_minor = 115000,
             webhook_event_id = ${unverified!.id}::uuid
       where reference = ${started.reference}
    `).rejects.toThrow(/signature was verified/i);
  });

  it('settles the invoice on a verified confirmation, once', async () => {
    const invoiceId = await issueInvoice(org, 115_000);
    const started = await as(org.adminUserId, (tx) =>
      startPayment(tx, org.adminUserId, { invoiceId, provider: PROVIDER }));
    await ownerSql().begin(async (tx) =>
      markPaymentPending(tx as never, { reference: started.reference }));

    const event = providerEvent(started.reference, 'confirmed', 115_000);
    const first = await ingest(event);
    expect(first).toMatchObject({ outcome: 'recorded', status: 'confirmed', invoiceSettled: true });

    const [invoice] = await ownerSql()<{
      status: string; paid_minor: string; payment_recorded_by: string | null;
      payment_reference: string | null;
    }[]>`
      select status::text, paid_minor::text, payment_recorded_by::text, payment_reference
        from subscription_invoices where id = ${invoiceId}::uuid
    `;
    expect(invoice?.status).toBe('paid');
    expect(Number(invoice?.paid_minor)).toBe(115_000);
    // No operator recorded this one, and the column says so rather than
    // crediting whoever happened to be signed in.
    expect(invoice?.payment_recorded_by).toBeNull();
    expect(invoice?.payment_reference).toBe(event.providerReference);

    // The same event again, as providers do.
    expect(await ingest(event)).toMatchObject({ outcome: 'duplicate' });

    // And a DIFFERENT event saying confirmed again: still one payment.
    const twice = await ingest(providerEvent(started.reference, 'confirmed', 115_000));
    expect(twice).toMatchObject({ outcome: 'recorded', invoiceSettled: true });
    const [after] = await ownerSql()<{ paid_minor: string }[]>`
      select paid_minor::text from subscription_invoices where id = ${invoiceId}::uuid
    `;
    expect(Number(after?.paid_minor)).toBe(115_000);

    const attempts = await as(org.adminUserId, (tx) => invoicePaymentAttempts(tx, invoiceId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('confirmed');
    expect(attempts[0]?.feeMinor).toBeGreaterThan(0);
    expect(attempts[0]?.startedByName).toBe('Paying Properly Admin');
  });

  it('records a short payment as what arrived and leaves the invoice issued', async () => {
    const invoiceId = await issueInvoice(org, 115_000);
    const started = await as(org.adminUserId, (tx) =>
      startPayment(tx, org.adminUserId, { invoiceId, provider: PROVIDER }));

    const outcome = await ingest(providerEvent(started.reference, 'confirmed', 40_000));
    expect(outcome).toMatchObject({ outcome: 'recorded', invoiceSettled: false });

    const [invoice] = await ownerSql()<{ status: string; paid_minor: string; paid_on: string | null }[]>`
      select status::text, paid_minor::text, paid_on::text from subscription_invoices
      where id = ${invoiceId}::uuid
    `;
    expect(invoice?.status).toBe('issued');
    expect(Number(invoice?.paid_minor)).toBe(40_000);
    expect(invoice?.paid_on).toBeNull();
  });

  it('records a failure against the attempt and nothing against the invoice', async () => {
    const invoiceId = await issueInvoice(org, 115_000);
    const started = await as(org.adminUserId, (tx) =>
      startPayment(tx, org.adminUserId, { invoiceId, provider: PROVIDER }));

    await ingest(providerEvent(started.reference, 'failed', null));

    const [attempt] = await ownerSql()<{ status: string; failure_reason: string | null }[]>`
      select status, failure_reason from subscription_payment_attempts
      where reference = ${started.reference}
    `;
    expect(attempt?.status).toBe('failed');
    expect(attempt?.failure_reason).toBe('payment.failed');

    const [invoice] = await ownerSql()<{ status: string; paid_minor: string | null }[]>`
      select status::text, paid_minor::text from subscription_invoices where id = ${invoiceId}::uuid
    `;
    expect(invoice?.status).toBe('issued');
    expect(invoice?.paid_minor).toBeNull();

    // A failure is not the end: the customer may try again.
    const again = await as(org.adminUserId, (tx) =>
      startPayment(tx, org.adminUserId, { invoiceId, provider: PROVIDER }));
    expect(again.reference).not.toBe(started.reference);
  });

  it('keeps an event for a reference it has never heard of', async () => {
    const outcome = await ingest(providerEvent('SPK-not-ours', 'confirmed', 99_000));
    expect(outcome).toMatchObject({ outcome: 'unknown_reference' });

    const [event] = await ownerSql()<{ processing_result: string }[]>`
      select processing_result from webhook_events
      where provider = ${PROVIDER} order by received_at desc limit 1
    `;
    expect(event?.processing_result).toMatch(/no attempt with reference/i);
  });
});
