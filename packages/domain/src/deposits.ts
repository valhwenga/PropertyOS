import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound, parsed } from './errors';
import { postJournal } from './ledger';
import type { Minor } from './money';
import { requirePermission } from './permissions';

/**
 * Deposits held for residents.
 *
 * A deposit is a LIABILITY. It is money the organisation holds on someone
 * else's behalf, it is never rental income, and it never reduces what a
 * resident owes — §10 is explicit, and the acceptance fixture turns on it: the
 * deposit held for a resident does not reduce the R1,850 receivable.
 *
 * Four rules the schema already enforces and these commands are built around,
 * rather than re-deciding:
 *
 *  - A deduction, refund or transfer needs an approver, documentary evidence
 *    and a reason of real length (`deposit_events_refund_controls`).
 *  - The person who requested it may not be the person who approves it
 *    (`deposit_events_segregation`). §4: a preparer cannot approve their own.
 *  - Interest may only be credited with evidence behind it
 *    (`deposit_events_interest_evidence`). §10: "a guessed fixed rate must not
 *    be presented as actual earned interest", so there is deliberately no
 *    accrual anywhere in this module.
 *  - Events are append-only. A mistake is corrected with an adjustment, not an
 *    edit.
 *
 * What this module does NOT do is decide the deposit rules themselves. §21
 * requires legal review of which deductions, interest treatment and refund
 * deadlines apply under the Rental Housing Act and the specific lease. Nothing
 * here encodes a deadline or a permitted deduction category, because nobody has
 * reviewed one.
 */

export type DepositHolder = 'landlord' | 'agency_trust' | 'third_party_custodian';

/** What each holder means, shown to the operator rather than a bare enum. */
export const DEPOSIT_HOLDERS: Record<DepositHolder, string> = {
  landlord: 'The landlord holds it in their own account',
  agency_trust: 'Held in an agency trust account',
  third_party_custodian: 'Held by a third-party custodian',
};

export interface DepositEvent {
  id: string;
  eventType: 'received' | 'interest_credited' | 'deduction' | 'refund' | 'transfer_to_rent' | 'adjustment';
  amountMinor: Minor;
  effectiveOn: string;
  description: string;
  evidenceDocumentId: string | null;
  requestedByName: string | null;
  approvedByName: string | null;
  approvalReason: string | null;
  refundReference: string | null;
  createdAt: string;
}

export interface DepositAccountDetail {
  id: string;
  leaseId: string;
  leaseReference: string;
  residentName: string | null;
  unitLabel: string;
  holder: DepositHolder;
  holderLabel: string;
  holderReference: string | null;
  bankReference: string | null;
  currencyCode: string;
  requiredMinor: Minor;
  /** The sum of every event: what is actually held right now. */
  heldMinor: Minor;
  /** Required less held. Positive means the resident still owes a deposit. */
  shortfallMinor: Minor;
  status: 'open' | 'closed';
  interestBasis: string | null;
  openedOn: string;
  closedOn: string | null;
  events: DepositEvent[];
}

const reasonSchema = z.string().trim().min(5, 'Say why, in a sentence.').max(500);
const amountSchema = z.bigint().positive();

/* ------------------------------------------------------------------ reading */

export async function listDepositAccounts(
  tx: Sql, organisationId: string,
): Promise<Omit<DepositAccountDetail, 'events'>[]> {
  await requirePermission(tx, organisationId, 'deposit.read');
  const rows = await tx<Record<string, string | null>[]>`
    select da.id, da.lease_id, da.holder, da.holder_reference, da.bank_reference,
           da.currency_code, da.required_minor::text, da.status, da.interest_basis,
           da.opened_on::text, da.closed_on::text,
           l.reference as lease_reference,
           p.name || ' / ' || u.code as unit_label,
           nullif(trim(coalesce(rp.first_name, '') || ' ' || coalesce(rp.last_name, '')), '')
             as resident_name,
           coalesce((select sum(de.amount_minor) from deposit_events de
                      where de.deposit_account_id = da.id), 0)::text as held
      from deposit_accounts da
      join leases l on l.id = da.lease_id
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_parties lp
        on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
     where da.organisation_id = ${organisationId}::uuid
     order by da.status, p.name, u.code
  `;
  return rows.map(mapAccount);
}

