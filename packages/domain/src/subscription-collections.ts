import { randomBytes } from 'node:crypto';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { forbidden, invalid } from './errors';
import { applyFundsToInvoice, reverseFundsOnInvoice } from './invoice-settlement';
import { requirePlatformPermission } from './platform';
import { markEventProcessed, recordUnverifiedEvent, recordVerifiedEvent } from './provider-events';

/**
 * Taking the money the payer authorised.
 *
 * 0084 recorded the authority; this uses it. The arrangement is deliberately
 * three separate acts, because collapsing them is how a wrong number reaches
 * somebody's bank account:
 *
 *   * **prepare** — arithmetic over invoices and mandates. Produces
 *     instructions, takes nothing, and can be run again safely.
 *   * **submit** — hands an instruction to the provider. A person does this,
 *     not a timer.
 *   * **the outcome** — the bank's word, days later, through the notification
 *     endpoint, and the only thing that can mark a collection successful.
 *
 * The cap is enforced in the database, by a trigger that reads the mandate.
 * This module still checks it, so that a customer gets a sentence rather than
 * a constraint violation — but the enforcement is not here, because the thing
 * that must not be possible should not depend on the code that happens to be
 * asking.
 */

export type CollectionStatus =
  | 'prepared' | 'submitted' | 'successful' | 'unpaid' | 'disputed' | 'abandoned';

export interface Collection {
  id: string;
  organisationId: string;
  organisationName: string;
  invoiceId: string;
  invoiceNumber: string;
  mandateId: string;
  mandateReference: string;
  reference: string;
  provider: string;
  providerReference: string | null;
  amountMinor: number;
  currencyCode: string;
  actionDate: string;
  status: CollectionStatus;
  preparedAt: string;
  submittedAt: string | null;
  outcomeAt: string | null;
  unpaidReason: string | null;
  disputeReason: string | null;
  abandonedReason: string | null;
  accountNumberLast4: string;
}

export interface PreparedRun {
  actionDate: string;
  prepared: Array<{ organisationName: string; invoiceNumber: string; amountMinor: number }>;
  /** Named rather than counted: an operator needs to know who is NOT being collected from. */
  skipped: Array<{ organisationName: string; invoiceNumber: string; reason: string }>;
  totalMinor: number;
}

const COLUMNS = `
  c.id::text, c.organisation_id::text, o.name as organisation_name, c.invoice_id::text,
  i.invoice_number, c.mandate_id::text, m.reference as mandate_reference, c.reference,
  c.provider, c.provider_reference, c.amount_minor::text, c.currency_code,
  c.action_date::text, c.status, c.prepared_at::text, c.submitted_at::text,
  c.outcome_at::text, c.unpaid_reason, c.dispute_reason, c.abandoned_reason,
  m.account_number_last4
`;

interface Row {
  id: string; organisation_id: string; organisation_name: string; invoice_id: string;
  invoice_number: string; mandate_id: string; mandate_reference: string; reference: string;
  provider: string; provider_reference: string | null; amount_minor: string;
  currency_code: string; action_date: string; status: CollectionStatus; prepared_at: string;
  submitted_at: string | null; outcome_at: string | null; unpaid_reason: string | null;
  dispute_reason: string | null; abandoned_reason: string | null; account_number_last4: string;
}

const map = (row: Row): Collection => ({
  id: row.id,
  organisationId: row.organisation_id,
  organisationName: row.organisation_name,
  invoiceId: row.invoice_id,
  invoiceNumber: row.invoice_number,
  mandateId: row.mandate_id,
  mandateReference: row.mandate_reference,
  reference: row.reference,
  provider: row.provider,
  providerReference: row.provider_reference,
  amountMinor: Number(row.amount_minor),
  currencyCode: row.currency_code,
  actionDate: row.action_date,
  status: row.status,
  preparedAt: row.prepared_at,
  submittedAt: row.submitted_at,
  outcomeAt: row.outcome_at,
  unpaidReason: row.unpaid_reason,
  disputeReason: row.dispute_reason,
  abandonedReason: row.abandoned_reason,
  accountNumberLast4: row.account_number_last4,
});

/**
 * The monthly run: what would be collected, prepared but not sent.
 *
 * Runs privileged — there is no insert policy for the application role on
 * collections at all — with `platform.billing.manage` checked first.
 *
 * Two rules in the arithmetic worth stating.
 *
 * It collects **what is outstanding**, not what the invoice says, so a part
 * payment already received is not debited twice.
 *
 * And where the outstanding amount exceeds what the payer authorised, it
 * **skips and says so** rather than taking the cap. Debiting the cap would
 * leave an invoice short-paid that nobody decided to short-pay, and the fix is
 * a conversation with the customer about their mandate — which the skip reason
 * tells the operator to have.
 */
