import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { lastFour, sealField } from '@propertyos/integrations';
import { recordAudit } from './audit';
import { forbidden, invalid, notFound, parsed } from './errors';
import { requirePermission } from './permissions';
import { markEventProcessed, recordUnverifiedEvent, recordVerifiedEvent } from './provider-events';

/**
 * A customer's standing authority for Spike to collect by debit order.
 *
 * 0083 let somebody press Pay. This is how a subscription business is actually
 * paid in South Africa — a mandate the payer authenticated through their own
 * bank, against which collections are later instructed.
 *
 * The authority is the regulated artefact and the module is arranged around
 * protecting it:
 *
 *   * the terms are **capped and immutable**. A maximum amount, a day, a start
 *     date; changing any of them means cancelling and asking the payer to
 *     authenticate another, which a trigger enforces rather than a convention.
 *   * only a **verified provider event** may authenticate one, exactly as with
 *     a confirmed payment. A screen that says "authorised" proves nothing
 *     about what the payer's bank did.
 *   * the **payer may withdraw it at any time**, including through their own
 *     bank without telling us, which is why cancellation arrives as an event
 *     as well as being something the customer can do here.
 *
 * What this module does NOT contain is a collection. Instructing a bank to
 * take money is the next piece of work and needs the sponsoring relationship;
 * the authority has to exist first, and has to be impossible to fabricate
 * afterwards.
 */

export type MandateStatus =
  | 'requested' | 'authenticated' | 'suspended' | 'cancelled' | 'rejected';

export interface SubscriptionMandate {
  id: string;
  organisationId: string;
  provider: string;
  reference: string;
  providerReference: string | null;
  status: MandateStatus;
  authorisedAmountMinor: number;
  currencyCode: string;
  collectionDay: number;
  firstCollectionOn: string;
  frequency: 'monthly';
  accountHolder: string;
  bankName: string;
  branchCode: string;
  accountType: 'cheque' | 'savings' | 'transmission';
  /** The last four digits. The number itself is sealed and is not read here. */
  accountNumberLast4: string;
  requestedByName: string | null;
  requestedAt: string;
  authenticatedAt: string | null;
  rejectionReason: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancellationReason: string | null;
  cancelledByPayer: boolean | null;
}

/**
 * South African bank account details, as a debit order needs them.
 *
 * The branch code is six digits — the universal branch code every South
 * African bank publishes — and the account number is eight to eleven digits
 * depending on the bank, so the range is deliberately wide rather than
 * pretending to know each bank's rule. What is NOT validated here is whether
 * the account exists or belongs to this customer: only the payer's bank can
 * say that, and it says it by authenticating the mandate.
 */
const requestSchema = z.object({
  organisationId: z.string().uuid(),
  provider: z.string().min(1).max(40),
  authorisedAmountMinor: z.number().int().positive().max(100_000_000),
  currencyCode: z.string().length(3),
  collectionDay: z.number().int().min(1).max(31),
  firstCollectionOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountHolder: z.string().trim().min(2).max(120),
  bankName: z.string().trim().min(2).max(80),
  branchCode: z.string().trim().regex(/^\d{6}$/, 'A branch code is six digits.'),
  accountType: z.enum(['cheque', 'savings', 'transmission']),
  accountNumber: z.string().trim().regex(/^\d{6,11}$/, 'An account number is 6 to 11 digits.'),
});

const COLUMNS = `
  m.id::text, m.organisation_id::text, m.provider, m.reference, m.provider_reference,
  m.status, m.authorised_amount_minor::text, m.currency_code, m.collection_day,
  m.first_collection_on::text, m.frequency, m.account_holder, m.bank_name, m.branch_code,
  m.account_type, m.account_number_last4, asker.full_name as requested_by_name,
  m.requested_at::text, m.authenticated_at::text, m.rejection_reason,
  m.suspended_at::text, m.suspension_reason, m.cancelled_at::text,
  canceller.full_name as cancelled_by_name, m.cancellation_reason, m.cancelled_by_payer
`;

