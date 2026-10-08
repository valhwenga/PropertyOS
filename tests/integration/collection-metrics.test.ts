/**
 * Collection measurement, against a fixture built to tell the measures apart.
 *
 * The defect this suite exists for: the overview divided allocations against
 * ALL charges by RENT billed alone, so a resident settling their water bill
 * raised "rent collected" without raising rent billed. On the demo data that
 * read 93.75% where the truth was 80.21%. The guarding test passed because its
 * fixture contained nothing but rent, so both definitions agreed.
 *
 * Every fixture below therefore contains, deliberately:
 *   - rent AND a utility charge, so a rent-only measure differs from a total;
 *   - an opening arrear from an earlier period, so "collected" cannot simply be
 *     "money that arrived";
 *   - a partial allocation, so collection is not all-or-nothing;
 *   - a credit note issued in a LATER month than the charge it corrects;
 *   - an allocation that is later reversed.
 *
 * The acceptance arithmetic the product is held to is the one in the blueprint:
 * R1,000 arrears + R8,000 rent + R350 water - R7,500 receipt = R1,850.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, allocateReceipt, collectionByLease, collectionReport,
  collectionTotals, confirmReceipt, createResident, createStandaloneHouse,
  draftLease, issueCreditNote, parseMajorToMinor,
  postCharge, reverseAllocation,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');
const JAN = { periodStart: '2026-01-01', periodEnd: '2026-01-31' };
const DEC = { periodStart: '2025-12-01', periodEnd: '2025-12-31' };
const FEB = { periodStart: '2026-02-01', periodEnd: '2026-02-28' };

/** A lease with one unit, activated and ready to bill. */
async function leaseFor(org: OrganisationFixture, code: string, rent: string): Promise<string> {
  const resident = await as(org.adminUserId, (tx) =>
    createResident(tx, org.organisationId, org.adminUserId, {
      firstName: 'Collection', lastName: code,
    }),
  );
  const house = await as(org.adminUserId, (tx) =>
    createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
      name: `Collection ${code}`, code, propertyType: 'house',
      addressLine1: '1 Collection Close', city: 'Johannesburg',
    }),
  );
  const lease = await as(org.adminUserId, (tx) =>
    draftLease(tx, org.organisationId, org.adminUserId, {
      unitId: house.unitId, startDate: '2025-12-01', endDate: '2026-12-31',
      rentMinor: R(rent),
      parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
    }),
  );
  await as(org.adminUserId, (tx) =>
    activateLease(tx, org.organisationId, org.adminUserId, {
      leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2025-12-01',
      executionExceptionReason: 'Contract filed offline.',
    }),
  );
  return lease.leaseId;
}

/** The charge line ids on a posted document, in line order. */
async function linesOf(documentId: string): Promise<{ id: string; category: string }[]> {
  return ownerSql()<{ id: string; category: string }[]>`
    select id, category from charge_lines where document_id = ${documentId} order by line_number
  `;
}