export async function prepareCollections(
  tx: Sql,
  authUserId: string,
  params: { actionDate: string },
): Promise<PreparedRun> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');

  const candidates = await tx<{
    mandate_id: string; organisation_id: string; organisation_name: string;
    authorised_amount_minor: string; first_collection_on: string; mandate_status: string;
    invoice_id: string; invoice_number: string; outstanding_minor: string;
    currency_code: string; live_collection: string | null;
  }[]>`
    select m.id::text as mandate_id, m.organisation_id::text, o.name as organisation_name,
           m.authorised_amount_minor::text, m.first_collection_on::text,
           m.status as mandate_status,
           i.id::text as invoice_id, i.invoice_number,
           (i.total_minor - coalesce(i.paid_minor, 0))::text as outstanding_minor,
           i.currency_code,
           (select c.reference from subscription_collections c
             where c.invoice_id = i.id
               and c.status in ('prepared', 'submitted', 'successful')
             limit 1) as live_collection
      from subscription_mandates m
      join organisations o on o.id = m.organisation_id
      join subscription_invoices i on i.organisation_id = m.organisation_id
     where m.status = 'authenticated'
       and i.status = 'issued'
       and i.total_minor > coalesce(i.paid_minor, 0)
     order by o.name, i.invoice_number
  `;

  const prepared: PreparedRun['prepared'] = [];
  const skipped: PreparedRun['skipped'] = [];
  let totalMinor = 0;

  for (const row of candidates) {
    const outstanding = Number(row.outstanding_minor);
    const authorised = Number(row.authorised_amount_minor);
    const named = { organisationName: row.organisation_name, invoiceNumber: row.invoice_number };

    if (row.live_collection) {
      skipped.push({ ...named, reason: `already has a collection (${row.live_collection})` });
      continue;
    }
    if (params.actionDate < row.first_collection_on) {
      skipped.push({
        ...named,
        reason: `their mandate starts on ${row.first_collection_on}`,
      });
      continue;
    }
    if (outstanding > authorised) {
      skipped.push({
        ...named,
        reason: `owes ${outstanding} and authorised ${authorised} — ask them to authorise more, `
          + 'or take it another way',
      });
      continue;
    }

    const reference = `COL-${randomBytes(9).toString('base64url')}`;
    await tx`
      insert into subscription_collections (
        mandate_id, organisation_id, invoice_id, reference, provider, amount_minor,
        currency_code, action_date, status, prepared_by
      )
      select ${row.mandate_id}::uuid, ${row.organisation_id}::uuid, ${row.invoice_id}::uuid,
             ${reference}, m.provider, ${outstanding}, ${row.currency_code},
             ${params.actionDate}::date, 'prepared', ${operator.authUserId}::uuid
        from subscription_mandates m where m.id = ${row.mandate_id}::uuid
    `;
    prepared.push({ ...named, amountMinor: outstanding });
    totalMinor += outstanding;
  }

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: operator.authUserId,
    action: 'subscription.collections.prepared',
    resourceType: 'subscription_collection_run',
    resourceId: null,
    reason: `Prepared ${prepared.length} collection(s) for ${params.actionDate}.`,
    before: null,
    after: { actionDate: params.actionDate, prepared: prepared.length, skipped: skipped.length, totalMinor },
  });

  return { actionDate: params.actionDate, prepared, skipped, totalMinor };
}

/** Everything prepared, in flight, or finished. */
export async function listCollections(
  tx: Sql,
  authUserId: string,
  options: { status?: CollectionStatus } = {},
): Promise<Collection[]> {
  await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const rows = await tx<Row[]>`
    select ${tx.unsafe(COLUMNS)}
      from subscription_collections c
      join organisations o on o.id = c.organisation_id
      join subscription_invoices i on i.id = c.invoice_id
      join subscription_mandates m on m.id = c.mandate_id
     where ${options.status ? tx`c.status = ${options.status}` : tx`true`}
     order by c.action_date desc, o.name
     limit 500
  `;
  return rows.map(map);
}