function mapAccount(r: Record<string, string | null>): Omit<DepositAccountDetail, 'events'> {
  const required = BigInt(r.required_minor ?? '0');
  const held = BigInt(r.held ?? '0');
  const holder = (r.holder ?? 'landlord') as DepositHolder;
  return {
    id: r.id!,
    leaseId: r.lease_id!,
    leaseReference: r.lease_reference!,
    residentName: r.resident_name ?? null,
    unitLabel: r.unit_label!,
    holder,
    holderLabel: DEPOSIT_HOLDERS[holder],
    holderReference: r.holder_reference ?? null,
    bankReference: r.bank_reference ?? null,
    currencyCode: r.currency_code!,
    requiredMinor: required,
    heldMinor: held,
    // Negative would mean more is held than required, which happens after
    // interest is credited and is not a shortfall.
    shortfallMinor: required - held > 0n ? required - held : 0n,
    status: (r.status ?? 'open') as 'open' | 'closed',
    interestBasis: r.interest_basis ?? null,
    openedOn: r.opened_on!,
    closedOn: r.closed_on ?? null,
  };
}

export async function getDepositAccount(
  tx: Sql, organisationId: string, depositAccountId: string,
): Promise<DepositAccountDetail | undefined> {
  const accounts = await listDepositAccounts(tx, organisationId);
  const account = accounts.find((a) => a.id === depositAccountId);
  if (!account) return undefined;

  const events = await tx<Record<string, string | null>[]>`
    select de.id, de.event_type::text, de.amount_minor::text, de.effective_on::text,
           de.description, de.evidence_document_id, de.approval_reason, de.refund_reference,
           de.created_at::text,
           req.full_name as requested_by_name,
           app.full_name as approved_by_name
      from deposit_events de
      left join user_profiles req on req.auth_user_id = de.requested_by
      left join user_profiles app on app.auth_user_id = de.approved_by
     where de.deposit_account_id = ${depositAccountId}::uuid
       and de.organisation_id = ${organisationId}::uuid
     order by de.effective_on, de.created_at
  `;

  return {
    ...account,
    events: events.map((e) => ({
      id: e.id!,
      eventType: e.event_type as DepositEvent['eventType'],
      amountMinor: BigInt(e.amount_minor!),
      effectiveOn: e.effective_on!,
      description: e.description!,
      evidenceDocumentId: e.evidence_document_id ?? null,
      requestedByName: e.requested_by_name ?? null,
      approvedByName: e.approved_by_name ?? null,
      approvalReason: e.approval_reason ?? null,
      refundReference: e.refund_reference ?? null,
      createdAt: e.created_at!,
    })),
  };
}

/* ------------------------------------------------------------------ writing */

