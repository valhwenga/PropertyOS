/**
 * Recurring billing: preview, validation, approved posting, proration, and the
 * duplicate protection that makes a crashed worker safe to retry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, createResident, createStandaloneHouse, draftLease,
  parseMajorToMinor, postBillingRun, previewBillingRun, saveBillingPreview,
  assertBookBalances, buildStatement,
} from '@propertyos/domain';
import { as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture } from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Monthly billing run', () => {
  let org: OrganisationFixture;
  let fullMonthLease: string;
  let midMonthLease: string;

  beforeAll(async () => {
    org = await createOrganisation('Billing Run Co');

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Billing', lastName: 'Resident' }),
    );

    // Lease 1: occupies the whole of March 2026.
    const houseA = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Full Month House', code: 'BILL1', propertyType: 'house',
        addressLine1: '1 Billing Road', city: 'Cape Town',
      }),
    );
    const leaseA = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: houseA.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('8000'), billingDay: 1,
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    fullMonthLease = leaseA.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: fullMonthLease, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Executed contract filed offline.',
      }),
    );

    // Lease 2: moves in on 16 March 2026 — a partial first period.
    const houseB = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Mid Month House', code: 'BILL2', propertyType: 'cottage',
        addressLine1: '2 Billing Road', city: 'Cape Town',
      }),
    );
    const leaseB = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: houseB.unitId, startDate: '2026-03-16', endDate: '2027-03-15',
        rentMinor: R('8000'), billingDay: 1,
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    midMonthLease = leaseB.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: midMonthLease, expectedVersion: 1, activationDate: '2026-03-16',
        executionExceptionReason: 'Executed contract filed offline.',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('previews the period without posting anything', async () => {
    const before = await ownerSql()<{ count: string }[]>`
      select count(*)::text from charge_documents where organisation_id = ${org.organisationId}
    `;
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2026-03-01' }),
    );
    const after = await ownerSql()<{ count: string }[]>`
      select count(*)::text from charge_documents where organisation_id = ${org.organisationId}
    `;

    expect(after[0]!.count).toBe(before[0]!.count);
    expect(preview.periodEnd).toBe('2026-03-31');
    expect(preview.lines).toHaveLength(2);
  });

  it('prorates a mid-month move in by actual occupied days and shows the arithmetic', async () => {
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2026-03-01' }),
    );
    const partial = preview.lines.find((l) => l.leaseId === midMonthLease)!;
    const full = preview.lines.find((l) => l.leaseId === fullMonthLease)!;

    // 16 to 31 March inclusive = 16 days of 31.
    expect(partial.prorated).toBe(true);
    expect(partial.prorationNumerator).toBe(16);
    expect(partial.prorationDenominator).toBe(31);
    expect(partial.amountMinor).toBe(R('4129.03'));
    expect(partial.fullAmountMinor).toBe(R('8000'));

    expect(full.prorated).toBe(false);
    expect(full.amountMinor).toBe(R('8000'));

    expect(preview.totalMinor).toBe(R('8000') + R('4129.03'));
  });

  it('posts the approved run and records the proration evidence on the charge line', async () => {
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2026-03-01' }),
    );
    const saved = await as(org.adminUserId, (tx) =>
      saveBillingPreview(tx, org.organisationId, org.adminUserId, preview),
    );
    const result = await as(org.adminUserId, (tx) =>
      postBillingRun(tx, org.organisationId, org.adminUserId, {
        runId: saved.runId,
        previewVersion: saved.previewVersion,
        idempotencyKey: 'march-2026-run-1',
        issueDate: '2026-03-01',
      }),
    );
    expect(result.postedCount).toBe(2);
    expect(result.totalMinor).toBe(R('12129.03'));

    const [line] = await ownerSql()<
      { proration_numerator: number; proration_denominator: number; full_period_amount_minor: string; amount_minor: string }[]
    >`
      select proration_numerator, proration_denominator,
             full_period_amount_minor::text, amount_minor::text
      from charge_lines where lease_id = ${midMonthLease} and prorated
    `;
    expect(line).toMatchObject({
      proration_numerator: 16,
      proration_denominator: 31,
      full_period_amount_minor: '800000',
      amount_minor: '412903',
    });

    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('produces no duplicate charges when the same period is run again', async () => {
    const before = await ownerSql()<{ count: string; total: string }[]>`
      select count(*)::text, coalesce(sum(total_minor), 0)::text as total
      from charge_documents
      where organisation_id = ${org.organisationId} and period_start = '2026-03-01'
    `;

    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2026-03-01' }),
    );
    // Every line is now reported as already billed.
    expect(preview.billableLineCount).toBe(0);
    expect(preview.skippedLineCount).toBe(2);
    expect(preview.exceptions.filter((e) => e.code === 'already_billed')).toHaveLength(2);

    const saved = await as(org.adminUserId, (tx) =>
      saveBillingPreview(tx, org.organisationId, org.adminUserId, preview),
    );
    const result = await as(org.adminUserId, (tx) =>
      postBillingRun(tx, org.organisationId, org.adminUserId, {
        runId: saved.runId, previewVersion: saved.previewVersion,
        idempotencyKey: 'march-2026-run-2', issueDate: '2026-03-01',
      }),
    );
    expect(result.postedCount).toBe(0);

    const after = await ownerSql()<{ count: string; total: string }[]>`
      select count(*)::text, coalesce(sum(total_minor), 0)::text as total
      from charge_documents
      where organisation_id = ${org.organisationId} and period_start = '2026-03-01'
    `;
    // Byte for byte identical: one charge per schedule and period.
    expect(after[0]).toEqual(before[0]);
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('refuses to post a run whose preview version is stale', async () => {
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2026-04-01' }),
    );
    const saved = await as(org.adminUserId, (tx) =>
      saveBillingPreview(tx, org.organisationId, org.adminUserId, preview),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        postBillingRun(tx, org.organisationId, org.adminUserId, {
          runId: saved.runId, previewVersion: saved.previewVersion + 5,
          idempotencyKey: 'april-stale', issueDate: '2026-04-01',
        }),
      ),
    ).rejects.toMatchObject({ code: 'stale_version' });
  });

  it('raises a blocking exception for an active lease with no rent schedule', async () => {
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'No', lastName: 'Schedule' }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'No Schedule House', code: 'BILL3', propertyType: 'house',
        addressLine1: '3 Billing Road', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-05-01', rentMinor: R('5000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-05-01',
        executionExceptionReason: 'Executed contract filed offline.',
        createRentSchedule: false,
      }),
    );

    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2026-05-01' }),
    );
    const blocking = preview.exceptions.filter((e) => e.severity === 'blocking');
    expect(blocking.some((e) => e.code === 'missing_rent_schedule')).toBe(true);

    const saved = await as(org.adminUserId, (tx) =>
      saveBillingPreview(tx, org.organisationId, org.adminUserId, preview),
    );
    // A run with blocking exceptions is never postable.
    await expect(
      as(org.adminUserId, (tx) =>
        postBillingRun(tx, org.organisationId, org.adminUserId, {
          runId: saved.runId, previewVersion: saved.previewVersion,
          idempotencyKey: 'may-blocked', issueDate: '2026-05-01',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('shows the prorated line on the resident statement with its day fraction', async () => {
    const statement = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId: midMonthLease, cutOff: '2026-03-31' }),
    );
    expect(statement.closingReceivableMinor).toBe(R('4129.03'));
    expect(statement.lines[0]!.description).toContain('16/31 days');
  });
});
