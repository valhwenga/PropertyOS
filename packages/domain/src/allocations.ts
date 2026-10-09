import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import { postJournal, reverseJournal } from './ledger';
import type { Minor } from './money';
import { sumMinor } from './money';
import { requirePermission } from './permissions';

export interface AllocationRequest {
  chargeLineId: string;
  amountMinor: Minor;
}

export type AllocationPolicy = 'oldest_due_date_first' | 'manual';

export interface AllocateReceiptInput {
  receiptId: string;
  allocations: AllocationRequest[];
  postingDate: string;
  policy?: AllocationPolicy;
  correlationId?: string;
}

/**
 * Allocates a confirmed receipt across one or more open charges.
 *
 * Accounting effect per allocation:
 *   debit  Unapplied resident receipts
 *   credit Resident receivable
 *
 * Concurrency. Two operators allocating the same receipt at the same moment must
 * never together exceed the money received. This is guaranteed in the database,
 * not here: the trigger on payment_allocations takes `SELECT ... FOR UPDATE` on
 * the receipt first and the charge line second, so the second transaction blocks
 * until the first commits and then re-reads the true allocated total. The
 * application-level check below exists only to produce a friendlier message in
 * the common, uncontended case.
 *
 * Partial allocation is normal; whatever is left stays as unapplied credit with
 * a traceable history. Over-allocation is impossible.
 */