interface MandateRow {
  id: string; organisation_id: string; provider: string; reference: string;
  provider_reference: string | null; status: MandateStatus;
  authorised_amount_minor: string; currency_code: string; collection_day: number;
  first_collection_on: string; frequency: 'monthly'; account_holder: string;
  bank_name: string; branch_code: string;
  account_type: 'cheque' | 'savings' | 'transmission'; account_number_last4: string;
  requested_by_name: string | null; requested_at: string; authenticated_at: string | null;
  rejection_reason: string | null; suspended_at: string | null;
  suspension_reason: string | null; cancelled_at: string | null;
  cancelled_by_name: string | null; cancellation_reason: string | null;
  cancelled_by_payer: boolean | null;
}

function map(row: MandateRow): SubscriptionMandate {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    provider: row.provider,
    reference: row.reference,
    providerReference: row.provider_reference,
    status: row.status,
    authorisedAmountMinor: Number(row.authorised_amount_minor),
    currencyCode: row.currency_code,
    collectionDay: row.collection_day,
    firstCollectionOn: row.first_collection_on,
    frequency: row.frequency,
    accountHolder: row.account_holder,
    bankName: row.bank_name,
    branchCode: row.branch_code,
    accountType: row.account_type,
    accountNumberLast4: row.account_number_last4,
    requestedByName: row.requested_by_name,
    requestedAt: row.requested_at,
    authenticatedAt: row.authenticated_at,
    rejectionReason: row.rejection_reason,
    suspendedAt: row.suspended_at,
    suspensionReason: row.suspension_reason,
    cancelledAt: row.cancelled_at,
    cancelledByName: row.cancelled_by_name,
    cancellationReason: row.cancellation_reason,
    cancelledByPayer: row.cancelled_by_payer,
  };
}

/**
 * Asking the payer to authorise a collection.
 *
 * Takes `organisation.settings.manage`, the permission that already reads the
 * invoices this mandate will pay. The row it creates authorises nothing: it is
 * `requested` until the payer's bank says otherwise, and the insert policy
 * refuses anything else.
 *
 * The account number is sealed on the way in, with the organisation as the
 * context — the same treatment `bank_accounts` and the lease refund account
 * get. Only the last four are kept in the clear, which is all any screen needs.
 */
export async function requestMandate(
  tx: Sql,
  authUserId: string,
  params: z.input<typeof requestSchema>,
): Promise<{ mandateId: string; reference: string }> {
  const input = parsed(requestSchema, params);
  await requirePermission(tx, input.organisationId, 'organisation.settings.manage');

  const [live] = await tx<{ reference: string; status: string }[]>`
    select reference, status from subscription_mandates
    where organisation_id = ${input.organisationId}::uuid
      and status in ('requested', 'authenticated', 'suspended')
  `;
  if (live) {
    throw invalid(
      live.status === 'requested'
        ? 'A mandate has already been requested and is waiting for your bank. Cancel it '
          + 'if you want to start again.'
        : 'This account already has a live debit order mandate. Cancel it before setting '
          + 'up another, so that only one authority exists over the account at a time.',
    );
  }

  const reference = `MAN-${randomBytes(9).toString('base64url')}`;
  const [row] = await tx<{ id: string }[]>`
    insert into subscription_mandates (
      organisation_id, provider, reference, authorised_amount_minor, currency_code,
      collection_day, first_collection_on, account_holder, bank_name, branch_code,
      account_type, account_number_cipher, account_number_last4, status, requested_by
    ) values (
      ${input.organisationId}::uuid, ${input.provider}, ${reference},
      ${input.authorisedAmountMinor}, ${input.currencyCode}, ${input.collectionDay},
      ${input.firstCollectionOn}::date, ${input.accountHolder}, ${input.bankName},
      ${input.branchCode}, ${input.accountType},
      ${sealField(input.accountNumber, `mandate_account:${input.organisationId}`)},
      ${lastFour(input.accountNumber)}, 'requested', ${authUserId}::uuid
    )
    returning id::text
  `;
  if (!row) throw forbidden('That mandate could not be requested.');

  await recordAudit(tx, {
    organisationId: input.organisationId,
    actorUserId: authUserId,
    action: 'subscription.mandate.requested',
    resourceType: 'subscription_mandate',
    resourceId: row.id,
    reason: `Debit order mandate requested, up to ${input.authorisedAmountMinor} on day ${input.collectionDay}.`,
    before: null,
    // No account number, sealed or otherwise: the audit trail is read by more
    // people than the mandate is.
    after: {
      reference,
      authorisedAmountMinor: input.authorisedAmountMinor,
      collectionDay: input.collectionDay,
      bank: input.bankName,
      accountEndsWith: lastFour(input.accountNumber),
    },
  });

  return { mandateId: row.id, reference };
}

