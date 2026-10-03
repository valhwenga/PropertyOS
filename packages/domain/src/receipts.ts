import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { reverseAllocation } from './allocations';
import { recordAudit, emitEvent } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import { postJournal, reverseJournal } from './ledger';
import type { Minor } from './money';
import { nextDocumentNumber } from './numbering';
import { requirePermission } from './permissions';

export const confirmReceiptSchema = z.object({
  leaseId: z.string().uuid().optional(),
  amountMinor: z.bigint().positive(),
  /** Provider/bank fee borne by the landlord. Never reduces what the resident paid. */
  feeMinor: z.bigint().nonnegative().default(0n),
  receivedOn: z.string().date(),
  method: z.enum(['eft', 'cash', 'card', 'debit_order', 'other']).default('eft'),
  payerReference: z.string().trim().max(140).optional(),
  bankTransactionId: z.string().uuid().optional(),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * Confirms that real funds were received and posts the receipt journal.
 *
 * Accounting effect:
 *   debit  Landlord bank control   (gross amount actually received)
 *   credit Unapplied resident receipts  (or Suspense when the payer is unknown)
 *
 * A receipt is created ONLY from verified funds — never from a resident's
 * uploaded proof of payment and never from a browser redirect. Allocation to
 * charges is a separate, subsequent step, so the resident's balance moves only
 * when an operator applies the money.
 */
export async function confirmReceipt(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof confirmReceiptSchema>,
): Promise<{ receiptId: string; receiptNumber: string; journalId: string; inSuspense: boolean }> {
  await requirePermission(tx, organisationId, 'payment.record');
  const r = confirmReceiptSchema.parse(input);

  const [book] = await tx<{ id: string; currency_code: string }[]>`
    select id, currency_code from financial_books
    where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw notFound('Financial book');

  let propertyId: string | null = null;
  if (r.leaseId) {
    const [lease] = await tx<{ id: string; property_id: string; currency_code: string }[]>`
      select id, property_id, currency_code from leases
      where id = ${r.leaseId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    if (!lease) throw notFound('Lease');
    if (lease.currency_code !== book.currency_code) {
      throw invalid('Receipt currency does not match the lease currency.');
    }
    propertyId = lease.property_id;
  }

  const inSuspense = !r.leaseId;
  const receiptNumber = await nextDocumentNumber(tx, organisationId, 'RCT');

  try {
    const journalId = await postJournal(tx, {
      organisationId,
      bookId: book.id,
      currencyCode: book.currency_code,
      postingDate: r.receivedOn,
      source: 'receipt',
      description: `${receiptNumber} — funds received${inSuspense ? ' (unidentified payer)' : ''}`,
      sourceTable: 'receipts',
      postedBy: actorUserId,
      lines: [
        {
          accountRole: 'bank_control',
          debitMinor: r.amountMinor,
          leaseId: r.leaseId ?? null,
          propertyId,
          memo: receiptNumber,
        },
        {
          // Unidentified money goes to suspense, not to a guessed lease.
          accountRole: inSuspense ? 'suspense' : 'unapplied_receipts',
          creditMinor: r.amountMinor,
          leaseId: r.leaseId ?? null,
          propertyId,
          memo: r.payerReference ?? receiptNumber,
        },
      ],
    });

    const [receipt] = await tx<{ id: string }[]>`
      insert into receipts (
        organisation_id, book_id, lease_id, receipt_number, status, amount_minor,
        fee_minor, currency_code, received_on, method, payer_reference,
        bank_transaction_id, journal_id, confirmed_at, confirmed_by, in_suspense,
        notes, created_by
      ) values (
        ${organisationId}, ${book.id}, ${r.leaseId ?? null}, ${receiptNumber}, 'confirmed',
        ${r.amountMinor.toString()}, ${r.feeMinor.toString()}, ${book.currency_code},
        ${r.receivedOn}, ${r.method}, ${r.payerReference ?? null},
        ${r.bankTransactionId ?? null}, ${journalId}, now(), ${actorUserId},
        ${inSuspense}, ${r.notes ?? null}, ${actorUserId}
      )
      returning id
    `;
    if (!receipt) throw new DomainError('internal', 'Receipt insert returned no row.');

    if (r.bankTransactionId) {
      await tx`
        update bank_transactions
        set matched_receipt_id = ${receipt.id}, match_status = 'matched'
        where id = ${r.bankTransactionId}::uuid and organisation_id = ${organisationId}::uuid
      `;
    }

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'receipt.confirmed', resourceType: 'receipt', resourceId: receipt.id,
      after: { receiptNumber, amountMinor: r.amountMinor.toString(), inSuspense },
    });
    await emitEvent(tx, {
      organisationId,
      eventType: 'receipt.confirmed',
      resourceType: 'receipt',
      resourceId: receipt.id,
      payload: { amountMinor: r.amountMinor.toString(), leaseId: r.leaseId ?? null },
    });

    return { receiptId: receipt.id, receiptNumber, journalId, inSuspense };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Records a resident's uploaded proof of payment.
 *
 * This has NO accounting effect by design: it creates no journal, no receipt and
 * no allocation, so the resident's balance is unchanged until an operator
 * verifies the funds against the bank record.
 */
export async function submitPaymentEvidence(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: {
    leaseId: string;
    claimedAmountMinor: Minor;
    claimedPaidAt: string;
    reference?: string;
    documentId?: string;
  },
): Promise<{ evidenceId: string }> {
  const [row] = await tx<{ id: string }[]>`
    insert into payment_evidence (
      organisation_id, lease_id, submitted_by, claimed_amount_minor,
      claimed_paid_at, reference, document_id, status
    ) values (
      ${organisationId}, ${params.leaseId}, ${actorUserId},
      ${params.claimedAmountMinor.toString()}, ${params.claimedPaidAt},
      ${params.reference ?? null}, ${params.documentId ?? null}, 'submitted'
    )
    returning id
  `;
  if (!row) throw new DomainError('internal', 'Payment evidence insert returned no row.');

  await emitEvent(tx, {
    organisationId,
    eventType: 'payment.evidence.submitted',
    resourceType: 'payment_evidence',
    resourceId: row.id,
    payload: { leaseId: params.leaseId, claimedAmountMinor: params.claimedAmountMinor.toString() },
  });
  return { evidenceId: row.id };
}

/**
 * Reverses a confirmed receipt (a bounced EFT, a chargeback, a capture error).
 * Any live allocations are reversed first so balances stay consistent.
 */
export async function reverseReceipt(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { receiptId: string; reason: string; postingDate: string },
): Promise<{ reversalJournalId: string }> {
  await requirePermission(tx, organisationId, 'payment.reverse');
  if (params.reason.trim().length < 5) throw invalid('A reversal requires a reason.');

  const [receipt] = await tx<{ id: string; journal_id: string; status: string }[]>`
    select id, journal_id, status from receipts
    where id = ${params.receiptId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!receipt) throw notFound('Receipt');
  if (receipt.status !== 'confirmed') throw new DomainError('conflict', 'Only a confirmed receipt can be reversed.');

  const live = await tx<{ id: string }[]>`
    select id from payment_allocations
    where receipt_id = ${params.receiptId}::uuid and reversed_at is null
  `;
  for (const allocation of live) {
    await reverseAllocation(tx, organisationId, actorUserId, {
      allocationId: allocation.id,
      reason: `Receipt reversed: ${params.reason}`,
      postingDate: params.postingDate,
    });
  }

  const reversalJournalId = await reverseJournal(tx, {
    organisationId,
    journalId: receipt.journal_id,
    reason: params.reason,
    postingDate: params.postingDate,
    postedBy: actorUserId,
  });

  await tx`
    update receipts set status = 'failed', notes = coalesce(notes || E'\n', '') || ${`Reversed: ${params.reason}`}
    where id = ${params.receiptId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'receipt.reversed', resourceType: 'receipt', resourceId: params.receiptId,
    reason: params.reason,
  });
  return { reversalJournalId };
}