describe('Collection: rent and total are different measures', () => {
  let org: OrganisationFixture;
  let leaseId: string;

  beforeAll(async () => {
    org = await createOrganisation('Collection Co');
    leaseId = await leaseFor(org, 'COLA', '8000');

    // December: an opening arrear of R1,000, billed for December.
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'opening_balance',
        issueDate: '2025-12-01', dueDate: '2025-12-01',
        periodStart: DEC.periodStart, periodEnd: DEC.periodEnd,
        lines: [{
          category: 'other', description: 'Opening arrears',
          amountMinor: R('1000'), dueDate: '2025-12-01',
        }],
      }),
    );

    // January: R8,000 rent and R350 water, billed for January.
    const january = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        periodStart: JAN.periodStart, periodEnd: JAN.periodEnd,
        lines: [
          { category: 'rent', description: 'January rent', amountMinor: R('8000'), dueDate: '2026-01-01' },
          { category: 'utility_water', description: 'Water', amountMinor: R('350'), dueDate: '2026-01-07' },
        ],
      }),
    );
    const [open] = await linesOf(
      (await ownerSql()<{ id: string }[]>`
        select id from charge_documents
        where lease_id = ${leaseId} and document_type = 'opening_balance'
      `)[0]!.id,
    );
    const [rentLine, waterLine] = await linesOf(january.documentId);

    // One R7,500 receipt, split three ways: the old arrear in full, the water
    // in full, and the rest against rent — which therefore stays part-paid.
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('7500'), receivedOn: '2026-01-20',
      }),
    );
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, postingDate: '2026-01-20', policy: 'manual',
        allocations: [
          { chargeLineId: open!.id, amountMinor: R('1000') },
          { chargeLineId: waterLine!.id, amountMinor: R('350') },
          { chargeLineId: rentLine!.id, amountMinor: R('6150') },
        ],
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('reaches the acceptance balance of R1,850', async () => {
    const [row] = await ownerSql()<{ outstanding: string }[]>`
      select coalesce(sum(outstanding_minor), 0)::text as outstanding
      from charge_line_balances
      where organisation_id = ${org.organisationId} and outstanding_minor > 0
    `;
    expect(BigInt(row!.outstanding)).toBe(R('1850'));
  });

  it('does not credit the water payment to rent', async () => {
    // The whole defect in one assertion. Under the old query rent collected was
    // R6,500 — rent plus water — against R8,000 of rent billed, reading 81.25%.
    const t = await as(org.adminUserId, (tx) => collectionTotals(tx, org.organisationId, JAN));
    expect(t.rent.billedMinor).toBe(R('8000'));
    expect(t.rent.collectedMinor).toBe(R('6150'));
    // 6,150 / 8,000 = 76.875%, truncated down. Never rounded up: a collection
    // rate overstated by a hundredth is still an overstatement.
    expect(t.rent.ratePercent).toBe(76.87);
  });

  it('reports the all-category measure separately, and higher', async () => {
    const t = await as(org.adminUserId, (tx) => collectionTotals(tx, org.organisationId, JAN));
    expect(t.total.billedMinor).toBe(R('8350'));
    expect(t.total.collectedMinor).toBe(R('6500'));
    expect(t.total.ratePercent).toBe(77.84);
    expect(t.total.ratePercent!).toBeGreaterThan(t.rent.ratePercent!);
  });

  it('separates cash banked in the period from collection against it', async () => {
    const t = await as(org.adminUserId, (tx) => collectionTotals(tx, org.organisationId, JAN));
    // R7,500 arrived in January. Only R6,500 of it paid January's charges; the
    // other R1,000 cleared December. Adding them would double-count the month.
    expect(t.receiptsBankedMinor).toBe(R('7500'));
    expect(t.priorPeriodCollectedMinor).toBe(R('1000'));
    expect(t.receiptsBankedMinor).toBe(t.total.collectedMinor + t.priorPeriodCollectedMinor);
  });

  it('attributes the arrear to December, not to the month it was paid', async () => {
    // Stated as at 31 December, December looks unpaid — on that date it was.
    const atYearEnd = await as(org.adminUserId, (tx) =>
      collectionTotals(tx, org.organisationId, { ...DEC, asOf: DEC.periodEnd }),
    );
    expect(atYearEnd.total.billedMinor).toBe(R('1000'));
    expect(atYearEnd.total.collectedMinor).toBe(0n);

    // Stated later, the January payment has settled the December charge. The
    // charge never moves month; only the collection against it appears.
    const atJanuaryEnd = await as(org.adminUserId, (tx) =>
      collectionTotals(tx, org.organisationId, { ...DEC, asOf: '2026-01-31' }),
    );
    expect(atJanuaryEnd.total.billedMinor).toBe(R('1000'));
    expect(atJanuaryEnd.total.collectedMinor).toBe(R('1000'));
    expect(atJanuaryEnd.total.ratePercent).toBe(100);
  });

  it('returns null rather than a rate for a period with nothing billed', async () => {
    const feb = await as(org.adminUserId, (tx) => collectionTotals(tx, org.organisationId, FEB));
    expect(feb.total.billedMinor).toBe(0n);
    expect(feb.total.ratePercent).toBeNull();
    expect(feb.rent.ratePercent).toBeNull();
  });

  it('counts nothing before the charges were posted', async () => {
    // The same period, stated as at an earlier instant. A closed month must not
    // change its answer because the report was run again later.
    const early = await as(org.adminUserId, (tx) =>
      collectionTotals(tx, org.organisationId, { ...JAN, asOf: '2026-01-10' }),
    );
    expect(early.total.billedMinor).toBe(R('8350'));
    expect(early.total.collectedMinor).toBe(0n); // allocated on the 20th
  });

  it('sums its rows to its totals, for both measures', async () => {
    const [t, rows] = await as(org.adminUserId, async (tx) => [
      await collectionTotals(tx, org.organisationId, JAN),
      await collectionByLease(tx, org.organisationId, JAN),
    ] as const);
    const sum = (f: (r: (typeof rows)[number]) => bigint) => rows.reduce((s, r) => s + f(r), 0n);
    expect(sum((r) => r.rent.billedMinor)).toBe(t.rent.billedMinor);
    expect(sum((r) => r.rent.collectedMinor)).toBe(t.rent.collectedMinor);
    expect(sum((r) => r.total.billedMinor)).toBe(t.total.billedMinor);
    expect(sum((r) => r.total.collectedMinor)).toBe(t.total.collectedMinor);
  });

  it('gives the report and the overview the same answer', async () => {
    // These are two screens. They must not be able to disagree, which is only
    // true while they read the same function.
    const [report, totals] = await as(org.adminUserId, async (tx) => [
      await collectionReport(tx, org.organisationId, JAN),
      await collectionTotals(tx, org.organisationId, JAN),
    ] as const);
    expect(report.totals.rent.collectedMinor).toBe(totals.rent.collectedMinor);
    expect(report.totals.rent.ratePercent).toBe(totals.rent.ratePercent);
    expect(report.totalBilledMinor).toBe(totals.total.billedMinor);
  });
});