async function openAccount(
  tx: Sql, organisationId: string, leaseId: string, holder: DepositHolder,
  holderReference: string | null, bankReference: string | null, openedOn: string,
): Promise<{ id: string; book_id: string; currency_code: string }> {
  const [existing] = await tx<{ id: string; book_id: string; currency_code: string; status: string }[]>`
    select id, book_id, currency_code, status from deposit_accounts
     where lease_id = ${leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (existing) {
    if (existing.status === 'closed') {
      throw new DomainError(
        'conflict',
        'This lease\'s deposit account is closed. Reopening a closed deposit is a correction, '
          + 'not a new receipt.',
      );
    }
    return existing;
  }

  const [lease] = await tx<{ id: string; currency_code: string; deposit_required_minor: string }[]>`
    select id, currency_code, deposit_required_minor::text from leases
     where id = ${leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!lease) throw notFound('Lease');

  const [book] = await tx<{ id: string; currency_code: string }[]>`
    select id, currency_code from financial_books
     where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw notFound('Financial book');

  const [created] = await tx<{ id: string; book_id: string; currency_code: string }[]>`
    insert into deposit_accounts (
      organisation_id, book_id, lease_id, holder, holder_reference, bank_reference,
      currency_code, required_minor, opened_on
    ) values (
      ${organisationId}, ${book.id}, ${leaseId}, ${holder}, ${holderReference},
      ${bankReference}, ${book.currency_code}, ${lease.deposit_required_minor}, ${openedOn}
    )
    returning id, book_id, currency_code
  `;
  if (!created) throw new DomainError('internal', 'Deposit account insert returned no row.');
  return created;
}

/**
 * Records deposit money actually received.
 *
 *   debit  Deposit bank control
 *   credit Resident deposit liability
 *
 * Note which account is NOT touched: the resident's receivable. Taking a
 * deposit does not settle rent, and the two must never be netted.
 */
export async function recordDepositReceipt(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: {
    leaseId: string;
    amountMinor: Minor;
    receivedOn: string;
    holder?: DepositHolder;
    holderReference?: string;
    bankReference?: string;
    description?: string;
  },
): Promise<{ depositAccountId: string; eventId: string }> {
  await requirePermission(tx, organisationId, 'deposit.record');
  const amount = parsed(amountSchema, input.amountMinor);
  const holder = parsed(
    z.enum(['landlord', 'agency_trust', 'third_party_custodian']).default('landlord'),
    input.holder ?? 'landlord',
  );

  try {
    const account = await openAccount(
      tx, organisationId, input.leaseId, holder,
      input.holderReference ?? null, input.bankReference ?? null, input.receivedOn,
    );

    const [lease] = await tx<{ property_id: string }[]>`
      select property_id from leases where id = ${input.leaseId}::uuid
    `;

    const journalId = await postJournal(tx, {
      organisationId,
      bookId: account.book_id,
      currencyCode: account.currency_code,
      postingDate: input.receivedOn,
      source: 'deposit',
      description: input.description ?? 'Deposit received',
      sourceTable: 'deposit_events',
      postedBy: actorUserId,
      lines: [
        {
          accountRole: 'deposit_bank_control', debitMinor: amount,
          leaseId: input.leaseId, propertyId: lease?.property_id ?? null, memo: 'Deposit received',
        },
        {
          accountRole: 'deposit_liability', creditMinor: amount,
          leaseId: input.leaseId, propertyId: lease?.property_id ?? null, memo: 'Deposit received',
        },
      ],
    });

    const [event] = await tx<{ id: string }[]>`
      insert into deposit_events (
        organisation_id, deposit_account_id, event_type, amount_minor, currency_code,
        effective_on, description, requested_by, requested_at, journal_id
      ) values (
        ${organisationId}, ${account.id}, 'received', ${amount.toString()},
        ${account.currency_code}, ${input.receivedOn},
        ${input.description ?? 'Deposit received'}, ${actorUserId}, now(), ${journalId}
      )
      returning id
    `;
    if (!event) throw new DomainError('internal', 'Deposit event insert returned no row.');

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'deposit.received', resourceType: 'deposit_account', resourceId: account.id,
      after: { amountMinor: amount.toString(), holder, leaseId: input.leaseId },
    });
    return { depositAccountId: account.id, eventId: event.id };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Credits interest actually earned.
 *
 * `evidenceDocumentId` is required by the database and by §10: interest is
 * recorded from a bank statement or an agreed, reviewed calculation. There is
 * no accrual in this product, because an assumed rate presented as earned
 * interest is a false statement about someone else's money.
 */
export async function creditDepositInterest(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: {
    depositAccountId: string;
    amountMinor: Minor;
    effectiveOn: string;
    evidenceDocumentId: string;
    basis: 'bank_statement_evidence' | 'agreed_reviewed_calculation';
    description?: string;
  },
): Promise<{ eventId: string }> {
  await requirePermission(tx, organisationId, 'deposit.record');
  const amount = parsed(amountSchema, input.amountMinor);
  const basis = parsed(
    z.enum(['bank_statement_evidence', 'agreed_reviewed_calculation']),
    input.basis,
  );
  if (!input.evidenceDocumentId) {
    throw invalid('Interest needs the evidence it was read from. Attach it first.');
  }

  const account = await lockAccount(tx, organisationId, input.depositAccountId);

  try {
    const journalId = await postJournal(tx, {
      organisationId,
      bookId: account.book_id,
      currencyCode: account.currency_code,
      postingDate: input.effectiveOn,
      source: 'deposit',
      description: input.description ?? 'Deposit interest credited',
      sourceTable: 'deposit_events',
      postedBy: actorUserId,
      lines: [
        {
          accountRole: 'deposit_interest_expense', debitMinor: amount,
          leaseId: account.lease_id, memo: 'Interest earned on deposit',
        },
        {
          accountRole: 'deposit_liability', creditMinor: amount,
          leaseId: account.lease_id, memo: 'Interest credited to resident',
        },
      ],
    });

    const [event] = await tx<{ id: string }[]>`
      insert into deposit_events (
        organisation_id, deposit_account_id, event_type, amount_minor, currency_code,
        effective_on, description, evidence_document_id, requested_by, requested_at, journal_id
      ) values (
        ${organisationId}, ${input.depositAccountId}, 'interest_credited',
        ${amount.toString()}, ${account.currency_code}, ${input.effectiveOn},
        ${input.description ?? 'Interest credited'}, ${input.evidenceDocumentId},
        ${actorUserId}, now(), ${journalId}
      )
      returning id
    `;
    if (!event) throw new DomainError('internal', 'Deposit event insert returned no row.');

    await tx`
      update deposit_accounts set interest_basis = ${basis}
       where id = ${input.depositAccountId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'deposit.interest_credited', resourceType: 'deposit_account',
      resourceId: input.depositAccountId,
      after: { amountMinor: amount.toString(), basis, evidenceDocumentId: input.evidenceDocumentId },
    });
    return { eventId: event.id };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