/** Every mandate this customer has had, newest first. */
export async function organisationMandates(
  tx: Sql,
  organisationId: string,
): Promise<SubscriptionMandate[]> {
  const rows = await tx<MandateRow[]>`
    select ${tx.unsafe(COLUMNS)}
      from subscription_mandates m
      left join user_profiles asker on asker.auth_user_id = m.requested_by
      left join user_profiles canceller on canceller.auth_user_id = m.cancelled_by
     where m.organisation_id = ${organisationId}::uuid
     order by m.requested_at desc
  `;
  return rows.map(map);
}

/** The one that is live, if there is one. */
export async function liveMandate(
  tx: Sql,
  organisationId: string,
): Promise<SubscriptionMandate | null> {
  const all = await organisationMandates(tx, organisationId);
  return all.find((m) => ['requested', 'authenticated', 'suspended'].includes(m.status)) ?? null;
}

/**
 * Ending it.
 *
 * Runs privileged because there is deliberately no UPDATE policy on the table:
 * the authorisation record is not editable by the role that serves web
 * requests. The permission check is still made here, in SQL, against the
 * caller's own identity.
 *
 * This is the PAYER withdrawing their authority, and the row records it as
 * theirs. Spike ending its own collection facility is a different event with
 * different consequences and is not built: the column that distinguishes them
 * exists so that when it is, nobody has to infer which happened from a
 * sentence somebody typed.
 */
export async function cancelMandate(
  tx: Sql,
  authUserId: string,
  params: { mandateId: string; reason: string },
): Promise<void> {
  if (params.reason.trim().length < 5) {
    throw invalid('Cancelling a mandate needs a reason: it is an authorisation record.');
  }

  const [mandate] = await tx<{ organisation_id: string; status: string; reference: string }[]>`
    select organisation_id::text, status, reference from subscription_mandates
    where id = ${params.mandateId}::uuid
    for update
  `;
  if (!mandate) throw notFound('Mandate');
  if (['cancelled', 'rejected'].includes(mandate.status)) {
    throw invalid('That mandate is already over.');
  }

  await requirePermission(tx, mandate.organisation_id, 'organisation.settings.manage');

  await tx`
    update subscription_mandates
       set status = 'cancelled', cancelled_at = now(), cancelled_by = ${authUserId}::uuid,
           cancellation_reason = ${params.reason}, cancelled_by_payer = true,
           updated_at = now()
     where id = ${params.mandateId}::uuid
  `;

  await recordAudit(tx, {
    organisationId: mandate.organisation_id,
    actorUserId: authUserId,
    action: 'subscription.mandate.cancelled',
    resourceType: 'subscription_mandate',
    resourceId: params.mandateId,
    reason: params.reason,
    before: { status: mandate.status },
    after: { status: 'cancelled', byPayer: true },
  });
}

export type MandateIngestOutcome =
  | { outcome: 'unverified' }
  | { outcome: 'duplicate'; reference: string }
  | { outcome: 'unknown_reference'; reference: string }
  | { outcome: 'recorded'; reference: string; status: MandateStatus };

export interface IncomingMandateEvent {
  providerEventId: string;
  eventType: string;
  reference: string;
  providerReference: string | null;
  status: 'authenticated' | 'rejected' | 'cancelled';
  reason: string | null;
}

