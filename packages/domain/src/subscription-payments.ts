import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, forbidden, invalid, notFound, parsed } from './errors';
import { requirePermission } from './permissions';

/**
 * Paying one of Spike's invoices.
 *
 * The rule the whole module is arranged around comes from ADR 0004: payment
 * state is only ever advanced to `confirmed` by verified funds, and a browser
 * redirect establishes nothing. So the work is split in a way that makes that
 * structurally true rather than carefully observed:
 *
 *   * `startPayment` is reachable by a customer's administrator and creates a
 *     row that says somebody set out to pay. It cannot write a status, and the
 *     insert policy refuses one that tries.
 *   * `ingestProviderEvent` runs on the privileged connection, from the
 *     notification endpoint, having verified a signature. It is the only
 *     function here that advances anything, and the only one that can settle
 *     an invoice.
 *   * nothing in between. There is no "the payer came back, so assume it
 *     worked" path, because that is the path that loses money or invents it.
 */

export type AttemptStatus = 'created' | 'pending' | 'confirmed' | 'failed' | 'cancelled';

export interface PaymentAttempt {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  provider: string;
  reference: string;
  amountMinor: number;
  currencyCode: string;
  status: AttemptStatus;
  startedByName: string | null;
  createdAt: string;
  providerReference: string | null;
  confirmedAt: string | null;
  amountConfirmedMinor: number | null;
  feeMinor: number | null;
  netMinor: number | null;
  failureReason: string | null;
}

const startSchema = z.object({
  invoiceId: z.string().uuid(),
  provider: z.string().min(1).max(40),
});

/** A reference the provider echoes back. Opaque, and not guessable. */
function mintReference(): string {
  return `SPK-${randomBytes(9).toString('base64url')}`;
}

/**
 * Starting a payment, as the customer.
 *
 * Takes `organisation.settings.manage`, the same permission that already lets
 * somebody read the invoice they are being asked to pay. It is deliberately
 * not a new permission: a product that needs a separate right to pay a bill it
 * sent you is a product that will be paid late.
 *
 * It returns the reference rather than a checkout URL, because building that
 * URL needs the provider adapter and this package has no business reaching for
 * one — the same division the storage and email paths already follow.
 */
export async function startPayment(
  tx: Sql,
  authUserId: string,
  params: z.input<typeof startSchema>,
): Promise<{ attemptId: string; reference: string; amountMinor: number; currencyCode: string }> {
  const input = parsed(startSchema, params);

  const [invoice] = await tx<{
    id: string; organisation_id: string; invoice_number: string; total_minor: string;
    paid_minor: string | null; currency_code: string; status: string;
  }[]>`
    select id::text, organisation_id::text, invoice_number, total_minor::text,
           paid_minor::text, currency_code, status::text
      from subscription_invoices where id = ${input.invoiceId}::uuid
  `;
  if (!invoice) throw notFound('Subscription invoice');

  await requirePermission(tx, invoice.organisation_id, 'organisation.settings.manage');

  if (invoice.status === 'paid') throw invalid('That invoice is already settled.');
  if (invoice.status === 'void') throw invalid('That invoice has been voided.');

  // What is left, not what the invoice says: a part payment recorded against
  // it means the customer owes the remainder and should be asked for the
  // remainder.
  const outstanding = Number(invoice.total_minor) - Number(invoice.paid_minor ?? 0);
  if (outstanding <= 0) throw invalid('There is nothing outstanding on that invoice.');

  // One live attempt at a time. Two tabs, two references, two confirmations
  // and a double payment is a support call nobody wants to have.
  const [live] = await tx<{ reference: string }[]>`
    select reference from subscription_payment_attempts
    where invoice_id = ${input.invoiceId}::uuid
      and status in ('created', 'pending')
      and created_at > now() - interval '30 minutes'
    order by created_at desc limit 1
  `;
  if (live) {
    throw new DomainError(
      'conflict',
      'A payment for this invoice was started in the last half hour and has not finished. '
      + 'Wait for it to settle before starting another.',
      { reference: live.reference },
    );
  }

  const reference = mintReference();
  const [attempt] = await tx<{ id: string }[]>`
    insert into subscription_payment_attempts (
      invoice_id, organisation_id, provider, reference, amount_minor, currency_code,
      status, started_by
    ) values (
      ${input.invoiceId}::uuid, ${invoice.organisation_id}::uuid, ${input.provider},
      ${reference}, ${outstanding}, ${invoice.currency_code}, 'created', ${authUserId}::uuid
    )
    returning id::text
  `;
  if (!attempt) throw forbidden('That payment could not be started.');

  await recordAudit(tx, {
    organisationId: invoice.organisation_id,
    actorUserId: authUserId,
    action: 'subscription.payment.started',
    resourceType: 'subscription_invoice',
    resourceId: input.invoiceId,
    reason: `Payment started for ${invoice.invoice_number} through ${input.provider}.`,
    before: null,
    after: { reference, amountMinor: outstanding },
  });

  return {
    attemptId: attempt.id,
    reference,
    amountMinor: outstanding,
    currencyCode: invoice.currency_code,
  };
}