async function lockAccount(
  tx: Sql, organisationId: string, depositAccountId: string,
): Promise<{ id: string; book_id: string; currency_code: string; lease_id: string; status: string; held: bigint }> {
  const [account] = await tx<
    { id: string; book_id: string; currency_code: string; lease_id: string; status: string; held: string }[]
  >`
    select da.id, da.book_id, da.currency_code, da.lease_id, da.status,
           coalesce((select sum(de.amount_minor) from deposit_events de
                      where de.deposit_account_id = da.id), 0)::text as held
      from deposit_accounts da
     where da.id = ${depositAccountId}::uuid and da.organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!account) throw notFound('Deposit account');
  if (account.status === 'closed') {
    throw new DomainError('conflict', 'This deposit account is closed.');
  }
  return { ...account, held: BigInt(account.held) };
}

/**
 * Deducts from, refunds, or transfers a deposit to rent.
 *
 * One command for the three, because they share every control: an approver who
 * is not the requester, documentary evidence, a reason, and the liability
 * reducing by the amount. Only the accounting contra differs.
 *
 * The approver is the ACTOR. There is no path where one person supplies both
 * names: the requester is recorded from whoever raised it, and the database
 * refuses the row if the two match.
 */
export async function approveDepositPayout(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: {
    depositAccountId: string;
    kind: 'deduction' | 'refund' | 'transfer_to_rent';
    amountMinor: Minor;
    effectiveOn: string;
    description: string;
    evidenceDocumentId: string;
    /** Whoever asked for this. Must not be the approver. */
    requestedByUserId: string;
    approvalReason: string;
    refundReference?: string;
  },
): Promise<{ eventId: string }> {
  await requirePermission(tx, organisationId, 'deposit.refund.approve');
  const amount = parsed(amountSchema, input.amountMinor);
  const kind = parsed(z.enum(['deduction', 'refund', 'transfer_to_rent']), input.kind);
  const reason = parsed(reasonSchema, input.approvalReason);

  if (!input.evidenceDocumentId) {
    throw invalid(
      'A deduction or refund needs documentary evidence. Attach the quotation, invoice or '
        + 'statement first.',
    );
  }
  if (input.requestedByUserId === actorUserId) {
    throw new DomainError(
      'forbidden',
      'The person who requested this cannot also approve it. Someone else must approve a '
        + 'deduction or refund.',
    );
  }

  const account = await lockAccount(tx, organisationId, input.depositAccountId);
  if (amount > account.held) {
    throw invalid(
      'That is more than this deposit holds. A deposit cannot go into deficit: the resident '
        + 'is owed what is held, not what was required.',
    );
  }

  // Where the money goes. The liability is debited in every case — it is being
  // discharged — and the contra says what it was discharged into.
  const contra = kind === 'refund'
    ? 'deposit_bank_control' as const
    : kind === 'transfer_to_rent'
      ? 'unapplied_receipts' as const
      : 'other_income' as const;

  try {
    const journalId = await postJournal(tx, {
      organisationId,
      bookId: account.book_id,
      currencyCode: account.currency_code,
      postingDate: input.effectiveOn,
      // A refund has its own journal source, so money leaving the deposit
      // account is distinguishable in the ledger from money arriving in it.
      source: kind === 'refund' ? 'deposit_refund' : 'deposit',
      description: input.description,
      sourceTable: 'deposit_events',
      postedBy: actorUserId,
      lines: [
        {
          accountRole: 'deposit_liability', debitMinor: amount,
          leaseId: account.lease_id, memo: input.description,
        },
        {
          accountRole: contra, creditMinor: amount,
          leaseId: account.lease_id, memo: input.description,
        },
      ],
    });

    const [event] = await tx<{ id: string }[]>`
      insert into deposit_events (
        organisation_id, deposit_account_id, event_type, amount_minor, currency_code,
        effective_on, description, evidence_document_id,
        requested_by, requested_at, approved_by, approved_at, approval_reason,
        refund_reference, journal_id
      ) values (
        ${organisationId}, ${input.depositAccountId}, ${kind}::app.deposit_event_type,
        ${(-amount).toString()}, ${account.currency_code}, ${input.effectiveOn},
        ${input.description}, ${input.evidenceDocumentId},
        ${input.requestedByUserId}, now(), ${actorUserId}, now(), ${reason},
        ${input.refundReference ?? null}, ${journalId}
      )
      returning id
    `;
    if (!event) throw new DomainError('internal', 'Deposit event insert returned no row.');

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: `deposit.${kind}`, resourceType: 'deposit_account',
      resourceId: input.depositAccountId, reason,
      after: {
        amountMinor: amount.toString(), requestedBy: input.requestedByUserId,
        evidenceDocumentId: input.evidenceDocumentId,
        refundReference: input.refundReference ?? null,
      },
    });
    return { eventId: event.id };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Closes a deposit account once nothing is held.
 *
 * Refuses while a balance remains, because a closed account with money in it
 * is money nobody is looking after. Closing does not delete anything: §3 says
 * suspension is not deletion, and the events stay readable.
 */
export async function closeDepositAccount(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { depositAccountId: string; closedOn: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'deposit.refund.approve');
  const reason = parsed(reasonSchema, input.reason);
  const account = await lockAccount(tx, organisationId, input.depositAccountId);

  if (account.held !== 0n) {
    throw new DomainError(
      'conflict',
      'This deposit still holds a balance. Refund or deduct it before closing the account.',
    );
  }

  await tx`
    update deposit_accounts set status = 'closed', closed_on = ${input.closedOn}
     where id = ${input.depositAccountId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'deposit.closed', resourceType: 'deposit_account',
    resourceId: input.depositAccountId, reason,
  });
}

