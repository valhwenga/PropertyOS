import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import { postJournal, resolveSystemAccounts } from './ledger';
import type { Minor } from './money';
import { sumMinor } from './money';
import { nextDocumentNumber } from './numbering';
import { requirePermission } from './permissions';

export const chargeLineSchema = z.object({
  category: z.enum(['rent', 'utility_water', 'utility_electricity', 'parking', 'adjustment', 'other']),
  description: z.string().trim().min(1).max(300),
  amountMinor: z.bigint(),
  dueDate: z.string().date(),
  servicePeriodStart: z.string().date().optional(),
  servicePeriodEnd: z.string().date().optional(),
  prorated: z.boolean().default(false),
  prorationNumerator: z.number().int().nonnegative().optional(),
  prorationDenominator: z.number().int().positive().optional(),
  fullPeriodAmountMinor: z.bigint().optional(),
  scheduleId: z.string().uuid().optional(),
});

export interface PostChargeInput {
  leaseId: string;
  documentType: 'rent_invoice' | 'utility_invoice' | 'adjustment_debit' | 'opening_balance';
  issueDate: string;
  dueDate: string;
  periodStart?: string;
  periodEnd?: string;
  scheduleId?: string;
  billingRunId?: string;
  lines: z.input<typeof chargeLineSchema>[];
  correlationId?: string;
}

/** Maps a charge category to the income account that receives the credit. */
function incomeRoleFor(category: string): 'rental_income' | 'utility_recovery_income' | 'other_income' {
  if (category === 'rent') return 'rental_income';
  if (category.startsWith('utility_')) return 'utility_recovery_income';
  return 'other_income';
}

/**
 * Posts a charge document and its balanced journal in ONE transaction.
 *
 * Accounting effect per line:
 *   debit  Resident receivable
 *   credit Rental income / Utility recovery income / Other income
 *
 * Once posted the document and its lines are immutable: the database triggers
 * reject any later edit. Corrections are issued as linked credit notes.
 */