export async function allocateReceipt(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: AllocateReceiptInput,
): Promise<{ allocationIds: string[]; allocatedMinor: Minor; unappliedMinor: Minor }> {
  await requirePermission(tx, organisationId, 'payment.allocate');

  if (input.allocations.length === 0) throw invalid('No allocations supplied.');
  if (input.allocations.some((a) => a.amountMinor <= 0n)) {
    throw invalid('Each allocation must be a positive amount.');
  }

  // Lock the receipt up front, in the same order the trigger uses.
  const [receipt] = await tx<
    {
      id: string; book_id: string; lease_id: string | null; status: string;
      amount_minor: string; currency_code: string; receipt_number: string; in_suspense: boolean;
    }[]
  >`
    select id, book_id, lease_id, status, amount_minor, currency_code, receipt_number, in_suspense
    from receipts
    where id = ${input.receiptId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!receipt) throw notFound('Receipt');
  if (receipt.status !== 'confirmed') {
    throw new DomainError(
      'conflict',
      'Only confirmed funds can be allocated. Unverified payment evidence does not reduce a balance.',
    );
  }

  const allocatedRows = await tx<{ allocated: string }[]>`
    select coalesce(sum(amount_minor), 0)::text as allocated
    from payment_allocations
    where receipt_id = ${input.receiptId}::uuid and reversed_at is null
  `;
  const alreadyAllocated = BigInt(allocatedRows[0]?.allocated ?? '0');
  const requested = sumMinor(input.allocations.map((a) => a.amountMinor));
  const available = BigInt(receipt.amount_minor) - alreadyAllocated;

  if (requested > available) {
    throw new DomainError(
      'over_allocation',
      `Receipt ${receipt.receipt_number} has ${available} minor units available; ${requested} was requested.`,
    );
  }

  const chargeIds = input.allocations.map((a) => a.chargeLineId);
  const chargeRows = await tx<
    {
      id: string; lease_id: string; currency_code: string; amount_minor: string;
      description: string; document_id: string; outstanding: string;
    }[]
  >`
    select cl.id, cl.lease_id, cl.currency_code, cl.amount_minor::text, cl.description,
           cl.document_id,
           (cl.amount_minor - coalesce((
              select sum(pa.amount_minor) from payment_allocations pa
              where pa.charge_line_id = cl.id and pa.reversed_at is null
           ), 0))::text as outstanding
    from charge_lines cl
    join charge_documents cd on cd.id = cl.document_id
    where cl.id = any(${chargeIds}::uuid[])
      and cl.organisation_id = ${organisationId}::uuid
      and cd.status = 'posted'
    order by cl.id
  `;
  if (chargeRows.length !== new Set(chargeIds).size) {
    throw notFound('One or more charge lines');
  }

  const byId = new Map(chargeRows.map((c) => [c.id, c]));
  const leaseIds = new Set(chargeRows.map((c) => c.lease_id));
  if (leaseIds.size > 1) {
    throw invalid('A single allocation batch must target charges on one lease.');
  }
  const targetLeaseId = [...leaseIds][0]!;

  // A receipt identified to a lease may only be applied to that lease's charges.
  if (receipt.lease_id && receipt.lease_id !== targetLeaseId) {
    throw new DomainError(
      'forbidden',
      'This receipt belongs to a different lease. Reassign it before allocating.',
    );
  }

  const policy = input.policy ?? 'oldest_due_date_first';
  const allocationIds: string[] = [];

  try {
    for (const request of input.allocations) {
      const charge = byId.get(request.chargeLineId)!;
      if (charge.currency_code !== receipt.currency_code) {
        throw invalid('Allocation currency must match both the receipt and the charge.');
      }
      if (request.amountMinor > BigInt(charge.outstanding)) {
        throw new DomainError(
          'over_allocation',
          `Charge "${charge.description}" has ${charge.outstanding} minor units outstanding; ` +
            `${request.amountMinor} was requested.`,
        );
      }

      const leaseRows = await tx<{ property_id: string }[]>`
        select property_id from leases where id = ${charge.lease_id}::uuid
      `;
      const propertyId = leaseRows[0]?.property_id ?? null;

      const journalId = await postJournal(tx, {
        organisationId,
        bookId: receipt.book_id,
        currencyCode: receipt.currency_code,
        postingDate: input.postingDate,
        source: 'allocation',
        description: `${receipt.receipt_number} allocated to ${charge.description}`,
        sourceTable: 'payment_allocations',
        postedBy: actorUserId,
        correlationId: input.correlationId ?? null,
        lines: [
          {
            // Suspense money is released from suspense, identified money from
            // the unapplied receipts liability.
            accountRole: receipt.in_suspense ? 'suspense' : 'unapplied_receipts',
            debitMinor: request.amountMinor,
            leaseId: charge.lease_id,
            propertyId,
            memo: receipt.receipt_number,
          },
          {
            accountRole: 'resident_receivable',
            creditMinor: request.amountMinor,
            leaseId: charge.lease_id,
            propertyId,
            memo: charge.description,
          },
        ],
      });

      // The database trigger re-validates availability under a row lock here.
      const [allocation] = await tx<{ id: string }[]>`
        insert into payment_allocations (
          organisation_id, receipt_id, charge_line_id, amount_minor, currency_code,
          journal_id, applied_policy, allocated_by, allocated_on
        ) values (
          ${organisationId}, ${input.receiptId}, ${request.chargeLineId},
          ${request.amountMinor.toString()}, ${receipt.currency_code},
          ${journalId}, ${policy}, ${actorUserId}, ${input.postingDate}
        )
        returning id
      `;
      if (!allocation) throw new DomainError('internal', 'Allocation insert returned no row.');
      allocationIds.push(allocation.id);
    }

    const totalRows = await tx<{ total: string }[]>`
      select coalesce(sum(amount_minor), 0)::text as total
      from payment_allocations
      where receipt_id = ${input.receiptId}::uuid and reversed_at is null
    `;
    const allocatedNow = BigInt(totalRows[0]?.total ?? '0');
    const unapplied = BigInt(receipt.amount_minor) - allocatedNow;

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'receipt.allocated', resourceType: 'receipt', resourceId: input.receiptId,
      correlationId: input.correlationId ?? null,
      after: {
        allocations: allocationIds.length,
        allocatedMinor: requested.toString(),
        unappliedMinor: unapplied.toString(),
        policy,
      },
    });
    await emitEvent(tx, {
      organisationId,
      eventType: 'receipt.allocated',
      resourceType: 'receipt',
      resourceId: input.receiptId,
      payload: { allocatedMinor: requested.toString(), unappliedMinor: unapplied.toString() },
      correlationId: input.correlationId ?? null,
    });

    return { allocationIds, allocatedMinor: requested, unappliedMinor: unapplied };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Suggests how to spread a receipt across open charges.
 *
 * Default policy is oldest due date first, which is recorded on each allocation
 * because the ordering changes how arrears age. This only PROPOSES: nothing is
 * posted until an operator confirms.
 */
export async function suggestAllocation(
  tx: Sql,
  organisationId: string,
  params: { leaseId: string; amountMinor: Minor; policy?: AllocationPolicy },
): Promise<{ allocations: AllocationRequest[]; remainingMinor: Minor; policy: AllocationPolicy }> {
  const policy = params.policy ?? 'oldest_due_date_first';
  const open = await tx<{ charge_line_id: string; outstanding_minor: string; due_date: string }[]>`
    select charge_line_id, outstanding_minor::text, due_date
    from charge_line_balances
    where organisation_id = ${organisationId}::uuid
      and lease_id = ${params.leaseId}::uuid
      and outstanding_minor > 0
    order by due_date asc, charge_line_id asc
  `;

  const allocations: AllocationRequest[] = [];
  let remaining = params.amountMinor;
  for (const charge of open) {
    if (remaining <= 0n) break;
    const outstanding = BigInt(charge.outstanding_minor);
    const take = remaining < outstanding ? remaining : outstanding;
    allocations.push({ chargeLineId: charge.charge_line_id, amountMinor: take });
    remaining -= take;
  }
  // Whatever is left is an overpayment and stays as unapplied credit.
  return { allocations, remainingMinor: remaining, policy };
}

export async function reverseAllocation(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { allocationId: string; reason: string; postingDate: string },
): Promise<void> {
  // Reversing an allocation moves a resident's balance, so it needs the
  // reversal permission in its own right. It had none: `reverseReceipt` checked
  // before calling in, which protected that path and left this one open to
  // anyone who could reach the function. A permission enforced by one caller is
  // not an access control.
  await requirePermission(tx, organisationId, 'payment.reverse');
  if (params.reason.trim().length < 5) throw invalid('A reversal requires a reason.');
  const [allocation] = await tx<{ id: string; journal_id: string | null; reversed_at: string | null }[]>`
    select id, journal_id, reversed_at from payment_allocations
    where id = ${params.allocationId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!allocation) throw notFound('Allocation');
  if (allocation.reversed_at) throw new DomainError('conflict', 'This allocation is already reversed.');

  if (allocation.journal_id) {
    await reverseJournal(tx, {
      organisationId,
      journalId: allocation.journal_id,
      reason: params.reason,
      postingDate: params.postingDate,
      postedBy: actorUserId,
    });
  }
  await tx`
    update payment_allocations
    set reversed_at = now(), reversed_on = ${params.postingDate}::date,
        reversed_by = ${actorUserId}, reversal_reason = ${params.reason}
    where id = ${params.allocationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'allocation.reversed', resourceType: 'payment_allocation', resourceId: params.allocationId,
    reason: params.reason,
  });
}