/** What a customer can see of what will be taken from their account. */
export async function organisationCollections(
  tx: Sql,
  organisationId: string,
): Promise<Collection[]> {
  const rows = await tx<Row[]>`
    select ${tx.unsafe(COLUMNS)}
      from subscription_collections c
      join organisations o on o.id = c.organisation_id
      join subscription_invoices i on i.id = c.invoice_id
      join subscription_mandates m on m.id = c.mandate_id
     where c.organisation_id = ${organisationId}::uuid
     order by c.action_date desc
     limit 50
  `;
  return rows.map(map);
}

/** One prepared instruction, with everything a provider needs to be given. */
export async function collectionForSubmission(
  tx: Sql,
  authUserId: string,
  collectionId: string,
): Promise<{
  collection: Collection;
  mandateId: string;
  accountHolder: string;
  bankName: string;
  branchCode: string;
  accountType: 'cheque' | 'savings' | 'transmission';
  providerMandateReference: string | null;
} | null> {
  await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const [row] = await tx<(Row & {
    account_holder: string; bank_name: string; branch_code: string;
    account_type: 'cheque' | 'savings' | 'transmission';
    provider_mandate_reference: string | null; mandate_status: string;
  })[]>`
    select ${tx.unsafe(COLUMNS)}, m.account_holder, m.bank_name, m.branch_code,
           m.account_type, m.provider_reference as provider_mandate_reference,
           m.status as mandate_status
      from subscription_collections c
      join organisations o on o.id = c.organisation_id
      join subscription_invoices i on i.id = c.invoice_id
      join subscription_mandates m on m.id = c.mandate_id
     where c.id = ${collectionId}::uuid
  `;
  if (!row) return null;
  if (row.status !== 'prepared') {
    throw invalid(`That collection is ${row.status}, so it cannot be submitted.`);
  }
  // The authority can be withdrawn between preparing and submitting, and a
  // payer who cancels on the 30th must not be debited on the 1st.
  if (row.mandate_status !== 'authenticated') {
    throw invalid(
      `That customer's mandate is ${row.mandate_status}. Nothing may be collected against it.`,
    );
  }
  return {
    collection: map(row),
    mandateId: row.mandate_id,
    accountHolder: row.account_holder,
    bankName: row.bank_name,
    branchCode: row.branch_code,
    accountType: row.account_type,
    providerMandateReference: row.provider_mandate_reference,
  };
}

/** It has gone to the provider. Not that it worked. */
export async function markCollectionSubmitted(
  tx: Sql,
  authUserId: string,
  params: { collectionId: string; providerReference: string },
): Promise<void> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const [row] = await tx<{ organisation_id: string; reference: string }[]>`
    update subscription_collections
       set status = 'submitted', submitted_at = now(), submitted_by = ${operator.authUserId}::uuid,
           provider_reference = ${params.providerReference}, updated_at = now()
     where id = ${params.collectionId}::uuid and status = 'prepared'
    returning organisation_id::text, reference
  `;
  if (!row) throw forbidden('That collection could not be submitted.');

  await recordAudit(tx, {
    organisationId: row.organisation_id,
    actorUserId: operator.authUserId,
    action: 'subscription.collection.submitted',
    resourceType: 'subscription_collection',
    resourceId: params.collectionId,
    reason: `Collection ${row.reference} submitted to the provider.`,
    before: { status: 'prepared' },
    after: { status: 'submitted', providerReference: params.providerReference },
  });
}

/** Deciding not to collect one after all. */
export async function abandonCollection(
  tx: Sql,
  authUserId: string,
  params: { collectionId: string; reason: string },
): Promise<void> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  if (params.reason.trim().length < 5) throw invalid('Say why it is not being collected.');

  const [row] = await tx<{ organisation_id: string; status: string }[]>`
    update subscription_collections
       set status = 'abandoned', abandoned_reason = ${params.reason}, updated_at = now()
     where id = ${params.collectionId}::uuid and status in ('prepared', 'unpaid')
    returning organisation_id::text, status
  `;
  if (!row) {
    throw invalid('Only a prepared or unpaid collection can be abandoned. A submitted one is '
      + 'with the bank, and a successful one took money.');
  }

  await recordAudit(tx, {
    organisationId: row.organisation_id,
    actorUserId: operator.authUserId,
    action: 'subscription.collection.abandoned',
    resourceType: 'subscription_collection',
    resourceId: params.collectionId,
    reason: params.reason,
    before: null,
    after: { status: 'abandoned' },
  });
}

export type CollectionIngestOutcome =
  | { outcome: 'unverified' }
  | { outcome: 'duplicate'; reference: string }
  | { outcome: 'unknown_reference'; reference: string }
  | { outcome: 'recorded'; reference: string; status: CollectionStatus; invoiceSettled: boolean };

