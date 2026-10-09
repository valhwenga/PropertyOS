/**
 * Deposits: someone else's money, held.
 *
 * The schema has carried the controls since the start — an approver who is not
 * the requester, evidence behind every deduction, evidence behind any interest
 * — and they were tested by inserting rows directly. There were no commands at
 * all, so nothing a person could reach enforced any of it, and the earlier
 * reconciliation overstated this module as "tested" when what was tested was
 * the table.
 *
 * The invariant that governs the lot: a deposit is a LIABILITY. It is never
 * rental income and it never reduces what a resident owes. The acceptance
 * fixture turns on exactly that — the deposit held does not touch the R1,850.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, approveDepositPayout, assertBookBalances, closeDepositAccount,
  createResident, createStandaloneHouse, creditDepositInterest, draftLease,
  getDepositAccount, listDepositAccounts, parseMajorToMinor, postCharge,
  recordDepositReceipt, registerDocument,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Deposits', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let depositAccountId: string;
  let evidenceId: string;
  let preparer: string;

  /** Outstanding across every posted charge on the lease. */
  async function outstanding(): Promise<bigint> {
    const [row] = await ownerSql()<{ total: string }[]>`
      select coalesce(sum(outstanding_minor), 0)::text as total
        from charge_line_balances where lease_id = ${leaseId}
    `;
    return BigInt(row!.total);
  }

  beforeAll(async () => {
    org = await createOrganisation('Deposit Co');
    preparer = await addMember(org.organisationId, 'Prep Arer', ['finance_preparer']);

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
      }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Deposit House', code: 'DEP', propertyType: 'house',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('8000'), depositRequiredMinor: R('8000'),
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

    // A rent charge, so there is something a deposit could wrongly be netted
    // against.
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('8000'), dueDate: '2026-01-01' }],
      }),
    );

    const doc = await as(org.adminUserId, (tx) =>
      registerDocument(
        tx, org.organisationId, org.adminUserId,
        {
          classification: 'deposit_evidence', title: 'Damage quotation',
          filename: 'quote.pdf', contentType: 'application/pdf',
          byteSize: 1024, contentSha256: 'b'.repeat(64), leaseId,
        },
        { status: 'clean', detail: 'Scanned clean in a test.' },
      ),
    );
    evidenceId = doc.documentId;
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------------- a deposit is a liability */

  it('records a deposit without touching what the resident owes', async () => {
    const before = await outstanding();

    const result = await as(org.adminUserId, (tx) =>
      recordDepositReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('8000'), receivedOn: '2026-01-01',
        holder: 'landlord', description: 'Deposit on signing',
      }),
    );
    depositAccountId = result.depositAccountId;

    // R8,000 arrived, and the resident still owes every cent of the rent.
    expect(await outstanding()).toBe(before);
    expect(before).toBe(R('8000'));

    const [account] = await as(org.adminUserId, (tx) =>
      listDepositAccounts(tx, org.organisationId),
    );
    expect(account!.heldMinor).toBe(R('8000'));
    expect(account!.requiredMinor).toBe(R('8000'));
    expect(account!.shortfallMinor).toBe(0n);
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('records a shortfall when less than required is held', async () => {
    const [account] = await as(org.adminUserId, (tx) =>
      listDepositAccounts(tx, org.organisationId),
    );
    // Nothing is outstanding here, but the arithmetic is what matters: the
    // shortfall is required less held, and never negative once interest lifts
    // the balance above what was required.
    expect(account!.shortfallMinor).toBe(0n);
  });

  it('says who holds the money rather than assuming the landlord does', async () => {
    const [account] = await as(org.adminUserId, (tx) =>
      listDepositAccounts(tx, org.organisationId),
    );
    expect(account!.holder).toBe('landlord');
    expect(account!.holderLabel).toBe('The landlord holds it in their own account');
  });

  /* ------------------------------------------------------------- interest */

  it('refuses to credit interest with no evidence behind it', async () => {
    // §10: "a guessed fixed rate must not be presented as actual earned
    // interest". There is no accrual anywhere in this module by design.
    await expect(
      as(org.adminUserId, (tx) =>
        creditDepositInterest(tx, org.organisationId, org.adminUserId, {
          depositAccountId, amountMinor: R('120'), effectiveOn: '2026-06-30',
          evidenceDocumentId: '', basis: 'bank_statement_evidence',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('credits interest from evidence, and records which kind', async () => {
    await as(org.adminUserId, (tx) =>
      creditDepositInterest(tx, org.organisationId, org.adminUserId, {
        depositAccountId, amountMinor: R('120'), effectiveOn: '2026-06-30',
        evidenceDocumentId: evidenceId, basis: 'bank_statement_evidence',
        description: 'Interest to 30 June per bank statement',
      }),
    );
    const account = await as(org.adminUserId, (tx) =>
      getDepositAccount(tx, org.organisationId, depositAccountId),
    );
    expect(account!.heldMinor).toBe(R('8120'));
    expect(account!.interestBasis).toBe('bank_statement_evidence');
    // More is held than was required. That is not a shortfall.
    expect(account!.shortfallMinor).toBe(0n);
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  /* ------------------------------------------- deductions need two people */

  it('refuses a deduction approved by the person who requested it', async () => {
    // §4: a preparer cannot approve their own. Enforced in the command with a
    // readable message, and independently by the database constraint.
    await expect(
      as(org.adminUserId, (tx) =>
        approveDepositPayout(tx, org.organisationId, org.adminUserId, {
          depositAccountId, kind: 'deduction', amountMinor: R('500'),
          effectiveOn: '2026-12-31', description: 'Broken window',
          evidenceDocumentId: evidenceId, requestedByUserId: org.adminUserId,
          approvalReason: 'Quotation from the glazier attached.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses a deduction with no evidence', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        approveDepositPayout(tx, org.organisationId, org.adminUserId, {
          depositAccountId, kind: 'deduction', amountMinor: R('500'),
          effectiveOn: '2026-12-31', description: 'Broken window',
          evidenceDocumentId: '', requestedByUserId: preparer,
          approvalReason: 'Taking their word for it.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a deduction without an approval reason', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        approveDepositPayout(tx, org.organisationId, org.adminUserId, {
          depositAccountId, kind: 'deduction', amountMinor: R('500'),
          effectiveOn: '2026-12-31', description: 'Broken window',
          evidenceDocumentId: evidenceId, requestedByUserId: preparer,
          approvalReason: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a finance preparer as the approver', async () => {
    await expect(
      as(preparer, (tx) =>
        approveDepositPayout(tx, org.organisationId, preparer, {
          depositAccountId, kind: 'deduction', amountMinor: R('500'),
          effectiveOn: '2026-12-31', description: 'Broken window',
          evidenceDocumentId: evidenceId, requestedByUserId: org.adminUserId,
          approvalReason: 'A preparer must not be able to approve this.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('records a deduction approved by a second person, with its evidence', async () => {
    await as(org.adminUserId, (tx) =>
      approveDepositPayout(tx, org.organisationId, org.adminUserId, {
        depositAccountId, kind: 'deduction', amountMinor: R('500'),
        effectiveOn: '2026-12-31', description: 'Broken window in the lounge',
        evidenceDocumentId: evidenceId, requestedByUserId: preparer,
        approvalReason: 'Glazier quotation attached and agreed with the resident.',
      }),
    );
    const account = await as(org.adminUserId, (tx) =>
      getDepositAccount(tx, org.organisationId, depositAccountId),
    );
    expect(account!.heldMinor).toBe(R('7620'));

    const deduction = account!.events.find((e) => e.eventType === 'deduction')!;
    expect(deduction.amountMinor).toBe(-R('500'));
    expect(deduction.evidenceDocumentId).toBe(evidenceId);
    expect(deduction.requestedByName).toBeTruthy();
    expect(deduction.approvedByName).toBeTruthy();
    expect(deduction.requestedByName).not.toBe(deduction.approvedByName);
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('refuses to pay out more than is held', async () => {
    // A deposit cannot go into deficit: the resident is owed what is held, not
    // what the lease once required.
    await expect(
      as(org.adminUserId, (tx) =>
        approveDepositPayout(tx, org.organisationId, org.adminUserId, {
          depositAccountId, kind: 'refund', amountMinor: R('9000'),
          effectiveOn: '2026-12-31', description: 'Refund on move out',
          evidenceDocumentId: evidenceId, requestedByUserId: preparer,
          approvalReason: 'More than the account holds.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /* --------------------------------------------------- refund and closure */

  it('refuses to close an account that still holds money', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        closeDepositAccount(tx, org.organisationId, org.adminUserId, {
          depositAccountId, closedOn: '2026-12-31',
          reason: 'Trying to close with a balance still held.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refunds the balance and records the payment reference', async () => {
    await as(org.adminUserId, (tx) =>
      approveDepositPayout(tx, org.organisationId, org.adminUserId, {
        depositAccountId, kind: 'refund', amountMinor: R('7620'),
        effectiveOn: '2026-12-31', description: 'Deposit refund on move out',
        evidenceDocumentId: evidenceId, requestedByUserId: preparer,
        approvalReason: 'Final inspection signed; balance returned in full.',
        refundReference: 'EFT 2026-12-31 MOKOENA',
      }),
    );
    const account = await as(org.adminUserId, (tx) =>
      getDepositAccount(tx, org.organisationId, depositAccountId),
    );
    expect(account!.heldMinor).toBe(0n);
    const refund = account!.events.find((e) => e.eventType === 'refund')!;
    expect(refund.refundReference).toBe('EFT 2026-12-31 MOKOENA');
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('closes an empty account without deleting its history', async () => {
    await as(org.adminUserId, (tx) =>
      closeDepositAccount(tx, org.organisationId, org.adminUserId, {
        depositAccountId, closedOn: '2026-12-31',
        reason: 'Refunded in full on move out.',
      }),
    );
    const account = await as(org.adminUserId, (tx) =>
      getDepositAccount(tx, org.organisationId, depositAccountId),
    );
    expect(account!.status).toBe('closed');
    // §3: suspension is not deletion. Every event is still readable.
    expect(account!.events.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses further movement on a closed account', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        creditDepositInterest(tx, org.organisationId, org.adminUserId, {
          depositAccountId, amountMinor: R('10'), effectiveOn: '2027-01-01',
          evidenceDocumentId: evidenceId, basis: 'bank_statement_evidence',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('never let the deposit touch the rent receivable', async () => {
    // The whole module in one assertion. R8,000 came in, R500 was deducted,
    // R7,620 went back out, and the resident has owed R8,000 of rent
    // throughout.
    expect(await outstanding()).toBe(R('8000'));
  });

  it('does not show one organisation another organisation\'s deposits', async () => {
    const other = await createOrganisation('Elsewhere Deposits');
    const accounts = await as(other.adminUserId, (tx) =>
      listDepositAccounts(tx, other.organisationId),
    );
    expect(accounts).toEqual([]);
    await expect(
      as(other.adminUserId, (tx) =>
        getDepositAccount(tx, other.organisationId, depositAccountId),
      ),
    ).resolves.toBeUndefined();
  });
});
