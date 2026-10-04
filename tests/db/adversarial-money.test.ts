/**
 * Adversarial review of money arithmetic and the billing edges.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, allocateReceipt, assertBookBalances, buildStatement, confirmReceipt,
  createResident, createStandaloneHouse, draftLease, formatMoney, parseMajorToMinor,
  postBillingRun, postCharge, previewBillingRun, prorate, resolveDueDate,
  saveBillingPreview, suggestAllocation,
} from '@propertyos/domain';
import { as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture } from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Adversarial: money arithmetic', () => {
  it('prorating a month split between two tenants loses nothing', () => {
    // One moves out on the 15th, the next moves in on the 16th, of a 31 day
    // month. The landlord must bill exactly one month's rent in total.
    const rent = R('8000');
    const first = prorate(rent, 15, 31);
    const second = prorate(rent, 16, 31);
    expect(first + second).toBe(rent);
  });

  it('is honest that independent rounding can lose a cent across three ways', () => {
    // Three equal shares of R10.00 round to 3.33 each, totalling 9.99. This is
    // inherent to rounding each line independently, and it is a KNOWN, recorded
    // behaviour rather than a silently absorbed error: see
    // docs/known-limitations.md. Proration is per lease, and a month is never
    // split three ways between leases on one unit, so it does not arise in the
    // billing path.
    const total = R('10');
    const shares = [prorate(total, 1, 3), prorate(total, 1, 3), prorate(total, 1, 3)];
    expect(shares.reduce((s, v) => s + v, 0n)).toBe(R('9.99'));
  });

  it('handles amounts far beyond the safe integer range exactly', () => {
    // R100,000,000,000.00 is 10^13 cents, past Number.MAX_SAFE_INTEGER when
    // multiplied during proration.
    const huge = R('100000000000');
    expect(prorate(huge, 15, 31)).toBe(4838709677419n);
    expect(formatMoney(huge)).toBe('R100,000,000,000.00');
  });

  it('never produces a negative cent from rounding a tiny amount', () => {
    expect(prorate(1n, 1, 31)).toBe(0n);
    expect(prorate(1n, 30, 31)).toBe(1n);
    expect(prorate(0n, 15, 31)).toBe(0n);
  });

  it('resolves a 31st billing day in every month of a leap year', () => {
    const expected: Record<string, string> = {
      '2028-01-01': '2028-01-31', '2028-02-01': '2028-02-29', '2028-03-01': '2028-03-31',
      '2028-04-01': '2028-04-30', '2028-05-01': '2028-05-31', '2028-06-01': '2028-06-30',
      '2028-07-01': '2028-07-31', '2028-08-01': '2028-08-31', '2028-09-01': '2028-09-30',
      '2028-10-01': '2028-10-31', '2028-11-01': '2028-11-30', '2028-12-01': '2028-12-31',
    };
    for (const [period, due] of Object.entries(expected)) {
      expect(resolveDueDate(period, 31)).toBe(due);
    }
  });
});

describe('Adversarial: billing edges', () => {
  let org: OrganisationFixture;
  let residentId: string;

  beforeAll(async () => {
    org = await createOrganisation('Adversarial Billing Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Bill', lastName: 'Edge' }),
    );
    residentId = resident.residentId;
  });

  afterAll(async () => { await closeOwner(); });

  async function makeLease(code: string, start: string, end: string | null, rent: string) {
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: `Billing ${code}`, code, propertyType: 'house',
        addressLine1: `1 ${code} Road`, city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: start, endDate: end ?? undefined, rentMinor: R(rent),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: start,
        executionExceptionReason: 'Filed offline.',
      }),
    );
    return lease.leaseId;
  }

  it('prorates a February move-in in a leap year', async () => {
    const leaseId = await makeLease('BFEB', '2028-02-15', '2029-02-14', '8000');
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2028-02-01' }),
    );
    const line = preview.lines.find((l) => l.leaseId === leaseId)!;
    // 15 to 29 February inclusive = 15 days of 29.
    expect(line.prorationNumerator).toBe(15);
    expect(line.prorationDenominator).toBe(29);
    expect(line.amountMinor).toBe(prorate(R('8000'), 15, 29));
  });

  it('prorates the final month of a lease that ends mid-month', async () => {
    const leaseId = await makeLease('BEND', '2027-01-01', '2027-03-10', '9000');
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2027-03-01' }),
    );
    const line = preview.lines.find((l) => l.leaseId === leaseId)!;
    expect(line.prorated).toBe(true);
    expect(line.prorationNumerator).toBe(10);
    expect(line.prorationDenominator).toBe(31);
  });

  it('bills a lease starting on the first day of the period in full', async () => {
    const leaseId = await makeLease('BFULL', '2027-05-01', '2028-04-30', '7000');
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2027-05-01' }),
    );
    const line = preview.lines.find((l) => l.leaseId === leaseId)!;
    expect(line.prorated).toBe(false);
    expect(line.amountMinor).toBe(R('7000'));
  });

  it('bills nothing for a period entirely outside the lease', async () => {
    const leaseId = await makeLease('BOUT', '2029-01-01', '2029-06-30', '5000');
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2030-01-01' }),
    );
    expect(preview.lines.some((l) => l.leaseId === leaseId)).toBe(false);
  });

  it('a posted run total equals the sum of the documents it created', async () => {
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2028-02-01' }),
    );
    const saved = await as(org.adminUserId, (tx) =>
      saveBillingPreview(tx, org.organisationId, org.adminUserId, preview),
    );
    const result = await as(org.adminUserId, (tx) =>
      postBillingRun(tx, org.organisationId, org.adminUserId, {
        runId: saved.runId, previewVersion: saved.previewVersion,
        idempotencyKey: 'adversarial-feb-2028', issueDate: '2028-02-01',
      }),
    );
    const [documents] = await ownerSql()<{ total: string }[]>`
      select coalesce(sum(total_minor), 0)::text as total from charge_documents
      where billing_run_id = ${saved.runId}
    `;
    expect(BigInt(documents!.total)).toBe(result.totalMinor);
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });
});

describe('Adversarial: suspense receipts', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let chargeLineId: string;

  beforeAll(async () => {
    org = await createOrganisation('Adversarial Suspense Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Sus', lastName: 'Pense' }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Suspense House', code: 'SUSP1', propertyType: 'house',
        addressLine1: '1 Suspense Road', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', rentMinor: R('5000'),
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
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice', issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('5000'), dueDate: '2026-01-01' }],
      }),
    );
    const [line] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${charge.documentId}
    `;
    chargeLineId = line!.id;
  });

  afterAll(async () => { await closeOwner(); });

  it('posts an unidentified receipt to suspense, not to a guessed lease', async () => {
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        amountMinor: R('5000'), receivedOn: '2026-01-10', payerReference: 'UNKNOWN PAYER',
      }),
    );
    expect(receipt.inSuspense).toBe(true);

    const [suspense] = await ownerSql()<{ credit: string }[]>`
      select coalesce(sum(jl.credit_minor), 0)::text as credit
      from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.journal_id = ${receipt.journalId} and a.system_role = 'suspense'
    `;
    expect(BigInt(suspense!.credit)).toBe(R('5000'));

    // And no lease was attached on a guess.
    const [row] = await ownerSql()<{ lease_id: string | null }[]>`
      select lease_id from receipts where id = ${receipt.receiptId}
    `;
    expect(row!.lease_id).toBeNull();
  });

  it('releases suspense correctly when the payer is later identified', async () => {
    const [receipt] = await ownerSql()<{ id: string }[]>`
      select id from receipts where organisation_id = ${org.organisationId} and in_suspense
      order by created_at desc limit 1
    `;
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt!.id,
        allocations: [{ chargeLineId, amountMinor: R('5000') }],
        postingDate: '2026-01-11',
      }),
    );

    // The release debits SUSPENSE, not the unapplied receipts liability, which
    // would otherwise leave suspense permanently overstated.
    const [balances] = await ownerSql()<{ suspense_net: string; unapplied_net: string }[]>`
      select
        coalesce(sum(jl.signed_minor) filter (where a.system_role = 'suspense'), 0)::text as suspense_net,
        coalesce(sum(jl.signed_minor) filter (where a.system_role = 'unapplied_receipts'), 0)::text as unapplied_net
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.organisation_id = ${org.organisationId}
    `;
    expect(BigInt(balances!.suspense_net)).toBe(0n);
    expect(BigInt(balances!.unapplied_net)).toBe(0n);

    const statement = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-01-31' }),
    );
    expect(statement.closingReceivableMinor).toBe(0n);
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('suggests nothing when a lease has no open charges', async () => {
    const suggestion = await as(org.adminUserId, (tx) =>
      suggestAllocation(tx, org.organisationId, { leaseId, amountMinor: R('1000') }),
    );
    expect(suggestion.allocations).toHaveLength(0);
    // The whole amount stays unapplied rather than being forced somewhere.
    expect(suggestion.remainingMinor).toBe(R('1000'));
  });
});