/* -------------------------------------------------------------------------- */
/* Payout requests                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A deduction, refund or transfer prepared for somebody else to approve.
 *
 * `approveDepositPayout` requires the approver to supply every detail
 * themselves, which means the person with the approval permission also does
 * the data entry. That is backwards: segregation of duties is supposed to put
 * a second pair of eyes on a decision, not make the approver the clerk.
 *
 * A pending request HOLDS NOTHING. The deposit balance is the sum of
 * `deposit_events` and nothing is written there until approval, for the same
 * reason an uploaded proof of payment does not reduce a resident's rent
 * balance: a claim awaiting a decision is not a movement.
 */
export interface PayoutRequest {
  id: string;
  depositAccountId: string;
  leaseReference: string | null;
  residentName: string | null;
  kind: 'deduction' | 'refund' | 'transfer_to_rent';
  amountMinor: bigint;
  currencyCode: string;
  effectiveOn: string;
  description: string;
  evidenceDocumentId: string;
  evidenceTitle: string | null;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  eventId: string | null;
  /** What the account holds now, so an approver can see the request in context. */
  heldMinor: bigint;
}

const requestSchema = z.object({
  depositAccountId: z.string().uuid(),
  kind: z.enum(['deduction', 'refund', 'transfer_to_rent']),
  amountMinor: z.bigint().positive(),
  effectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in the form 2026-03-31.'),
  description: z.string().trim().min(3).max(500),
  evidenceDocumentId: z.string().uuid('A deduction or refund needs documentary evidence.'),
  refundReference: z.string().trim().max(120).optional(),
});