export async function postCharge(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: PostChargeInput,
): Promise<{ documentId: string; documentNumber: string; journalId: string; totalMinor: Minor }> {
  await requirePermission(tx, organisationId, 'billing.post');

  const lines = input.lines.map((l) => chargeLineSchema.parse(l));
  if (lines.length === 0) throw invalid('A charge document needs at least one line.');
  if (lines.some((l) => l.amountMinor <= 0n)) {
    throw invalid('Charge lines must be positive. Use a credit note to reduce a balance.');
  }

  const [lease] = await tx<
    { id: string; property_id: string; unit_id: string; currency_code: string; status: string }[]
  >`
    select id, property_id, unit_id, currency_code, status from leases
    where id = ${input.leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!lease) throw notFound('Lease');
  if (lease.status === 'draft' || lease.status === 'cancelled') {
    throw new DomainError('conflict', `A lease in state "${lease.status}" cannot be billed.`);
  }

  const [book] = await tx<{ id: string; currency_code: string }[]>`
    select id, currency_code from financial_books
    where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw notFound('Financial book');
  if (book.currency_code !== lease.currency_code) {
    throw invalid(
      `Lease currency ${lease.currency_code} does not match book currency ${book.currency_code}. ` +
        'Amounts in different currencies are never combined without a reviewed exchange rate policy.',
    );
  }

  const accounts = await resolveSystemAccounts(tx, book.id);
  const receivableAccount = accounts.get('resident_receivable');
  if (!receivableAccount) throw new DomainError('internal', 'This book has no resident receivable account.');

  const total = sumMinor(lines.map((l) => l.amountMinor));
  const documentNumber = await nextDocumentNumber(
    tx,
    organisationId,
    input.documentType === 'opening_balance' ? 'OPB' : input.documentType === 'adjustment_debit' ? 'ADJ' : 'INV',
  );

  try {
    // 1. The journal. Its balance is enforced by a deferred constraint trigger.
    const journalId = await postJournal(tx, {
      organisationId,
      bookId: book.id,
      currencyCode: lease.currency_code,
      postingDate: input.issueDate,
      source: input.documentType === 'opening_balance' ? 'opening_balance'
        : input.documentType === 'utility_invoice' ? 'utility_charge'
        : input.documentType === 'adjustment_debit' ? 'adjustment' : 'rent_charge',
      description: `${documentNumber} — charge for lease`,
      sourceTable: 'charge_documents',
      postedBy: actorUserId,
      correlationId: input.correlationId ?? null,
      lines: [
        {
          accountId: receivableAccount,
          debitMinor: total,
          leaseId: lease.id,
          propertyId: lease.property_id,
          unitId: lease.unit_id,
          memo: documentNumber,
        },
        ...lines.map((l) => ({
          accountRole: incomeRoleFor(l.category),
          creditMinor: l.amountMinor,
          leaseId: lease.id,
          propertyId: lease.property_id,
          unitId: lease.unit_id,
          memo: l.description,
        })),
      ],
    });

    // 2. The document, carrying its journal reference.
    const [doc] = await tx<{ id: string }[]>`
      insert into charge_documents (
        organisation_id, book_id, lease_id, document_type, document_number, status,
        currency_code, issue_date, due_date, period_start, period_end,
        schedule_id, billing_run_id, total_minor, journal_id, posted_at, posted_by, created_by
      ) values (
        ${organisationId}, ${book.id}, ${lease.id}, ${input.documentType}, ${documentNumber},
        'posted', ${lease.currency_code}, ${input.issueDate}, ${input.dueDate},
        ${input.periodStart ?? null}, ${input.periodEnd ?? null},
        ${input.scheduleId ?? null}, ${input.billingRunId ?? null},
        ${total.toString()}, ${journalId}, now(), ${actorUserId}, ${actorUserId}
      )
      returning id
    `;
    if (!doc) throw new DomainError('internal', 'Charge document insert returned no row.');

    await tx`
      insert into charge_lines ${tx(
        lines.map((l, index) => ({
          organisation_id: organisationId,
          document_id: doc.id,
          lease_id: lease.id,
          line_number: index + 1,
          category: l.category,
          description: l.description,
          amount_minor: l.amountMinor.toString(),
          currency_code: lease.currency_code,
          income_account_id: accounts.get(incomeRoleFor(l.category))!,
          prorated: l.prorated,
          proration_numerator: l.prorationNumerator ?? null,
          proration_denominator: l.prorationDenominator ?? null,
          full_period_amount_minor: l.fullPeriodAmountMinor?.toString() ?? null,
          service_period_start: l.servicePeriodStart ?? null,
          service_period_end: l.servicePeriodEnd ?? null,
          due_date: l.dueDate,
        })),
      )}
    `;

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'charge.posted', resourceType: 'charge_document', resourceId: doc.id,
      correlationId: input.correlationId ?? null,
      after: { documentNumber, totalMinor: total.toString(), lines: lines.length },
    });
    await emitEvent(tx, {
      organisationId,
      eventType: 'charge.posted',
      resourceType: 'charge_document',
      resourceId: doc.id,
      payload: { leaseId: lease.id, totalMinor: total.toString(), dueDate: input.dueDate },
      correlationId: input.correlationId ?? null,
    });

    return { documentId: doc.id, documentNumber, journalId, totalMinor: total };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Issues a credit note against a posted charge document.
 *
 * "Posted charge is wrong: linked credit/reversal; original history retained."
 * The original document is never altered.
 */
