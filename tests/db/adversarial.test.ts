/**
 * Adversarial review of the financial and isolation paths.
 *
 * These tests were written by going back over the implementation looking for
 * what I got WRONG, rather than for confirmation that it works. Several of them
 * failed when first written; the fixes are in the same commit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withActor } from '@propertyos/db';
import {
  activateLease, allocateReceipt, assertBookBalances, buildStatement,
  confirmReceipt, createResident, createStandaloneHouse, draftLease,
  issueCreditNote, parseMajorToMinor, postCharge, reverseAllocation,
  reverseReceipt, suggestAllocation,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Adversarial: credit notes', () => {
  let org: OrganisationFixture;
  let leaseId: string;

  beforeAll(async () => {
    org = await createOrganisation('Adversarial Credit Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Credit', lastName: 'Target' }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Credit House', code: 'CRED1', propertyType: 'house',
        addressLine1: '1 Credit Road', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31', rentMinor: R('5000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Filed offline.',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('refuses a SECOND credit note that would over-credit the original', async () => {
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'utility_invoice', issueDate: '2026-03-01', dueDate: '2026-03-05',
        lines: [{ category: 'utility_water', description: 'Water', amountMinor: R('900'), dueDate: '2026-03-05' }],
      }),
    );

    // First credit of R600 against a R900 charge: fine.
    await as(org.adminUserId, (tx) =>
      issueCreditNote(tx, org.organisationId, org.adminUserId, {
        documentId: charge.documentId, reason: 'Partial correction after meter re-read.',
        issueDate: '2026-03-02',
        lines: [{ description: 'Credit part one', amountMinor: R('600'), category: 'utility_water' }],
      }),
    );

    // Second credit of R600 would take the total credited to R1,200 against a
    // R900 charge, leaving the resident in credit on a charge they never
    // overpaid. Each note is individually under the original total, so a
    // per-note check alone does not catch this.
    await expect(
      as(org.adminUserId, (tx) =>
        issueCreditNote(tx, org.organisationId, org.adminUserId, {
          documentId: charge.documentId, reason: 'Duplicate correction, should be refused.',
          issueDate: '2026-03-03',
          lines: [{ description: 'Credit part two', amountMinor: R('600'), category: 'utility_water' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    // The remaining R300 may still be credited.
    await as(org.adminUserId, (tx) =>
      issueCreditNote(tx, org.organisationId, org.adminUserId, {
        documentId: charge.documentId, reason: 'Crediting the remaining balance.',
        issueDate: '2026-03-04',
        lines: [{ description: 'Credit the rest', amountMinor: R('300'), category: 'utility_water' }],
      }),
    );

    const statement = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-03-31' }),
    );
    // Fully credited: the charge nets to nothing, never to a negative.
    expect(statement.closingReceivableMinor).toBe(0n);
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('refuses two concurrent credit notes that would together over-credit', async () => {
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'utility_invoice', issueDate: '2026-04-01', dueDate: '2026-04-05',
        lines: [{ category: 'utility_water', description: 'Water April', amountMinor: R('500'), dueDate: '2026-04-05' }],
      }),
    );

    const attempt = (note: string) =>
      withActor({ authUserId: org.adminUserId, assuranceLevel: 'aal2' }, ({ tx }) =>
        issueCreditNote(tx, org.organisationId, org.adminUserId, {
          documentId: charge.documentId, reason: `Concurrent correction ${note}.`,
          issueDate: '2026-04-02',
          lines: [{ description: `Credit ${note}`, amountMinor: R('500'), category: 'utility_water' }],
        }),
      );

    const results = await Promise.allSettled([attempt('A'), attempt('B')]);
    // Exactly one wins. Without a row lock on the original document both read a
    // zero already-credited total and both succeed.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const [credited] = await ownerSql()<{ total: string }[]>`
      select coalesce(sum(-total_minor), 0)::text as total from charge_documents
      where corrects_document_id = ${charge.documentId} and document_type = 'credit_note'
    `;
    expect(BigInt(credited!.total)).toBe(R('500'));
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('refuses to credit a document in another organisation', async () => {
    const other = await createOrganisation('Adversarial Neighbour');
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'utility_invoice', issueDate: '2026-05-01', dueDate: '2026-05-05',
        lines: [{ category: 'utility_water', description: 'Water May', amountMinor: R('100'), dueDate: '2026-05-05' }],
      }),
    );
    await expect(
      as(other.adminUserId, (tx) =>
        issueCreditNote(tx, other.organisationId, other.adminUserId, {
          documentId: charge.documentId, reason: 'Attempting to credit a foreign document.',
          issueDate: '2026-05-02',
          lines: [{ description: 'Should fail', amountMinor: R('100'), category: 'utility_water' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Adversarial: allocation and reversal edge cases', () => {
  let org: OrganisationFixture;
  let leaseId: string;

  beforeAll(async () => {
    org = await createOrganisation('Adversarial Allocation Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Alloc', lastName: 'Target' }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Alloc House', code: 'ALLOC1', propertyType: 'house',
        addressLine1: '1 Alloc Road', city: 'Durban',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', rentMinor: R('4000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Filed offline.',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('frees the receipt again after an allocation is reversed', async () => {
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice', issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('4000'), dueDate: '2026-01-01' }],
      }),
    );
    const [line] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${charge.documentId}
    `;
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('4000'), receivedOn: '2026-01-05',
      }),
    );
    const first = await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId,
        allocations: [{ chargeLineId: line!.id, amountMinor: R('4000') }],
        postingDate: '2026-01-05',
      }),
    );
    expect(first.unappliedMinor).toBe(0n);

    await as(org.adminUserId, (tx) =>
      reverseAllocation(tx, org.organisationId, org.adminUserId, {
        allocationId: first.allocationIds[0]!,
        reason: 'Applied to the wrong charge.', postingDate: '2026-01-06',
      }),
    );

    // The money is available again and the debt is back.
    const [balance] = await ownerSql()<{ unapplied_minor: string }[]>`
      select unapplied_minor::text from receipt_balances where receipt_id = ${receipt.receiptId}
    `;
    expect(BigInt(balance!.unapplied_minor)).toBe(R('4000'));

    // And it can be re-allocated without tripping the over-allocation guard.
    const second = await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId,
        allocations: [{ chargeLineId: line!.id, amountMinor: R('4000') }],
        postingDate: '2026-01-07',
      }),
    );
    expect(second.unappliedMinor).toBe(0n);
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('refuses to reverse the same allocation twice', async () => {
    const [allocation] = await ownerSql()<{ id: string }[]>`
      select pa.id from payment_allocations pa
      join charge_lines cl on cl.id = pa.charge_line_id
      where cl.lease_id = ${leaseId} and pa.reversed_at is null limit 1
    `;
    await as(org.adminUserId, (tx) =>
      reverseAllocation(tx, org.organisationId, org.adminUserId, {
        allocationId: allocation!.id, reason: 'First reversal.', postingDate: '2026-01-08',
      }),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        reverseAllocation(tx, org.organisationId, org.adminUserId, {
          allocationId: allocation!.id, reason: 'Second reversal, should fail.', postingDate: '2026-01-09',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses to allocate a receipt belonging to a different lease', async () => {
    const otherResident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Other', lastName: 'Lease' }),
    );
    const otherHouse = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Other Alloc House', code: 'ALLOC2', propertyType: 'house',
        addressLine1: '2 Alloc Road', city: 'Durban',
      }),
    );
    const otherLease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: otherHouse.unitId, startDate: '2026-01-01', rentMinor: R('3000'),
        parties: [{ residentId: otherResident.residentId, role: 'primary_resident' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: otherLease.leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Filed offline.',
      }),
    );
    const otherCharge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId: otherLease.leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'Rent', amountMinor: R('3000'), dueDate: '2026-01-01' }],
      }),
    );
    const [otherLine] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${otherCharge.documentId}
    `;
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('1000'), receivedOn: '2026-02-01',
      }),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        allocateReceipt(tx, org.organisationId, org.adminUserId, {
          receiptId: receipt.receiptId,
          allocations: [{ chargeLineId: otherLine!.id, amountMinor: R('1000') }],
          postingDate: '2026-02-01',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps the book balanced after reversing a receipt that was partly allocated', async () => {
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'adjustment_debit', issueDate: '2026-06-01', dueDate: '2026-06-01',
        lines: [{ category: 'other', description: 'Partial reversal charge', amountMinor: R('2000'), dueDate: '2026-06-01' }],
      }),
    );
    const [line] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${charge.documentId}
    `;
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('2500'), receivedOn: '2026-06-02',
      }),
    );
    // Allocate only part; R500 stays as unapplied credit.
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId,
        allocations: [{ chargeLineId: line!.id, amountMinor: R('2000') }],
        postingDate: '2026-06-02',
      }),
    );
    await as(org.adminUserId, (tx) =>
      reverseReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, reason: 'Payment returned unpaid by the bank.',
        postingDate: '2026-06-10',
      }),
    );

    const [balance] = await ownerSql()<{ outstanding_minor: string }[]>`
      select outstanding_minor::text from charge_line_balances where charge_line_id = ${line!.id}
    `;
    expect(BigInt(balance!.outstanding_minor)).toBe(R('2000'));

    // The unapplied credit disappears with the reversed receipt, rather than
    // lingering as money the landlord never had.
    const [unapplied] = await ownerSql()<{ c: string }[]>`
      select count(*)::text as c from receipt_balances where receipt_id = ${receipt.receiptId}
    `;
    expect(unapplied!.c).toBe('0');
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('never suggests allocating more than the money available', async () => {
    const suggestion = await as(org.adminUserId, (tx) =>
      suggestAllocation(tx, org.organisationId, { leaseId, amountMinor: R('100') }),
    );
    const suggested = suggestion.allocations.reduce((s, a) => s + a.amountMinor, 0n);
    expect(suggested + suggestion.remainingMinor).toBe(R('100'));
    expect(suggested).toBeLessThanOrEqual(R('100'));
  });
});

describe('Adversarial: statement and balance consistency', () => {
  let org: OrganisationFixture;
  let leaseId: string;

  beforeAll(async () => {
    org = await createOrganisation('Adversarial Statement Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'State', lastName: 'Ment' }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Statement House', code: 'STMT1', propertyType: 'house',
        addressLine1: '1 Statement Road', city: 'Pretoria',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', rentMinor: R('6000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Filed offline.',
      }),
    );
    for (const month of ['01', '02', '03']) {
      await as(org.adminUserId, (tx) =>
        postCharge(tx, org.organisationId, org.adminUserId, {
          leaseId, documentType: 'rent_invoice',
          issueDate: `2026-${month}-01`, dueDate: `2026-${month}-01`,
          lines: [{ category: 'rent', description: `Rent ${month}`, amountMinor: R('6000'), dueDate: `2026-${month}-01` }],
        }),
      );
    }
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('9000'), receivedOn: '2026-02-10',
      }),
    );
    const suggestion = await as(org.adminUserId, (tx) =>
      suggestAllocation(tx, org.organisationId, { leaseId, amountMinor: R('9000') }),
    );
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, allocations: suggestion.allocations, postingDate: '2026-02-10',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('agrees with lease_balances at the full cut-off', async () => {
    const statement = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-12-31' }),
    );
    const [balance] = await ownerSql()<{ receivable_minor: string }[]>`
      select receivable_minor::text from lease_balances where lease_id = ${leaseId}
    `;
    // Two independently written code paths over the same posted records.
    expect(statement.closingReceivableMinor).toBe(BigInt(balance!.receivable_minor));
    expect(statement.closingReceivableMinor).toBe(R('9000')); // 18,000 billed less 9,000 allocated
  });

  it('carries the opening balance correctly when a window is applied', async () => {
    const whole = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-12-31' }),
    );
    const windowed = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, from: '2026-03-01', cutOff: '2026-12-31' }),
    );
    // A windowed statement must reach the same closing figure: the opening
    // balance has to absorb everything before the window.
    expect(windowed.closingReceivableMinor).toBe(whole.closingReceivableMinor);
    expect(windowed.openingBalanceMinor).toBe(R('3000')); // 12,000 billed less 9,000 paid by 29 Feb
    expect(windowed.openingBalanceSource).toBe('prior_activity');
  });

  it('is reproducible: the same cut-off yields the same figures', async () => {
    const first = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-02-28' }),
    );
    const second = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-02-28' }),
    );
    expect(second.closingReceivableMinor).toBe(first.closingReceivableMinor);
    expect(second.lines.map((l) => l.runningBalanceMinor))
      .toEqual(first.lines.map((l) => l.runningBalanceMinor));
  });

  it('excludes activity after the cut-off', async () => {
    const atFeb = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-02-28' }),
    );
    // Two months billed, nine thousand paid.
    expect(atFeb.closingReceivableMinor).toBe(R('3000'));
    expect(atFeb.lines.every((l) => l.entryDate <= '2026-02-28')).toBe(true);
  });

  it('keeps the running balance consistent with its own lines', async () => {
    const statement = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-12-31' }),
    );
    let running = statement.openingBalanceMinor;
    for (const line of statement.lines) {
      running = running + line.debitMinor - line.creditMinor;
      expect(line.runningBalanceMinor).toBe(running);
    }
    expect(running).toBe(statement.closingReceivableMinor);
  });
});