describe('Collection: corrections and reversals', () => {
  let org: OrganisationFixture;
  let creditLease: string;
  let reversalLease: string;
  let reversedAllocationId: string;

  beforeAll(async () => {
    org = await createOrganisation('Correction Co');

    /* A January rent charge, credited in February. */
    creditLease = await leaseFor(org, 'CORA', '8000');
    const january = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId: creditLease, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        periodStart: JAN.periodStart, periodEnd: JAN.periodEnd,
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('8000'), dueDate: '2026-01-01' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      issueCreditNote(tx, org.organisationId, org.adminUserId, {
        documentId: january.documentId, issueDate: '2026-02-05',
        reason: 'Agreed rebate for the period the geyser was out of service.',
        lines: [{ category: 'rent', description: 'Geyser rebate', amountMinor: R('500') }],
      }),
    );

    /* A separate lease whose allocation is reversed. */
    reversalLease = await leaseFor(org, 'CORB', '5000');
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId: reversalLease, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        periodStart: JAN.periodStart, periodEnd: JAN.periodEnd,
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('5000'), dueDate: '2026-01-01' }],
      }),
    );
    const [line] = await linesOf(charge.documentId);
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId: reversalLease, amountMinor: R('5000'), receivedOn: '2026-01-10',
      }),
    );
    const allocated = await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, postingDate: '2026-01-10', policy: 'manual',
        allocations: [{ chargeLineId: line!.id, amountMinor: R('5000') }],
      }),
    );
    reversedAllocationId = allocated.allocationIds[0]!;
  });

  afterAll(async () => { await closeOwner(); });

  it('counts a credit against the month it corrects, not the month it was issued', async () => {
    const [atJanuaryEnd, atFebruaryEnd, february] = await as(org.adminUserId, async (tx) => [
      await collectionTotals(tx, org.organisationId, { ...JAN, asOf: JAN.periodEnd }),
      await collectionTotals(tx, org.organisationId, { ...JAN, asOf: '2026-02-28' }),
      await collectionTotals(tx, org.organisationId, FEB),
    ] as const);

    // As at 31 January the rebate had not been granted, so January reads at its
    // full R8,000 (plus the second lease's R5,000). A cut-off is a cut-off.
    expect(atJanuaryEnd.rent.billedMinor).toBe(R('8000') + R('5000'));

    // Once the credit is issued it reduces JANUARY, the month it corrects.
    expect(atFebruaryEnd.rent.billedMinor).toBe(R('7500') + R('5000'));

    // And February itself was never billed anything. Under an issue-date rule
    // it would read as minus R500 and show a nonsensical collection rate.
    expect(february.rent.billedMinor).toBe(0n);
    expect(february.rent.ratePercent).toBeNull();
  });

  it('removes a reversed allocation from collection', async () => {
    const before = await as(org.adminUserId, (tx) =>
      collectionTotals(tx, org.organisationId, { ...JAN, asOf: JAN.periodEnd }),
    );
    expect(before.rent.collectedMinor).toBe(R('5000'));

    await as(org.adminUserId, (tx) =>
      reverseAllocation(tx, org.organisationId, org.adminUserId, {
        allocationId: reversedAllocationId, postingDate: '2026-03-01',
        reason: 'Applied to the wrong lease; re-allocating.',
      }),
    );

    // The reversal is dated 1 March, so January stated as at 31 March no longer
    // counts it. The money is still real: it returns to unapplied credit rather
    // than vanishing, which is the difference between a reversal and a deletion.
    const after = await as(org.adminUserId, (tx) =>
      collectionTotals(tx, org.organisationId, { ...JAN, asOf: '2026-03-31' }),
    );
    expect(after.rent.collectedMinor).toBe(0n);
    expect(after.unappliedCreditMinor).toBe(R('5000'));
  });

  it('still shows the allocation as at a cut-off before its reversal', async () => {
    // Point-in-time truth. A February management pack must not silently change
    // because someone corrected an allocation in March.
    const asAtFebruary = await as(org.adminUserId, (tx) =>
      collectionTotals(tx, org.organisationId, { ...JAN, asOf: '2026-02-28' }),
    );
    expect(asAtFebruary.rent.collectedMinor).toBe(R('5000'));
  });
});
