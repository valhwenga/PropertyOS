/**
 * Financial invariant tests.
 *
 * These assert the guarantees the database itself makes, because that is where
 * they are enforced. Several deliberately bypass the domain layer and attack the
 * tables directly, to prove the invariant survives a bug in application code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withActor } from '@propertyos/db';
import {
  activateLease, allocateReceipt, assertBookBalances, buildStatement,
  confirmReceipt, createResident, createStandaloneHouse, draftLease,
  issueCreditNote, parseMajorToMinor, postCharge, reverseReceipt,
} from '@propertyos/domain';
import { as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture } from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Financial invariants', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let unitId: string;
  let residentId: string;

  beforeAll(async () => {
    org = await createOrganisation('Ledger Test Co');
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Ledger House', code: 'LEDGER1', propertyType: 'house',
        addressLine1: '1 Ledger Lane', city: 'Durban',
      }),
    );
    unitId = house.unitId;
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Ledger', lastName: 'Tester' }),
    );
    residentId = resident.residentId;
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId, startDate: '2026-03-01', endDate: '2027-02-28', rentMinor: R('10000'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-03-01',
        executionExceptionReason: 'Contract scanned and filed offline.',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('rejects an unbalanced journal even when written directly to the tables', async () => {
    const sql = ownerSql();
    await expect(
      sql.begin(async (tx) => {
        const [journal] = await tx<{ id: string }[]>`
          insert into journals (organisation_id, book_id, currency_code, posting_date, source, description)
          values (${org.organisationId}, ${org.bookId}, 'ZAR', '2026-03-01', 'adjustment', 'Deliberately unbalanced')
          returning id
        `;
        const [account] = await tx<{ id: string }[]>`
          select id from accounts where book_id = ${org.bookId} and system_role = 'resident_receivable'
        `;
        const [income] = await tx<{ id: string }[]>`
          select id from accounts where book_id = ${org.bookId} and system_role = 'rental_income'
        `;
        await tx`
          insert into journal_lines (organisation_id, journal_id, account_id, debit_minor, currency_code, line_number)
          values (${org.organisationId}, ${journal!.id}, ${account!.id}, 100000, 'ZAR', 1)
        `;
        // Credit deliberately short by 1 cent.
        await tx`
          insert into journal_lines (organisation_id, journal_id, account_id, credit_minor, currency_code, line_number)
          values (${org.organisationId}, ${journal!.id}, ${income!.id}, 99999, 'ZAR', 2)
        `;
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('refuses to update or delete a posted journal line', async () => {
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice', issueDate: '2026-03-01', dueDate: '2026-03-01',
        lines: [{ category: 'rent', description: 'March rent', amountMinor: R('10000'), dueDate: '2026-03-01' }],
      }),
    );
    const sql = ownerSql();
    await expect(
      sql`update journal_lines set debit_minor = 1 where journal_id = ${charge.journalId}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`delete from journals where id = ${charge.journalId}`,
    ).rejects.toThrow(/immutable/);
  });

  it('refuses to edit a charge line once its document is posted', async () => {
    const [line] = await ownerSql()<{ id: string }[]>`
      select cl.id from charge_lines cl
      join charge_documents cd on cd.id = cl.document_id
      where cl.lease_id = ${leaseId} and cd.status = 'posted' limit 1
    `;
    await expect(
      ownerSql()`update charge_lines set amount_minor = 1 where id = ${line!.id}`,
    ).rejects.toThrow(/immutable/);
  });

  it('corrects a wrong charge with a linked credit note, retaining the original', async () => {
    const wrong = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'utility_invoice', issueDate: '2026-03-02', dueDate: '2026-03-05',
        lines: [{ category: 'utility_water', description: 'Water (misread meter)', amountMinor: R('900'), dueDate: '2026-03-05' }],
      }),
    );
    const credit = await as(org.adminUserId, (tx) =>
      issueCreditNote(tx, org.organisationId, org.adminUserId, {
        documentId: wrong.documentId,
        reason: 'Meter was misread; corrected reading issued separately.',
        issueDate: '2026-03-03',
        lines: [{ description: 'Credit: water misread', amountMinor: R('900'), category: 'utility_water' }],
      }),
    );

    const [original] = await ownerSql()<{ status: string; total_minor: string }[]>`
      select status, total_minor::text from charge_documents where id = ${wrong.documentId}
    `;
    // The original is untouched; the correction is a separate, linked document.
    expect(original).toMatchObject({ status: 'posted', total_minor: '90000' });

    const [note] = await ownerSql()<{ corrects_document_id: string; correction_reason: string }[]>`
      select corrects_document_id, correction_reason from charge_documents where id = ${credit.documentId}
    `;
    expect(note!.corrects_document_id).toBe(wrong.documentId);

    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('never lets two concurrent allocations overspend one receipt', async () => {
    const charge1 = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'adjustment_debit', issueDate: '2026-04-01', dueDate: '2026-04-01',
        lines: [{ category: 'other', description: 'Concurrency charge A', amountMinor: R('1000'), dueDate: '2026-04-01' }],
      }),
    );
    const charge2 = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'adjustment_debit', issueDate: '2026-04-01', dueDate: '2026-04-02',
        lines: [{ category: 'other', description: 'Concurrency charge B', amountMinor: R('1000'), dueDate: '2026-04-02' }],
      }),
    );
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('1000'), receivedOn: '2026-04-01',
      }),
    );

    const [lineA] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${charge1.documentId}
    `;
    const [lineB] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${charge2.documentId}
    `;

    // Two transactions race to spend the SAME R1,000 on two different charges.
    const attempt = (chargeLineId: string) =>
      withActor({ authUserId: org.adminUserId, assuranceLevel: 'aal2' }, ({ tx }) =>
        allocateReceipt(tx, org.organisationId, org.adminUserId, {
          receiptId: receipt.receiptId,
          allocations: [{ chargeLineId, amountMinor: R('1000') }],
          postingDate: '2026-04-01',
        }),
      );

    const results = await Promise.allSettled([attempt(lineA!.id), attempt(lineB!.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one wins. The other is refused, not silently truncated.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const [total] = await ownerSql()<{ allocated: string }[]>`
      select coalesce(sum(amount_minor), 0)::text as allocated
      from payment_allocations where receipt_id = ${receipt.receiptId} and reversed_at is null
    `;
    expect(BigInt(total!.allocated)).toBe(R('1000'));
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('rejects an over-allocation written straight to the allocations table', async () => {
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('100'), receivedOn: '2026-04-02',
      }),
    );
    const [line] = await ownerSql()<{ id: string }[]>`
      select cl.id from charge_lines cl
      join charge_documents cd on cd.id = cl.document_id
      where cl.lease_id = ${leaseId} and cd.status = 'posted' and cl.amount_minor >= 100000 limit 1
    `;
    await expect(
      ownerSql()`
        insert into payment_allocations (organisation_id, receipt_id, charge_line_id, amount_minor, currency_code)
        values (${org.organisationId}, ${receipt.receiptId}, ${line!.id}, 10000000, 'ZAR')
      `,
    ).rejects.toThrow(/exceeds receipt/);
  });

  it('refuses to allocate an unconfirmed receipt', async () => {
    const sql = ownerSql();
    const [pending] = await sql<{ id: string }[]>`
      insert into receipts (
        organisation_id, book_id, lease_id, receipt_number, status,
        amount_minor, currency_code, received_on
      ) values (
        ${org.organisationId}, ${org.bookId}, ${leaseId}, ${`RCT-PENDING-${Date.now()}`},
        'pending', 500000, 'ZAR', '2026-04-03'
      ) returning id
    `;
    const [line] = await sql<{ id: string }[]>`
      select cl.id from charge_lines cl join charge_documents cd on cd.id = cl.document_id
      where cl.lease_id = ${leaseId} and cd.status = 'posted' limit 1
    `;
    await expect(
      sql`
        insert into payment_allocations (organisation_id, receipt_id, charge_line_id, amount_minor, currency_code)
        values (${org.organisationId}, ${pending!.id}, ${line!.id}, 1000, 'ZAR')
      `,
    ).rejects.toThrow(/only confirmed funds/i);
  });

  it('keeps an overpayment as traceable unapplied credit', async () => {
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'adjustment_debit', issueDate: '2026-05-01', dueDate: '2026-05-01',
        lines: [{ category: 'other', description: 'Small charge', amountMinor: R('200'), dueDate: '2026-05-01' }],
      }),
    );
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('500'), receivedOn: '2026-05-01',
      }),
    );
    const [line] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${charge.documentId}
    `;
    const result = await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId,
        allocations: [{ chargeLineId: line!.id, amountMinor: R('200') }],
        postingDate: '2026-05-01',
      }),
    );
    expect(result.unappliedMinor).toBe(R('300'));

    const [balance] = await ownerSql()<{ unapplied_minor: string }[]>`
      select unapplied_minor::text from receipt_balances where receipt_id = ${receipt.receiptId}
    `;
    expect(BigInt(balance!.unapplied_minor)).toBe(R('300'));
  });

  it('leaves a partially paid charge in its original due date bucket', async () => {
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'adjustment_debit', issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'other', description: 'Old arrears line', amountMinor: R('1000'), dueDate: '2026-01-01' }],
      }),
    );
    const [line] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${charge.documentId}
    `;
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('400'), receivedOn: '2026-06-01',
      }),
    );
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId,
        allocations: [{ chargeLineId: line!.id, amountMinor: R('400') }],
        postingDate: '2026-06-01',
      }),
    );
    const [balance] = await ownerSql()<{ outstanding_minor: string; due_date: string }[]>`
      select outstanding_minor::text, due_date::text from charge_line_balances where charge_line_id = ${line!.id}
    `;
    // The remaining R600 keeps the ORIGINAL due date for ageing purposes.
    expect(BigInt(balance!.outstanding_minor)).toBe(R('600'));
    expect(balance!.due_date).toBe('2026-01-01');
  });

  it('reverses a receipt and its allocations together, keeping the book balanced', async () => {
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'adjustment_debit', issueDate: '2026-07-01', dueDate: '2026-07-01',
        lines: [{ category: 'other', description: 'Bounced payment charge', amountMinor: R('750'), dueDate: '2026-07-01' }],
      }),
    );
    const [line] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${charge.documentId}
    `;
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('750'), receivedOn: '2026-07-01',
      }),
    );
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId,
        allocations: [{ chargeLineId: line!.id, amountMinor: R('750') }],
        postingDate: '2026-07-01',
      }),
    );
    const [paid] = await ownerSql()<{ outstanding_minor: string }[]>`
      select outstanding_minor::text from charge_line_balances where charge_line_id = ${line!.id}
    `;
    expect(BigInt(paid!.outstanding_minor)).toBe(0n);

    await as(org.adminUserId, (tx) =>
      reverseReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId,
        reason: 'EFT returned unpaid by the bank.',
        postingDate: '2026-07-05',
      }),
    );

    const [afterReversal] = await ownerSql()<{ outstanding_minor: string }[]>`
      select outstanding_minor::text from charge_line_balances where charge_line_id = ${line!.id}
    `;
    // The debt comes back; nothing was erased.
    expect(BigInt(afterReversal!.outstanding_minor)).toBe(R('750'));
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('refuses to post into a locked accounting period', async () => {
    await ownerSql()`
      insert into period_locks (organisation_id, book_id, locked_through)
      values (${org.organisationId}, ${org.bookId}, '2025-12-31')
    `;
    await expect(
      as(org.adminUserId, (tx) =>
        postCharge(tx, org.organisationId, org.adminUserId, {
          leaseId, documentType: 'adjustment_debit', issueDate: '2025-11-15', dueDate: '2025-11-15',
          lines: [{ category: 'other', description: 'Backdated into a locked period', amountMinor: R('100'), dueDate: '2025-11-15' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'period_locked' });
  });

  it('keeps the whole book balanced after every operation in this suite', async () => {
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
    const rows = await ownerSql()<{ net_minor: string }[]>`
      select sum(net_minor)::text as net_minor from trial_balance where book_id = ${org.bookId}
    `;
    expect(BigInt(rows[0]!.net_minor)).toBe(0n);
  });
});

describe('Leasing invariants', () => {
  let org: OrganisationFixture;
  let unitId: string;
  let residentId: string;

  beforeAll(async () => {
    org = await createOrganisation('Lease Overlap Co');
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Overlap House', code: 'OVERLAP1', propertyType: 'house',
        addressLine1: '7 Overlap Way', city: 'Pretoria',
      }),
    );
    unitId = house.unitId;
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Overlap', lastName: 'Tester' }),
    );
    residentId = resident.residentId;
  });

  afterAll(async () => { await closeOwner(); });

  it('allows two DRAFTS on one unit but lets only one activation succeed', async () => {
    const draftA = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId, startDate: '2026-06-01', endDate: '2027-05-31', rentMinor: R('7000'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    const draftB = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId, startDate: '2026-09-01', endDate: '2027-08-31', rentMinor: R('7500'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    // Drafts deliberately do not reserve the unit.
    expect(draftA.leaseId).not.toBe(draftB.leaseId);

    const activate = (leaseId: string, date: string) =>
      withActor({ authUserId: org.adminUserId, assuranceLevel: 'aal2' }, ({ tx }) =>
        activateLease(tx, org.organisationId, org.adminUserId, {
          leaseId, expectedVersion: 1, activationDate: date,
          executionExceptionReason: 'Executed contract filed offline.',
        }),
      );

    const results = await Promise.allSettled([
      activate(draftA.leaseId, '2026-06-01'),
      activate(draftB.leaseId, '2026-09-01'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: 'conflict' });
  });

  it('keeps arrears and holdover occupancy after a lease expires', async () => {
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Holdover House', code: 'HOLD1', propertyType: 'cottage',
        addressLine1: '9 Holdover Street', city: 'Pretoria',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-06-30', rentMinor: R('6000'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Executed contract filed offline.',
      }),
    );
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, documentType: 'rent_invoice', issueDate: '2026-06-01', dueDate: '2026-06-01',
        lines: [{ category: 'rent', description: 'June rent', amountMinor: R('6000'), dueDate: '2026-06-01' }],
      }),
    );

    const { expireLease } = await import('@propertyos/domain');
    await as(org.adminUserId, (tx) =>
      expireLease(tx, org.organisationId, org.adminUserId, { leaseId: lease.leaseId, holdover: true }),
    );

    const statement = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId: lease.leaseId, cutOff: '2026-08-31' }),
    );
    // Closing a lease does not erase arrears.
    expect(statement.closingReceivableMinor).toBe(R('6000'));

    const [occupancy] = await ownerSql()<{ is_holdover: boolean }[]>`
      select is_holdover from occupancy_intervals where lease_id = ${lease.leaseId}
    `;
    expect(occupancy!.is_holdover).toBe(true);
  });

  it('rejects a stale lease activation using the version guard', async () => {
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Version House', code: 'VER1', propertyType: 'house',
        addressLine1: '11 Version Road', city: 'Pretoria',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', rentMinor: R('5000'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        activateLease(tx, org.organisationId, org.adminUserId, {
          leaseId: lease.leaseId, expectedVersion: 99, activationDate: '2026-01-01',
          executionExceptionReason: 'Executed contract filed offline.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'stale_version' });
  });
});