/**
 * The payer has been sent to the provider.
 *
 * `pending` says only that: somebody left for a payment page. It is not
 * evidence of anything and is recorded so that an abandoned attempt looks
 * different from one that was never begun.
 */
export async function markPaymentPending(
  tx: Sql,
  params: { reference: string },
): Promise<void> {
  await tx`
    update subscription_payment_attempts
       set status = 'pending', updated_at = now()
     where reference = ${params.reference} and status = 'created'
  `;
}

export type IngestOutcome =
  | { outcome: 'duplicate'; reference: string }
  | { outcome: 'unknown_reference'; reference: string }
  | { outcome: 'unverified' }
  | { outcome: 'recorded'; reference: string; status: AttemptStatus; invoiceSettled: boolean };

export interface IncomingProviderEvent {
  providerEventId: string;
  eventType: string;
  reference: string;
  providerReference: string | null;
  status: 'pending' | 'confirmed' | 'failed' | 'cancelled';
  amountMinor: number | null;
  feeMinor: number | null;
  netMinor: number | null;
}

/**
 * A provider's word, once it has been checked.
 *
 * Runs on the privileged connection: there is no session — a provider is not a
 * user — and `webhook_events` is readable by nobody through the application
 * role. Everything that makes this safe is done before it is called (the
 * signature) or inside it (dedupe, amount, the one state transition).
 *
 * `signatureVerified` is passed in rather than inferred, and an unverified
 * event is still **recorded**. An attacker posting rubbish at the notification
 * endpoint is worth being able to see afterwards, and the row is the only
 * place that could show it.
 *
 * Deduplication is the unique index on `(provider, provider_event_id)` doing
 * the work rather than a read-then-write: providers retry, two retries can
 * arrive at once, and a check followed by an insert would let both through.
 */