/**
 * The payer's bank, by way of the provider.
 *
 * The only path that can authenticate a mandate, which is why it is the only
 * path that may write the status — on the privileged connection, from the
 * notification endpoint, after a signature has been checked.
 *
 * A `cancelled` event is the case worth reading twice: a payer can withdraw a
 * debit order authority through their own bank without telling the beneficiary
 * at all. So cancellation arriving unprompted is normal, not an anomaly, and
 * it is recorded as the payer's decision because that is what it is.
 */
export async function ingestMandateEvent(
  tx: Sql,
  params: {
    provider: string;
    signatureVerified: boolean;
    payload: unknown;
    event: IncomingMandateEvent | null;
  },
): Promise<MandateIngestOutcome> {
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

  const [mandate] = await tx<{ id: string; organisation_id: string; status: string }[]>`
    select id::text, organisation_id::text, status from subscription_mandates
    where reference = ${event.reference}
    for update
  `;
  if (!mandate) {
    await markEventProcessed(tx, {
      eventId: stored.eventId,
      result: `no mandate with reference ${event.reference}`,
    });
    return { outcome: 'unknown_reference', reference: event.reference };
  }

  if (['cancelled', 'rejected'].includes(mandate.status)) {
    await markEventProcessed(tx, {
      eventId: stored.eventId, result: `mandate already ${mandate.status}`,
    });
    return { outcome: 'recorded', reference: event.reference, status: mandate.status as MandateStatus };
  }

  if (event.status === 'authenticated') {
    await tx`
      update subscription_mandates
         set status = 'authenticated', authenticated_at = now(),
             authentication_event_id = ${stored.eventId}::uuid,
             provider_reference = ${event.providerReference}, updated_at = now()
       where id = ${mandate.id}::uuid and status = 'requested'
    `;
  } else if (event.status === 'rejected') {
    await tx`
      update subscription_mandates
         set status = 'rejected', rejection_reason = ${event.reason ?? event.eventType},
             provider_reference = ${event.providerReference}, updated_at = now()
       where id = ${mandate.id}::uuid
    `;
  } else {
    // Withdrawn by the payer, usually at their own bank. Recorded as theirs.
    await tx`
      update subscription_mandates
         set status = 'cancelled', cancelled_at = now(), cancelled_by_payer = true,
             cancellation_reason = ${event.reason ?? 'Withdrawn by the account holder at their bank'},
             provider_reference = ${event.providerReference}, updated_at = now()
       where id = ${mandate.id}::uuid
    `;
  }

  await markEventProcessed(tx, {
    eventId: stored.eventId,
    result: `mandate ${event.reference} -> ${event.status}`,
  });

  await recordAudit(tx, {
    organisationId: mandate.organisation_id,
    actorUserId: null,
    action: `subscription.mandate.${event.status}`,
    resourceType: 'subscription_mandate',
    resourceId: mandate.id,
    reason: `${params.provider} reported ${event.status} for ${event.reference}.`,
    before: { status: mandate.status },
    after: { status: event.status, providerReference: event.providerReference },
  });

  return {
    outcome: 'recorded',
    reference: event.reference,
    status: event.status === 'authenticated' ? 'authenticated'
      : event.status === 'rejected' ? 'rejected' : 'cancelled',
  };
}

/**
 * The account number, opened.
 *
 * Deliberately a function of its own with a narrow caller: the collection
 * instruction that will one day be submitted to a bank needs the whole number,
 * and nothing else in this product does. Keeping it out of `organisationMandates`
 * means no screen can leak it by accident.
 */
export async function openMandateAccountNumber(
  tx: Sql,
  mandateId: string,
): Promise<string | null> {
  const { openField } = await import('@propertyos/integrations');
  const [row] = await tx<{ organisation_id: string; cipher: Buffer }[]>`
    select organisation_id::text, account_number_cipher as cipher
      from subscription_mandates where id = ${mandateId}::uuid
  `;
  if (!row) return null;
  return openField(row.cipher, `mandate_account:${row.organisation_id}`);
}
