/**
 * The receipt workflow, end to end at the domain level.
 *
 * §9 names three distinct steps — recognise the bank receipt, identify the
 * lease account, then allocate to open charges — and the middle one had no
 * command at all: money that arrived without an identifiable payer sat in
 * suspense with no way out but reversing it. Reviewing a resident's proof of
 * payment had no command either, so evidence submitted through the portal could
 * never be resolved.
 *
 * The invariant that governs all of it: an uploaded proof of payment is a
 * CLAIM. It never moves a balance. Only confirmed funds do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, allocateReceipt, confirmReceipt, createResident,
  createStandaloneHouse, draftLease, identifySuspenseReceipt, parseMajorToMinor,
  postCharge, reverseAllocation, reviewPaymentEvidence, submitPaymentEvidence,
  suggestAllocation,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

/** Outstanding across every posted charge on a lease. */
async function outstanding(leaseId: string): Promise<bigint> {
  const [row] = await ownerSql()<{ total: string }[]>`
    select coalesce(sum(outstanding_minor), 0)::text as total
      from charge_line_balances where lease_id = ${leaseId}
  `;
  return BigInt(row!.total);
}

/** Unapplied credit sitting on a receipt. */
async function unapplied(receiptId: string): Promise<bigint> {
  const [row] = await ownerSql()<{ unapplied_minor: string }[]>`
    select unapplied_minor::text from receipt_balances where receipt_id = ${receiptId}
  `;
  return BigInt(row!.unapplied_minor);
}

/** Every journal in the organisation, whatever its source. */
async function journalCountFor(organisationId: string): Promise<number> {
  const [row] = await ownerSql()<{ count: string }[]>`
    select count(*)::text as count from journals where organisation_id = ${organisationId}
  `;
  return Number(row!.count);
}