export async function ingestProviderEvent(
  tx: Sql,
  params: {
    provider: string;
    signatureVerified: boolean;
    payload: unknown;
    event: IncomingProviderEvent | null;
  },
): Promise<IngestOutcome> {
  // An event that could not be verified has no trustworthy id, so it is
  // recorded under one of ours and changes nothing.
  if (!params.signatureVerified || !params.event) {
    await tx`
      insert into webhook_events (
        provider, provider_event_id, event_type, signature_verified, payload,
        processed_at, processing_result
      ) values (
        ${params.provider}, ${`unverified-${randomBytes(8).toString('hex')}`},
        'unverified', false, ${JSON.stringify(params.payload)}::jsonb,
        now(), 'refused: signature could not be verified'
      )
    `;
    return { outcome: 'unverified' };
  }

  const event = params.event;
  const [stored] = await tx<{ id: string }[]>`
    insert into webhook_events (
      provider, provider_event_id, event_type, signature_verified, payload
    ) values (
      ${params.provider}, ${event.providerEventId}, ${event.eventType}, true,
      ${JSON.stringify(params.payload)}::jsonb
    )
    on conflict (provider, provider_event_id) do nothing
    returning id::text
  `;
  if (!stored) return { outcome: 'duplicate', reference: event.reference };

  const [attempt] = await tx<{
    id: string; invoice_id: string; organisation_id: string; amount_minor: string;
    status: string;
  }[]>`
    select id::text, invoice_id::text, organisation_id::text, amount_minor::text, status
      from subscription_payment_attempts
     where reference = ${event.reference}
     for update
  `;
  if (!attempt) {
    await tx`
      update webhook_events
         set processed_at = now(),
             processing_result = ${`no attempt with reference ${event.reference}`}
       where id = ${stored.id}::uuid
    `;
    return { outcome: 'unknown_reference', reference: event.reference };
  }

  // Already settled by an earlier event: a provider that sends `confirmed`
  // twice under two event ids must not produce two payments.
  if (attempt.status === 'confirmed') {
    await tx`
      update webhook_events set processed_at = now(),
             processing_result = 'attempt already confirmed'
       where id = ${stored.id}::uuid
    `;
    return {
      outcome: 'recorded', reference: event.reference, status: 'confirmed',
      invoiceSettled: true,
    };
  }

  let invoiceSettled = false;

  if (event.status === 'confirmed') {
    const paid = event.amountMinor ?? 0;
    await tx`
      update subscription_payment_attempts
         set status = 'confirmed', updated_at = now(), confirmed_at = now(),
             provider_reference = ${event.providerReference},
             amount_confirmed_minor = ${paid},
             fee_minor = ${event.feeMinor}, net_minor = ${event.netMinor},
             webhook_event_id = ${stored.id}::uuid
       where id = ${attempt.id}::uuid
    `;

    // The same rule the manual path has always followed: a short payment is
    // recorded as what arrived and leaves the invoice issued. Marking it
    // settled for less than it says would make what customers owe quietly
    // wrong.
    const [invoice] = await tx<{ total_minor: string; paid_minor: string | null }[]>`
      select total_minor::text, paid_minor::text from subscription_invoices
      where id = ${attempt.invoice_id}::uuid
    `;
    const already = Number(invoice?.paid_minor ?? 0);
    const total = Number(invoice?.total_minor ?? 0);
    const paidNow = already + paid;
    invoiceSettled = paidNow >= total;

    await tx`
      update subscription_invoices
         set status = ${invoiceSettled ? 'paid' : 'issued'},
             paid_on = ${invoiceSettled ? tx`current_date` : tx`null`},
             paid_minor = ${paidNow},
             payment_reference = ${event.providerReference ?? event.reference}
             -- payment_recorded_by stays null: no operator recorded this, a
             -- provider did, and the attempt row says which one.
       where id = ${attempt.invoice_id}::uuid and status = 'issued'
    `;
  } else if (event.status === 'pending') {
    await tx`
      update subscription_payment_attempts
         set status = 'pending', updated_at = now(),
             provider_reference = ${event.providerReference}
       where id = ${attempt.id}::uuid
    `;
  } else {
    await tx`
      update subscription_payment_attempts
         set status = ${event.status}, updated_at = now(),
             provider_reference = ${event.providerReference},
             failure_reason = ${event.eventType}
       where id = ${attempt.id}::uuid
    `;
  }

  await tx`
    update webhook_events
       set processed_at = now(),
           processing_result = ${`attempt ${event.reference} -> ${event.status}`}
     where id = ${stored.id}::uuid
  `;

  await recordAudit(tx, {
    organisationId: attempt.organisation_id,
    actorUserId: null,
    action: `subscription.payment.${event.status}`,
    resourceType: 'subscription_invoice',
    resourceId: attempt.invoice_id,
    reason: `${params.provider} reported ${event.status} for ${event.reference}.`,
    before: { status: attempt.status },
    after: {
      status: event.status,
      amountMinor: event.amountMinor,
      invoiceSettled,
      providerReference: event.providerReference,
    },
  });

  return { outcome: 'recorded', reference: event.reference, status: event.status, invoiceSettled };
}