export async function requestDepositPayout(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: {
    depositAccountId: string;
    kind: 'deduction' | 'refund' | 'transfer_to_rent';
    amountMinor: Minor;
    effectiveOn: string;
    description: string;
    evidenceDocumentId: string;
  },
): Promise<{ requestId: string }> {
  // Raising a request is not approving one. `deposit.record` is enough to ask;
  // only `deposit.refund.approve` can decide.
  await requirePermission(tx, organisationId, 'deposit.record');
  const params = parsed(requestSchema.omit({ refundReference: true }), input);

  const account = await lockAccount(tx, organisationId, params.depositAccountId);
  if (params.amountMinor > account.held) {
    throw invalid(
      'That is more than this deposit holds. A deposit cannot go into deficit: the resident '
        + 'is owed what is held, not what was required.',
    );
  }

  // Everything already asked for counts against what is held. Two requests for
  // the full balance must not both become approvable.
  const [pending] = await tx<{ total: string }[]>`
    select coalesce(sum(amount_minor), 0)::text as total
      from deposit_payout_requests
     where deposit_account_id = ${params.depositAccountId}::uuid
       and organisation_id = ${organisationId}::uuid
       and status = 'pending'
  `;
  const alreadyRequested = BigInt(pending?.total ?? '0');
  if (params.amountMinor + alreadyRequested > account.held) {
    throw invalid(
      'Requests already waiting for a decision account for the rest of this deposit. '
        + 'Decide those first, or withdraw one.',
    );
  }

  try {
    const [row] = await tx<{ id: string }[]>`
      insert into deposit_payout_requests (
        organisation_id, deposit_account_id, kind, amount_minor, currency_code,
        effective_on, description, evidence_document_id, requested_by
      ) values (
        ${organisationId}, ${params.depositAccountId}, ${params.kind},
        ${params.amountMinor.toString()}, ${account.currency_code},
        ${params.effectiveOn}, ${params.description}, ${params.evidenceDocumentId},
        ${actorUserId}
      )
      returning id
    `;
    if (!row) throw new DomainError('internal', 'Payout request insert returned no row.');

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'deposit.payout.requested', resourceType: 'deposit_account',
      resourceId: params.depositAccountId,
      after: {
        requestId: row.id, kind: params.kind,
        amountMinor: params.amountMinor.toString(),
        evidenceDocumentId: params.evidenceDocumentId,
        // Said plainly in the audit trail too: asking changed no balance.
        ledgerEffect: 'none',
      },
    });
    return { requestId: row.id };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/** Requests on one account, newest first; or every pending one in the organisation. */