export interface IncomingCollectionEvent {
  providerEventId: string;
  eventType: string;
  reference: string;
  providerReference: string | null;
  status: 'successful' | 'unpaid' | 'disputed';
  amountMinor: number | null;
  reason: string | null;
}

/**
 * The bank's word, by way of the provider.
 *
 * The only path that can mark a collection successful, and therefore the only
 * path that can settle an invoice from a debit order.
 *
 * `disputed` is the one to read twice. A payer can challenge a debit after it
 * succeeded and have their bank reverse it, which means the money never really
 * arrived — so the invoice goes back to owing what it owed. That is an undoing
 * rather than a credit note, and `reverseFundsOnInvoice` is what says so.
 */
export async function ingestCollectionEvent(
  tx: Sql,
  params: {
    provider: string;
    signatureVerified: boolean;
    payload: unknown;
    event: IncomingCollectionEvent | null;
  },
): Promise<CollectionIngestOutcome> {
  if (!params.signatureVerified || !params.event) {
    await recordUnverifiedEvent(tx, { provider: params.provider, payload: params.payload });
    return { outcome: 'unverified' };
  }

  const event = params.event;
  const stored = await recordVerifiedEvent(tx, {
    provider: params.provider,
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    payload: params.payload,
  });
  if (!stored) return { outcome: 'duplicate', reference: event.reference };

  const [collection] = await tx<{
    id: string; organisation_id: string; invoice_id: string; amount_minor: string; status: string;
  }[]>`
    select id::text, organisation_id::text, invoice_id::text, amount_minor::text, status
      from subscription_collections where reference = ${event.reference}
      for update
  `;
  if (!collection) {
    await markEventProcessed(tx, {
      eventId: stored.eventId,
      result: `no collection with reference ${event.reference}`,
    });
    return { outcome: 'unknown_reference', reference: event.reference };
  }

  let invoiceSettled = false;
  const instructed = Number(collection.amount_minor);

  if (event.status === 'successful') {
    if (collection.status === 'successful') {
      await markEventProcessed(tx, {
        eventId: stored.eventId, result: 'collection already successful',
      });
      return {
        outcome: 'recorded', reference: event.reference, status: 'successful',
        invoiceSettled: true,
      };
    }
    // A bank can take less than instructed. What arrived is what is recorded.
    const received = event.amountMinor ?? instructed;
    await tx`
      update subscription_collections
         set status = 'successful', outcome_at = now(),
             webhook_event_id = ${stored.eventId}::uuid,
             provider_reference = coalesce(${event.providerReference}, provider_reference),
             amount_minor = ${received}, updated_at = now()
       where id = ${collection.id}::uuid
    `;
    const settlement = await applyFundsToInvoice(tx, {
      invoiceId: collection.invoice_id,
      amountMinor: received,
      reference: event.providerReference ?? event.reference,
    });
    invoiceSettled = settlement.settled;
  } else if (event.status === 'unpaid') {
    await tx`
      update subscription_collections
         set status = 'unpaid', outcome_at = now(),
             unpaid_reason = ${event.reason ?? event.eventType},
             provider_reference = coalesce(${event.providerReference}, provider_reference),
             updated_at = now()
       where id = ${collection.id}::uuid
    `;
    // The invoice is untouched: nothing arrived, and it owes what it owed.
  } else {
    await tx`
      update subscription_collections
         set status = 'disputed', outcome_at = now(),
             dispute_reason = ${event.reason ?? event.eventType},
             provider_reference = coalesce(${event.providerReference}, provider_reference),
             updated_at = now()
       where id = ${collection.id}::uuid
    `;
    // Reversed by the payer's bank, so the settlement never really happened.
    if (collection.status === 'successful') {
      await reverseFundsOnInvoice(tx, {
        invoiceId: collection.invoice_id,
        amountMinor: instructed,
        reference: `${event.reference} disputed`,
      });
    }
  }

  await markEventProcessed(tx, {
    eventId: stored.eventId,
    result: `collection ${event.reference} -> ${event.status}`,
  });

  await recordAudit(tx, {
    organisationId: collection.organisation_id,
    actorUserId: null,
    action: `subscription.collection.${event.status}`,
    resourceType: 'subscription_collection',
    resourceId: collection.id,
    reason: `${params.provider} reported ${event.status} for ${event.reference}.`,
    before: { status: collection.status },
    after: { status: event.status, reason: event.reason, invoiceSettled },
  });

  return { outcome: 'recorded', reference: event.reference, status: event.status, invoiceSettled };
}