/** The attempts against one invoice, for whoever may see the invoice. */
export async function invoicePaymentAttempts(
  tx: Sql,
  invoiceId: string,
): Promise<PaymentAttempt[]> {
  const rows = await tx<{
    id: string; invoice_id: string; invoice_number: string; provider: string;
    reference: string; amount_minor: string; currency_code: string; status: AttemptStatus;
    started_by_name: string | null; created_at: string; provider_reference: string | null;
    confirmed_at: string | null; amount_confirmed_minor: string | null;
    fee_minor: string | null; net_minor: string | null; failure_reason: string | null;
  }[]>`
    select a.id::text, a.invoice_id::text, i.invoice_number, a.provider, a.reference,
           a.amount_minor::text, a.currency_code, a.status, who.full_name as started_by_name,
           a.created_at::text, a.provider_reference, a.confirmed_at::text,
           a.amount_confirmed_minor::text, a.fee_minor::text, a.net_minor::text,
           a.failure_reason
      from subscription_payment_attempts a
      join subscription_invoices i on i.id = a.invoice_id
      left join user_profiles who on who.auth_user_id = a.started_by
     where a.invoice_id = ${invoiceId}::uuid
     order by a.created_at desc
  `;
  const number = (value: string | null) => (value === null ? null : Number(value));
  return rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    provider: row.provider,
    reference: row.reference,
    amountMinor: Number(row.amount_minor),
    currencyCode: row.currency_code,
    status: row.status,
    startedByName: row.started_by_name,
    createdAt: row.created_at,
    providerReference: row.provider_reference,
    confirmedAt: row.confirmed_at,
    amountConfirmedMinor: number(row.amount_confirmed_minor),
    feeMinor: number(row.fee_minor),
    netMinor: number(row.net_minor),
    failureReason: row.failure_reason,
  }));
}

/**
 * Payments in flight, by invoice, for the operator recording bank transfers.
 *
 * The case it exists for: a customer pays by card, the notification has not
 * arrived yet, and an operator reading the bank statement records a transfer
 * against the same invoice. Two credits for one debt, and the customer's next
 * statement is wrong. The billing screen shows this beside the invoice so the
 * operator can wait.
 *
 * Readable by any operator — `subscription_payment_attempts` carries a
 * platform select policy — and it returns references and providers, not
 * anybody's details.
 */
export async function openPaymentAttempts(
  tx: Sql,
): Promise<Map<string, { reference: string; provider: string; startedAt: string }>> {
  const rows = await tx<{
    invoice_id: string; reference: string; provider: string; created_at: string;
  }[]>`
    select invoice_id::text, reference, provider, created_at::text
      from subscription_payment_attempts
     where status in ('created', 'pending')
       and created_at > now() - interval '7 days'
     order by created_at desc
  `;
  const byInvoice = new Map<string, { reference: string; provider: string; startedAt: string }>();
  for (const row of rows) {
    if (!byInvoice.has(row.invoice_id)) {
      byInvoice.set(row.invoice_id, {
        reference: row.reference, provider: row.provider, startedAt: row.created_at,
      });
    }
  }
  return byInvoice;
}

/** One attempt, by the reference a provider echoes back. */
export async function paymentAttemptByReference(
  tx: Sql,
  reference: string,
): Promise<PaymentAttempt | null> {
  const [row] = await tx<{ invoice_id: string }[]>`
    select invoice_id::text from subscription_payment_attempts where reference = ${reference}
  `;
  if (!row) return null;
  const attempts = await invoicePaymentAttempts(tx, row.invoice_id);
  return attempts.find((a) => a.reference === reference) ?? null;
}