export async function listPayoutRequests(
  tx: Sql,
  organisationId: string,
  filter: { depositAccountId?: string; pendingOnly?: boolean } = {},
): Promise<PayoutRequest[]> {
  const rows = await tx<
    { id: string; deposit_account_id: string; lease_reference: string | null;
      resident_name: string | null; kind: string; amount_minor: string; currency_code: string;
      effective_on: string; description: string; evidence_document_id: string;
      evidence_title: string | null; requested_by: string; requested_by_name: string | null;
      requested_at: string; status: string; decided_by_name: string | null;
      decided_at: string | null; decision_reason: string | null; event_id: string | null;
      held: string }[]
  >`
    select r.id, r.deposit_account_id,
           l.reference as lease_reference,
           nullif(trim(coalesce(rp.first_name, '') || ' ' || coalesce(rp.last_name, '')), '')
             as resident_name,
           r.kind, r.amount_minor::text, r.currency_code, r.effective_on::text,
           r.description, r.evidence_document_id, d.title as evidence_title,
           r.requested_by, req.full_name as requested_by_name, r.requested_at::text,
           r.status, dec.full_name as decided_by_name, r.decided_at::text,
           r.decision_reason, r.event_id,
           coalesce((select sum(de.amount_minor) from deposit_events de
                      where de.deposit_account_id = r.deposit_account_id), 0)::text as held
      from deposit_payout_requests r
      join deposit_accounts da on da.id = r.deposit_account_id
      left join leases l on l.id = da.lease_id
      left join lease_parties lp
        on lp.lease_id = da.lease_id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
      left join documents d on d.id = r.evidence_document_id
      left join user_profiles req on req.auth_user_id = r.requested_by
      left join user_profiles dec on dec.auth_user_id = r.decided_by
     where r.organisation_id = ${organisationId}::uuid
       ${filter.depositAccountId
         ? tx`and r.deposit_account_id = ${filter.depositAccountId}::uuid`
         : tx``}
       ${filter.pendingOnly ? tx`and r.status = 'pending'` : tx``}
     order by r.requested_at desc
     limit 200
  `;
  return rows.map((r) => ({
    id: r.id,
    depositAccountId: r.deposit_account_id,
    leaseReference: r.lease_reference,
    residentName: r.resident_name,
    kind: r.kind as PayoutRequest['kind'],
    amountMinor: BigInt(r.amount_minor),
    currencyCode: r.currency_code,
    effectiveOn: r.effective_on,
    description: r.description,
    evidenceDocumentId: r.evidence_document_id,
    evidenceTitle: r.evidence_title,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    requestedAt: r.requested_at,
    status: r.status as PayoutRequest['status'],
    decidedByName: r.decided_by_name,
    decidedAt: r.decided_at,
    decisionReason: r.decision_reason,
    eventId: r.event_id,
    heldMinor: BigInt(r.held),
  }));
}

/**
 * Approves a request and posts the movement it authorised.
 *
 * The approver is the actor, and the requester comes from the stored request —
 * never from the form. That is the whole value of the request: the two names
 * cannot be the same person because one of them was recorded before this
 * screen was opened.
 */