export async function issueCreditNote(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: {
    documentId: string;
    reason: string;
    issueDate: string;
    lines: Array<{ description: string; amountMinor: Minor; category: string }>;
  },
): Promise<{ documentId: string; documentNumber: string; journalId: string }> {
  await requirePermission(tx, organisationId, 'charge.adjust');
  if (params.reason.trim().length < 5) throw invalid('A credit note requires a reason.');

  // Locked for the duration of the transaction, so two operators crediting the
  // same document at the same moment serialise instead of both reading a stale
  // already-credited total. The database trigger enforces the same rule
  // independently; this is here to produce a readable error.
  const [original] = await tx<
    { id: string; lease_id: string; book_id: string; currency_code: string; total_minor: string; status: string }[]
  >`
    select id, lease_id, book_id, currency_code, total_minor, status from charge_documents
    where id = ${params.documentId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!original) throw notFound('Charge document');
  if (original.status !== 'posted') throw new DomainError('conflict', 'Only a posted document can be credited.');

  const [lease] = await tx<{ property_id: string; unit_id: string }[]>`
    select property_id, unit_id from leases where id = ${original.lease_id}::uuid
  `;
  if (!lease) throw notFound('Lease');

  const credited = sumMinor(params.lines.map((l) => l.amountMinor));
  if (credited <= 0n) throw invalid('A credit note must credit a positive amount.');

  // A document can be credited more than once, so the limit is what remains
  // after earlier notes — not the original total. Checking only the latter let
  // two R600 notes credit R1,200 against a R900 charge.
  const [{ already }] = await tx<{ already: string }[]>`
    select coalesce(sum(-total_minor), 0)::text as already
    from charge_documents
    where corrects_document_id = ${original.id}::uuid
      and document_type = 'credit_note'
      and status <> 'draft'
  ` as unknown as [{ already: string }];
  const alreadyCredited = BigInt(already ?? '0');
  const remaining = BigInt(original.total_minor) - alreadyCredited;

  if (credited > remaining) {
    throw invalid(
      alreadyCredited > 0n
        ? `This document has already been credited ${alreadyCredited} minor units of ${original.total_minor}. ` +
          `Only ${remaining} remains creditable.`
        : 'A credit note cannot exceed the original document total.',
      { alreadyCreditedMinor: alreadyCredited.toString(), remainingMinor: remaining.toString() },
    );
  }

  const accounts = await resolveSystemAccounts(tx, original.book_id);
  const documentNumber = await nextDocumentNumber(tx, organisationId, 'CRN');

  const journalId = await postJournal(tx, {
    organisationId,
    bookId: original.book_id,
    currencyCode: original.currency_code,
    postingDate: params.issueDate,
    source: 'adjustment',
    description: `${documentNumber} — credit note: ${params.reason}`,
    sourceTable: 'charge_documents',
    sourceId: original.id,
    postedBy: actorUserId,
    lines: [
      // Mirror image of a charge: income is debited back, receivable credited.
      ...params.lines.map((l) => ({
        accountRole: incomeRoleFor(l.category),
        debitMinor: l.amountMinor,
        leaseId: original.lease_id,
        propertyId: lease.property_id,
        memo: l.description,
      })),
      {
        accountRole: 'resident_receivable' as const,
        creditMinor: credited,
        leaseId: original.lease_id,
        propertyId: lease.property_id,
        memo: documentNumber,
      },
    ],
  });

  const [doc] = await tx<{ id: string }[]>`
    insert into charge_documents (
      organisation_id, book_id, lease_id, document_type, document_number, status,
      currency_code, issue_date, due_date, total_minor, journal_id,
      corrects_document_id, correction_reason, posted_at, posted_by, created_by
    ) values (
      ${organisationId}, ${original.book_id}, ${original.lease_id}, 'credit_note',
      ${documentNumber}, 'posted', ${original.currency_code}, ${params.issueDate},
      ${params.issueDate}, ${(-credited).toString()}, ${journalId},
      ${original.id}, ${params.reason}, now(), ${actorUserId}, ${actorUserId}
    )
    returning id
  `;
  if (!doc) throw new DomainError('internal', 'Credit note insert returned no row.');

  await tx`
    insert into charge_lines ${tx(
      params.lines.map((l, i) => ({
        organisation_id: organisationId,
        document_id: doc.id,
        lease_id: original.lease_id,
        line_number: i + 1,
        category: l.category,
        description: l.description,
        amount_minor: (-l.amountMinor).toString(),
        currency_code: original.currency_code,
        income_account_id: accounts.get(incomeRoleFor(l.category))!,
        due_date: params.issueDate,
      })),
    )}
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'charge.credited', resourceType: 'charge_document', resourceId: doc.id,
    reason: params.reason,
    after: { creditsDocument: original.id, amountMinor: credited.toString() },
  });

  return { documentId: doc.id, documentNumber, journalId };
}