describe('Receipts, allocation and suspense', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let rentLineId: string;
  let waterLineId: string;

  beforeAll(async () => {
    org = await createOrganisation('Receipt Co');

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
      }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Receipt House', code: 'RCPT', propertyType: 'house',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('8000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );

    // R8,000 rent due on the 1st and R350 water due on the 7th, so "oldest
    // first" has something to order.
    const invoice = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        periodStart: '2026-01-01', periodEnd: '2026-01-31',
        lines: [
          { category: 'rent', description: 'January rent', amountMinor: R('8000'), dueDate: '2026-01-01' },
          { category: 'utility_water', description: 'Water', amountMinor: R('350'), dueDate: '2026-01-07' },
        ],
      }),
    );
    const lines = await ownerSql()<{ id: string; category: string }[]>`
      select id, category from charge_lines where document_id = ${invoice.documentId}
       order by line_number
    `;
    rentLineId = lines[0]!.id;
    waterLineId = lines[1]!.id;
  });

  afterAll(async () => { await closeOwner(); });

  const journalCount = () => journalCountFor(org.organisationId);

  /* ------------------------------------------------- proof is not payment */

  it('leaves the balance untouched when a resident uploads proof of payment', async () => {
    const before = await outstanding(leaseId);
    const journalsBefore = await journalCount();

    await as(org.adminUserId, (tx) =>
      submitPaymentEvidence(tx, org.organisationId, org.adminUserId, {
        leaseId, claimedAmountMinor: R('8350'), claimedPaidAt: '2026-01-05',
        reference: 'EFT from my phone',
      }),
    );

    expect(await outstanding(leaseId)).toBe(before);
    // Not one journal, of any source. There is no `evidence` value in the
    // journal source enum at all, which is the invariant expressed in the
    // schema rather than only in a test.
    expect(await journalCount()).toBe(journalsBefore);
  });

  it('accepting proof of payment still does not create money', async () => {
    const [evidence] = await ownerSql()<{ id: string }[]>`
      select id from payment_evidence where lease_id = ${leaseId} order by submitted_at desc limit 1
    `;
    const before = await outstanding(leaseId);

    await as(org.adminUserId, (tx) =>
      reviewPaymentEvidence(tx, org.organisationId, org.adminUserId, {
        evidenceId: evidence!.id, outcome: 'accepted',
        note: 'Looks genuine; waiting for it to appear on the bank statement.',
      }),
    );

    // The claim is accepted. The resident still owes exactly what they owed,
    // because nothing has arrived in the account.
    expect(await outstanding(leaseId)).toBe(before);
    const [row] = await ownerSql()<{ status: string; receipt_id: string | null }[]>`
      select status::text, receipt_id from payment_evidence where id = ${evidence!.id}
    `;
    expect(row!.status).toBe('accepted');
    expect(row!.receipt_id).toBeNull();
  });

  it('demands a reason before rejecting a resident\'s claim', async () => {
    // The resident is told the outcome, so "rejected" with no explanation is
    // not an acceptable thing for the product to send.
    const [evidence] = await ownerSql()<{ id: string }[]>`
      select id from payment_evidence where lease_id = ${leaseId} limit 1
    `;
    await expect(
      as(org.adminUserId, (tx) =>
        reviewPaymentEvidence(tx, org.organisationId, org.adminUserId, {
          evidenceId: evidence!.id, outcome: 'rejected',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /* --------------------------------------------------- partial allocation */

  it('suggests oldest due date first, and records the policy', async () => {
    const suggestion = await as(org.adminUserId, (tx) =>
      suggestAllocation(tx, org.organisationId, { leaseId, amountMinor: R('5000') }),
    );
    expect(suggestion.policy).toBe('oldest_due_date_first');
    // Rent is due on the 1st, water on the 7th. R5,000 does not reach the water.
    expect(suggestion.allocations).toEqual([
      { chargeLineId: rentLineId, amountMinor: R('5000') },
    ]);
    expect(suggestion.remainingMinor).toBe(0n);
  });

  it('applies a partial payment and leaves the rest outstanding', async () => {
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('5000'), receivedOn: '2026-01-10',
      }),
    );
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, postingDate: '2026-01-10', policy: 'manual',
        allocations: [{ chargeLineId: rentLineId, amountMinor: R('5000') }],
      }),
    );
    // 8,350 billed less 5,000 applied.
    expect(await outstanding(leaseId)).toBe(R('3350'));
    expect(await unapplied(receipt.receiptId)).toBe(0n);
  });

  it('keeps an overpayment as traceable unapplied credit', async () => {
    // §9: "Keep overpayments as unapplied credit". Not forced onto a charge,
    // not written off, not silently refunded.
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('5000'), receivedOn: '2026-01-15',
      }),
    );
    const suggestion = await as(org.adminUserId, (tx) =>
      suggestAllocation(tx, org.organisationId, { leaseId, amountMinor: R('5000') }),
    );
    // Only 3,350 of open charges remain, so 1,650 has nowhere to go.
    expect(suggestion.remainingMinor).toBe(R('1650'));

    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, postingDate: '2026-01-15',
        allocations: suggestion.allocations,
      }),
    );
    expect(await outstanding(leaseId)).toBe(0n);
    expect(await unapplied(receipt.receiptId)).toBe(R('1650'));
  });

  it('refuses to allocate more than the receipt holds', async () => {
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('100'), receivedOn: '2026-01-20',
      }),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        allocateReceipt(tx, org.organisationId, org.adminUserId, {
          receiptId: receipt.receiptId, postingDate: '2026-01-20',
          allocations: [{ chargeLineId: waterLineId, amountMinor: R('500') }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'over_allocation' });
  });

  /* ------------------------------------------------------------- suspense */

  it('holds unidentified money in suspense rather than guessing a lease', async () => {
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        amountMinor: R('2000'), receivedOn: '2026-01-25', payerReference: 'MOKOENA T',
      }),
    );
    expect(receipt.inSuspense).toBe(true);
    const [row] = await ownerSql()<{ lease_id: string | null; in_suspense: boolean }[]>`
      select lease_id, in_suspense from receipts where id = ${receipt.receiptId}
    `;
    expect(row!.lease_id).toBeNull();
    expect(row!.in_suspense).toBe(true);
  });

  it('moves an identified receipt out of suspense without allocating it', async () => {
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        amountMinor: R('2000'), receivedOn: '2026-01-26', payerReference: 'MOKOENA T',
      }),
    );
    const before = await outstanding(leaseId);

    await as(org.adminUserId, (tx) =>
      identifySuspenseReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, leaseId, postingDate: '2026-01-27',
        reason: 'Matched the reference to this resident on the bank statement.',
      }),
    );

    const [row] = await ownerSql()<{ lease_id: string; in_suspense: boolean }[]>`
      select lease_id, in_suspense from receipts where id = ${receipt.receiptId}
    `;
    expect(row!.lease_id).toBe(leaseId);
    expect(row!.in_suspense).toBe(false);

    // Identifying whose money it is says nothing about what it pays for. The
    // balance must not move until someone allocates it.
    expect(await outstanding(leaseId)).toBe(before);
    expect(await unapplied(receipt.receiptId)).toBe(R('2000'));
  });

  it('refuses to identify a receipt that is already on a lease', async () => {
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('100'), receivedOn: '2026-01-28',
      }),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        identifySuspenseReceipt(tx, org.organisationId, org.adminUserId, {
          receiptId: receipt.receiptId, leaseId, postingDate: '2026-01-28',
          reason: 'Should not be possible; use a reversal instead.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps the subledger balanced after identifying a payer', async () => {
    const [trial] = await ownerSql()<{ debit: string; credit: string }[]>`
      select coalesce(sum(debit_minor), 0)::text as debit,
             coalesce(sum(credit_minor), 0)::text as credit
        from trial_balance where organisation_id = ${org.organisationId}
    `;
    expect(trial!.debit).toBe(trial!.credit);
  });

  /* ------------------------------------------------------------ reversals */

  it('requires the reversal permission to reverse an allocation', async () => {
    // It had none. `reverseReceipt` checked before calling in, which protected
    // that path and left this one open to anyone who could reach the function.
    const preparer = await addMember(org.organisationId, 'Prep Arer', ['finance_preparer']);
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('100'), receivedOn: '2026-02-01',
      }),
    );
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'adjustment_debit',
        issueDate: '2026-02-01', dueDate: '2026-02-01',
        lines: [{ category: 'other', description: 'Key replacement', amountMinor: R('100'), dueDate: '2026-02-01' }],
      }),
    );
    const [line] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${charge.documentId}
    `;
    const allocated = await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, postingDate: '2026-02-01',
        allocations: [{ chargeLineId: line!.id, amountMinor: R('100') }],
      }),
    );

    await expect(
      as(preparer, (tx) =>
        reverseAllocation(tx, org.organisationId, preparer, {
          allocationId: allocated.allocationIds[0]!, postingDate: '2026-02-02',
          reason: 'A preparer must not be able to do this.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The approver can, and the money returns to unapplied credit rather than
    // disappearing.
    await as(org.adminUserId, (tx) =>
      reverseAllocation(tx, org.organisationId, org.adminUserId, {
        allocationId: allocated.allocationIds[0]!, postingDate: '2026-02-02',
        reason: 'Applied to the wrong charge; re-allocating.',
      }),
    );
    expect(await unapplied(receipt.receiptId)).toBe(R('100'));
  });

  it('cannot reverse the same allocation twice', async () => {
    const [allocation] = await ownerSql()<{ id: string }[]>`
      select id from payment_allocations
       where organisation_id = ${org.organisationId} and reversed_at is not null
       limit 1
    `;
    await expect(
      as(org.adminUserId, (tx) =>
        reverseAllocation(tx, org.organisationId, org.adminUserId, {
          allocationId: allocation!.id, postingDate: '2026-02-03',
          reason: 'Second reversal of the same row.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('ends with a balanced ledger', async () => {
    const [trial] = await ownerSql()<{ debit: string; credit: string }[]>`
      select coalesce(sum(debit_minor), 0)::text as debit,
             coalesce(sum(credit_minor), 0)::text as credit
        from trial_balance where organisation_id = ${org.organisationId}
    `;
    expect(trial!.debit).toBe(trial!.credit);
  });
});