export async function approvePayoutRequest(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { requestId: string; approvalReason: string; refundReference?: string },
): Promise<{ eventId: string }> {
  await requirePermission(tx, organisationId, 'deposit.refund.approve');
  const reason = parsed(
    z.string().trim().min(5, 'Say why this is approved, in a sentence somebody can audit.')
      .max(500),
    input.approvalReason,
  );

  const [request] = await tx<
    { id: string; deposit_account_id: string; kind: string; amount_minor: string;
      effective_on: string; description: string; evidence_document_id: string;
      requested_by: string; status: string }[]
  >`
    select id, deposit_account_id, kind, amount_minor::text, effective_on::text,
           description, evidence_document_id, requested_by, status
      from deposit_payout_requests
     where id = ${input.requestId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!request) throw notFound('Payout request');
  if (request.status !== 'pending') {
    throw new DomainError(
      'conflict',
      `This request was already ${request.status}. Raise another one if it is still needed.`,
    );
  }
  if (request.requested_by === actorUserId) {
    throw new DomainError(
      'forbidden',
      'You raised this request, so you cannot approve it. Someone else must.',
    );
  }

  const { eventId } = await approveDepositPayout(tx, organisationId, actorUserId, {
    depositAccountId: request.deposit_account_id,
    kind: request.kind as 'deduction' | 'refund' | 'transfer_to_rent',
    amountMinor: BigInt(request.amount_minor),
    effectiveOn: request.effective_on,
    description: request.description,
    evidenceDocumentId: request.evidence_document_id,
    requestedByUserId: request.requested_by,
    approvalReason: reason,
    refundReference: input.refundReference,
  });

  await tx`
    update deposit_payout_requests
       set status = 'approved', decided_by = ${actorUserId}, decided_at = now(),
           decision_reason = ${reason}, event_id = ${eventId}
     where id = ${input.requestId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  return { eventId };
}

/** Declines a request. Nothing is posted, and the refusal stays on the record. */
export async function declinePayoutRequest(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { requestId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'deposit.refund.approve');
  const reason = parsed(
    z.string().trim().min(5, 'Say why this is declined. The requester has to know what to fix.')
      .max(500),
    input.reason,
  );

  const [request] = await tx<
    { id: string; status: string; requested_by: string; deposit_account_id: string }[]
  >`
    select id, status, requested_by, deposit_account_id
      from deposit_payout_requests
     where id = ${input.requestId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!request) throw notFound('Payout request');
  if (request.status !== 'pending') {
    throw new DomainError('conflict', `This request was already ${request.status}.`);
  }
  if (request.requested_by === actorUserId) {
    throw new DomainError(
      'forbidden',
      'You raised this request. Withdraw it rather than declining your own.',
    );
  }

  await tx`
    update deposit_payout_requests
       set status = 'declined', decided_by = ${actorUserId}, decided_at = now(),
           decision_reason = ${reason}
     where id = ${input.requestId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'deposit.payout.declined', resourceType: 'deposit_account',
    resourceId: request.deposit_account_id, reason,
    after: { requestId: input.requestId, ledgerEffect: 'none' },
  });
}

/**
 * Withdraws one's own request.
 *
 * Deliberately the only thing a requester can do to their own request, and the
 * reason `declinePayoutRequest` refuses it: withdrawn and declined are
 * different facts, and collapsing them would hide who decided what.
 */
export async function withdrawPayoutRequest(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { requestId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'deposit.record');
  const reason = parsed(z.string().trim().min(5).max(500), input.reason);

  const [request] = await tx<
    { id: string; status: string; requested_by: string; deposit_account_id: string }[]
  >`
    select id, status, requested_by, deposit_account_id
      from deposit_payout_requests
     where id = ${input.requestId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!request) throw notFound('Payout request');
  if (request.status !== 'pending') {
    throw new DomainError('conflict', `This request was already ${request.status}.`);
  }
  if (request.requested_by !== actorUserId) {
    throw new DomainError(
      'forbidden',
      'Only the person who raised a request can withdraw it. Decline it instead.',
    );
  }

  // The decision columns carry the withdrawal, and the table's segregation
  // check allows it because a withdrawal is not an approval of anything.
  await tx`
    update deposit_payout_requests
       set status = 'withdrawn', decided_by = null, decided_at = now(),
           decision_reason = ${reason}
     where id = ${input.requestId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'deposit.payout.withdrawn', resourceType: 'deposit_account',
    resourceId: request.deposit_account_id, reason,
    after: { requestId: input.requestId, ledgerEffect: 'none' },
  });
}
