/**
 * The month's utilities, typed before anything is billed.
 *
 * The product made a landlord bill water one lease at a time: open the lease,
 * type the readings, post. Forty tenancies was forty visits, and each posting
 * produced its OWN invoice — so a tenant with water, sewerage and refuse got
 * three documents a month, none correctable afterwards, because a posted
 * charge document is immutable by trigger.
 *
 * What these tests pin:
 *
 *   1. a captured charge is a DRAFT — nothing in the ledger, nothing on a
 *      statement, no invoice, until a run posts it;
 *   2. the arithmetic is checked where it cannot be argued with: a meter that
 *      goes backwards and an amount that disagrees with quantity × rate are
 *      both refused;
 *   3. typing water twice for the same month corrects it rather than charging
 *      twice — the uniqueness is in the schema, not in the caller;
 *   4. a run groups a lease's captured lines into ONE invoice and leaves rent
 *      on its own, and the ledger still balances;
 *   5. a captured charge that has been billed cannot be edited or deleted,
 *      even on the privileged connection, because the invoice is the record;
 *   6. and posting twice does not bill twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, assertBookBalances, captureCharge, createResident, createStandaloneHouse,
  discardCapturedCharge, draftLease, leasesToCapture, parseMajorToMinor, pendingCharges,
  postBillingRun, previewBillingRun, saveBillingPreview,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');
const PERIOD = '2026-04-01';

describe('Capturing a month before billing it', () => {
  let org: OrganisationFixture;
  let leaseId: string;

  beforeAll(async () => {
    org = await createOrganisation('Capture Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Metered', lastName: 'Tenant',
      }));
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Capture House', code: 'CAP1', propertyType: 'house',
        addressLine1: '4 Capture Road', city: 'Cape Town',
      }));
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('9000'), billingDay: 1,
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }));
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Executed contract filed offline.',
      }));
  });

  afterAll(async () => { await closeOwner(); });

  it('lists the leases a month should be captured against', async () => {
    const rows = await as(org.adminUserId, (tx) =>
      leasesToCapture(tx, org.organisationId, { periodStart: PERIOD }));
    const mine = rows.find((r) => r.leaseId === leaseId);
    expect(mine).toBeDefined();
    // The thing that makes the screen usable: who lives there, and what the
    // meter said last time.
    expect(mine!.residentName).toContain('Metered');
    expect(mine!.unitLabel).toContain('Capture House');
  });

  it('works the amount out from the meter, and refuses arithmetic that disagrees', async () => {
    const captured = await as(org.adminUserId, (tx) =>
      captureCharge(tx, org.organisationId, org.adminUserId, {
        periodStart: PERIOD, leaseId, category: 'utility_water',
        meterPrevious: 1420, meterCurrent: 1461, unitRateMinor: 2730n, unit: 'kl',
      }));
    // 41 kl at R27.30 = R1,119.30, worked out rather than typed.
    expect(captured.amountMinor).toBe(111_930n);

    // A meter that goes backwards is a typo or a replaced meter, and neither
    // is a bill.
    await expect(as(org.adminUserId, (tx) =>
      captureCharge(tx, org.organisationId, org.adminUserId, {
        periodStart: PERIOD, leaseId, category: 'utility_gas',
        meterPrevious: 900, meterCurrent: 880, unitRateMinor: 100n,
      }))).rejects.toMatchObject({ code: 'validation_failed' });

    // And an amount that does not match the arithmetic beside it: an invoice
    // whose lines do not add up to their own total is what a tenant queries.
    await expect(as(org.adminUserId, (tx) =>
      captureCharge(tx, org.organisationId, org.adminUserId, {
        periodStart: PERIOD, leaseId, category: 'utility_electricity',
        quantity: 100, unitRateMinor: 250n, amountMinor: 30_000n,
      }))).rejects.toMatchObject({ code: 'validation_failed' });

    // Rent is the lease's business, not a monthly capture's.
    await expect(as(org.adminUserId, (tx) =>
      captureCharge(tx, org.organisationId, org.adminUserId, {
        periodStart: PERIOD, leaseId, category: 'rent', amountMinor: 100n,
      }))).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('corrects rather than charges twice when the same thing is typed again', async () => {
    await as(org.adminUserId, (tx) =>
      captureCharge(tx, org.organisationId, org.adminUserId, {
        periodStart: PERIOD, leaseId, category: 'utility_water',
        meterPrevious: 1420, meterCurrent: 1465, unitRateMinor: 2730n, unit: 'kl',
      }));

    const rows = await as(org.adminUserId, (tx) =>
      pendingCharges(tx, org.organisationId, { periodStart: PERIOD }));
    const water = rows.filter((r) => r.category === 'utility_water' && r.leaseId === leaseId);
    expect(water).toHaveLength(1);
    expect(water[0]!.amountMinor).toBe(122_850); // 45 kl, the corrected reading
  });

  it('is a draft: nothing is in the ledger until a run posts it', async () => {
    const [charged] = await ownerSql()<{ n: string }[]>`
      select count(*)::text as n from charge_lines
       where lease_id = ${leaseId}::uuid and category like 'utility_%'
    `;
    expect(Number(charged?.n)).toBe(0);

    // And a draft can be thrown away.
    const discardable = await as(org.adminUserId, (tx) =>
      captureCharge(tx, org.organisationId, org.adminUserId, {
        periodStart: PERIOD, leaseId, category: 'utility_refuse', amountMinor: 18_000n,
      }));
    await as(org.adminUserId, (tx) =>
      discardCapturedCharge(tx, org.organisationId, org.adminUserId, discardable.id));
    const after = await as(org.adminUserId, (tx) =>
      pendingCharges(tx, org.organisationId, { periodStart: PERIOD }));
    expect(after.some((r) => r.id === discardable.id)).toBe(false);
  });

  it('bills a month in one run: one utility invoice, rent on its own', async () => {
    // Two more charges, so the grouping is worth asserting.
    await as(org.adminUserId, (tx) =>
      captureCharge(tx, org.organisationId, org.adminUserId, {
        periodStart: PERIOD, leaseId, category: 'utility_sewerage',
        quantity: 36, unitRateMinor: 1_850n, unit: 'kl',
      }));
    await as(org.adminUserId, (tx) =>
      captureCharge(tx, org.organisationId, org.adminUserId, {
        periodStart: PERIOD, leaseId, category: 'utility_refuse', amountMinor: 21_500n,
      }));

    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: PERIOD }));

    // The preview is the WHOLE month: rent from the schedule, utilities from
    // what somebody typed.
    expect(preview.captured).toHaveLength(3);
    expect(preview.capturedTotalMinor).toBe(122_850n + 66_600n + 21_500n);
    expect(preview.totalMinor).toBe(R('9000') + preview.capturedTotalMinor);

    const { runId, previewVersion } = await as(org.adminUserId, (tx) =>
      saveBillingPreview(tx, org.organisationId, org.adminUserId, preview));
    const posted = await as(org.adminUserId, (tx) =>
      postBillingRun(tx, org.organisationId, org.adminUserId, {
        runId, previewVersion, idempotencyKey: `capture-${runId}`, issueDate: PERIOD,
      }));
    expect(posted.totalMinor).toBe(preview.totalMinor);

    const documents = await ownerSql()<{
      id: string; document_type: string; total_minor: string; lines: number;
    }[]>`
      select d.id::text, d.document_type::text, d.total_minor::text,
             (select count(*) from charge_lines cl where cl.document_id = d.id)::int as lines
        from charge_documents d
       where d.lease_id = ${leaseId}::uuid and d.billing_run_id = ${runId}::uuid
       order by d.document_type
    `;
    // Two documents, not four: rent, and one invoice carrying all three
    // utilities.
    expect(documents).toHaveLength(2);
    const utilities = documents.find((d) => d.document_type === 'utility_invoice')!;
    expect(utilities.lines).toBe(3);
    expect(Number(utilities.total_minor)).toBe(Number(preview.capturedTotalMinor));
    expect(documents.find((d) => d.document_type === 'rent_invoice')!.lines).toBe(1);

    // The arithmetic is on the line, so a tenant can check it.
    const [waterLine] = await ownerSql()<{ description: string }[]>`
      select description from charge_lines
       where document_id = ${utilities.id}::uuid and category = 'utility_water'
    `;
    expect(waterLine?.description).toContain('45 kl');

    // And the books still balance, which is the only real test of a posting.
    await expect(as(org.adminUserId, (tx) =>
      assertBookBalances(tx, org.organisationId))).resolves.not.toThrow();
  });

  it('will not bill the same capture twice', async () => {
    // The captured rows are history now, pointing at the document they became.
    const rows = await as(org.adminUserId, (tx) =>
      pendingCharges(tx, org.organisationId, { periodStart: PERIOD, includePosted: true }));
    expect(rows.every((r) => r.postedAt !== null)).toBe(true);
    expect(rows.every((r) => r.chargeDocumentId !== null)).toBe(true);

    // A second run for the same month finds nothing left to bill.
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: PERIOD }));
    expect(preview.captured).toHaveLength(0);
    expect(preview.capturedTotalMinor).toBe(0n);
  });

  it('will not let a billed capture be edited or deleted, even privileged', async () => {
    const [row] = await ownerSql()<{ id: string }[]>`
      select id::text from pending_charges
       where lease_id = ${leaseId}::uuid and posted_at is not null limit 1
    `;

    // Through the domain: a plain refusal with the reason.
    await expect(as(org.adminUserId, (tx) =>
      discardCapturedCharge(tx, org.organisationId, org.adminUserId, row!.id)))
      .rejects.toMatchObject({ code: 'validation_failed' });

    // And on the owner connection, where RLS does not reach: the trigger
    // holds, because "the invoice is the record" is not a UI rule.
    await expect(ownerSql()`
      update pending_charges set amount_minor = 1 where id = ${row!.id}::uuid
    `).rejects.toThrow(/cannot be changed/);
    await expect(ownerSql()`
      delete from pending_charges where id = ${row!.id}::uuid
    `).rejects.toThrow(/cannot be deleted/);
  });
});
