/**
 * Narrowing a report, and saying so.
 *
 * Every report writes its filters into the file it exports, so the filters it
 * records and the filters it applied have to be the same thing. Three of them
 * accepted no property filter at all while the screen offered none either, and
 * two recorded `filters: {}` while quietly applying a 180-day horizon — a file
 * of five leases that does not say whether that is five this month or five
 * this year.
 *
 * The other half of the rule is the opposite one: a report that cannot answer
 * a question must not accept it. `arrearsAgeing` is computed against the
 * records as they stand, so it is never offered an "as at" date, and journal
 * lines are never narrowed by property because a receipt into the bank account
 * belongs to no single property and the extract would stop balancing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, createResident, createStandaloneHouse, depositRegister, draftLease,
  journalLinesExport, leaseExpiryReport, occupancyReport, parseMajorToMinor,
  recordDepositReceipt, rentRoll,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Report filters', () => {
  let org: OrganisationFixture;
  let propertyA: string;
  let propertyB: string;

  beforeAll(async () => {
    org = await createOrganisation('Filtered Reports Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Filter', lastName: 'Resident',
      }),
    );

    const make = async (name: string, code: string, end: string, start: string) => {
      const house = await as(org.adminUserId, (tx) =>
        createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
          name, code, propertyType: 'house',
          addressLine1: `${code} Filter Road`, city: 'Cape Town',
        }),
      );
      const lease = await as(org.adminUserId, (tx) =>
        draftLease(tx, org.organisationId, org.adminUserId, {
          unitId: house.unitId, startDate: start, endDate: end, rentMinor: R('7000'),
          parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
        }),
      );
      await as(org.adminUserId, (tx) =>
        activateLease(tx, org.organisationId, org.adminUserId, {
          leaseId: lease.leaseId, expectedVersion: 1, activationDate: start,
          executionExceptionReason: 'Contract filed offline.',
        }),
      );
      return { propertyId: house.propertyId, leaseId: lease.leaseId };
    };

    // One lease running all year, one that started in July: the second is the
    // one an "as at" date in the first half of the year must not show.
    const a = await make('Filter House A', 'FA', '2027-12-31', '2026-01-01');
    const b = await make('Filter House B', 'FB', '2027-06-30', '2026-07-01');
    propertyA = a.propertyId;
    propertyB = b.propertyId;

    // A deposit on A only.
    await as(org.adminUserId, (tx) =>
      recordDepositReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId: a.leaseId, amountMinor: R('7000'), receivedOn: '2026-01-01',
        holder: 'landlord', description: 'Deposit on signing',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('narrows the deposit register to the chosen property, and records it', async () => {
    const all = await as(org.adminUserId, (tx) => depositRegister(tx, org.organisationId));
    expect(all.rows).toHaveLength(1);

    const onlyB = await as(org.adminUserId, (tx) =>
      depositRegister(tx, org.organisationId, { propertyIds: [propertyB] }));
    expect(onlyB.rows).toHaveLength(0);
    expect(onlyB.totalHeldMinor).toBe(0n);
    // The file must say it was narrowed, or the zero reads as "no deposits".
    expect(onlyB.meta.filters.propertyIds).toEqual([propertyB]);
  });

  it('records the lease-expiry horizon it actually used', async () => {
    const near = await as(org.adminUserId, (tx) =>
      leaseExpiryReport(tx, org.organisationId, { withinDays: 30 }));
    const far = await as(org.adminUserId, (tx) =>
      leaseExpiryReport(tx, org.organisationId, { withinDays: 365 * 3 }));

    expect(far.rows.length).toBeGreaterThan(near.rows.length);
    expect(near.meta.filters.withinDays).toBe(30);
    expect(far.meta.filters.withinDays).toBe(365 * 3);
  });

  it('narrows lease expiry by property', async () => {
    const onlyA = await as(org.adminUserId, (tx) =>
      leaseExpiryReport(tx, org.organisationId, {
        withinDays: 365 * 3, propertyIds: [propertyA],
      }));
    expect(onlyA.rows).toHaveLength(1);
    expect(onlyA.rows[0]!.unitLabel).toContain('Filter House A');
  });

  it('counts unit days for the chosen property only', async () => {
    const period = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
    const both = await as(org.adminUserId, (tx) =>
      occupancyReport(tx, org.organisationId, period));
    const onlyA = await as(org.adminUserId, (tx) =>
      occupancyReport(tx, org.organisationId, { ...period, propertyIds: [propertyA] }));

    expect(both.availableUnitDays).toBe(60);
    expect(onlyA.availableUnitDays).toBe(30);
    // Narrowing must move the numerator too, not just the denominator.
    expect(onlyA.occupiedUnitDays).toBeLessThan(both.occupiedUnitDays);
    expect(onlyA.meta.filters.propertyIds).toEqual([propertyA]);
  });

  it('honours an as-at date on the rent roll', async () => {
    const june = await as(org.adminUserId, (tx) =>
      rentRoll(tx, org.organisationId, { asAt: '2026-06-15' }));
    const august = await as(org.adminUserId, (tx) =>
      rentRoll(tx, org.organisationId, { asAt: '2026-08-15' }));

    const occupiedIn = (r: typeof june) => r.rows.filter((row) => row.occupied).length;
    // B's lease starts in July, so it is let in August and not in June. A rent
    // roll that ignored the date would report the same figure for both.
    expect(occupiedIn(august)).toBeGreaterThan(occupiedIn(june));
    expect(june.meta.filters.asAt).toBe('2026-06-15');
  });

  it('keeps the journal extract whole', async () => {
    const extract = await as(org.adminUserId, (tx) =>
      journalLinesExport(tx, org.organisationId, {
        periodStart: '2026-01-01', periodEnd: '2026-12-31',
      }));
    expect(extract.balanced).toBe(true);
    // The reason it is never property-filtered is on the face of the report.
    expect(extract.meta.qualifications.join(' ')).toContain('does not balance');
  });
});
