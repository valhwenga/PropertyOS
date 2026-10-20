/**
 * What a lease bills every month, and changing it.
 *
 * The defect behind this file: `charge_schedules` has been effective-dated
 * since the first migration, nothing ever wrote a second row, and the lease
 * agreement this product generates promises that the rent escalates on each
 * anniversary. So a lease with an 8% escalation went on billing the original
 * rent for its whole term — the product billing a figure that contradicts the
 * agreement it printed.
 *
 * What is proved here: a change closes the old row and opens a new one, the
 * billing run then raises the new amount and the old months still read as they
 * were billed, an escalation that is due is DETECTED with its arithmetic and
 * never applied on its own, and none of it touches a posted document.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, addChargeSchedule, changeChargeScheduleAmount, createResident,
  createStandaloneHouse, draftLease, escalationsDue, listChargeSchedules,
  parseMajorToMinor, postBillingRun, previewBillingRun, saveBillingPreview,
  stopChargeSchedule,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Charge schedules', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let unitId: string;

  beforeAll(async () => {
    org = await createOrganisation('Escalation Rentals');
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Escalation House', code: `ESC${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '7 Anniversary Avenue', city: 'Pretoria',
      }));
    unitId = house.unitId;
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Lerato', lastName: 'Mahlangu',
      }));
    // A two-year lease with the escalation the agreement would print.
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId, startDate: '2025-01-01', endDate: '2026-12-31',
        rentMinor: R('10000'), depositRequiredMinor: R('10000'),
        escalationPercent: 8, escalationMonthInterval: 12,
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }));
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2025-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }));
  });

  afterAll(async () => { await closeOwner(); });

  it('starts with the rent schedule activation wrote, and nothing else', async () => {
    const schedules = await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId));
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      category: 'rent', categoryLabel: 'Rent', amountMinor: R('10000'), current: true,
    });
  });

  it('adds a recurring charge that runs from a date, not from the lease start', async () => {
    await as(org.adminUserId, (tx) =>
      addChargeSchedule(tx, org.organisationId, org.adminUserId, {
        leaseId, category: 'parking', description: 'Parking bay 7',
        amountMinor: R('650'), startDate: '2025-06-01',
      }));

    const schedules = await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId));
    const parking = schedules.find((s) => s.category === 'parking');
    expect(parking).toMatchObject({ amountMinor: R('650'), startDate: '2025-06-01' });
    // Ends with the lease rather than outliving it.
    expect(parking?.endDate).toBe('2026-12-31');
  });

  it('refuses a second charge of the same kind over the same dates', async () => {
    await expect(as(org.adminUserId, (tx) =>
      addChargeSchedule(tx, org.organisationId, org.adminUserId, {
        leaseId, category: 'parking', description: 'A second bay, by mistake',
        amountMinor: R('650'), startDate: '2025-09-01',
      }))).rejects.toThrow(/already has a parking charge/i);
  });

  it('refuses a charge that runs outside its own lease', async () => {
    await expect(as(org.adminUserId, (tx) =>
      addChargeSchedule(tx, org.organisationId, org.adminUserId, {
        leaseId, category: 'levy', description: 'Too early',
        amountMinor: R('100'), startDate: '2024-01-01',
      }))).rejects.toThrow(/starts on/);
  });

  /* ------------------------------------------------------ changing an amount */

  it('changes an amount by closing one row and opening another', async () => {
    const before = await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId));
    const change = await as(org.adminUserId, (tx) =>
      changeChargeScheduleAmount(tx, org.organisationId, org.adminUserId, {
        scheduleId: before.find((s) => s.category === 'parking')!.id,
        amountMinor: R('720'),
        effectiveFrom: '2026-01-01',
        reason: 'Parking tariff increased by the body corporate',
      }));

    expect(change.previousAmountMinor).toBe(R('650'));
    expect(change.amountMinor).toBe(R('720'));

    const parking = (await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId)))
      .filter((s) => s.category === 'parking');

    // Two rows, in order, with the history intact: R650 until the day before,
    // R720 from the effective date.
    expect(parking).toHaveLength(2);
    expect(parking[0]).toMatchObject({
      amountMinor: R('650'), startDate: '2025-06-01', endDate: '2025-12-31',
    });
    expect(parking[1]).toMatchObject({
      amountMinor: R('720'), startDate: '2026-01-01', endDate: '2026-12-31',
      changeReason: 'Parking tariff increased by the body corporate',
    });
    expect(parking[1]?.supersedesScheduleId).toBe(parking[0]?.id);
  });

  it('refuses a change that would rewrite what was already billed', async () => {
    const parking = (await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId)))
      .filter((s) => s.category === 'parking');

    // Backdating onto the row's own start would silently restate every month
    // it has already covered.
    await expect(as(org.adminUserId, (tx) =>
      changeChargeScheduleAmount(tx, org.organisationId, org.adminUserId, {
        scheduleId: parking[1]!.id, amountMinor: R('800'),
        effectiveFrom: '2026-01-01', reason: 'Backdating it',
      }))).rejects.toThrow(/applied since/);

    await expect(as(org.adminUserId, (tx) =>
      changeChargeScheduleAmount(tx, org.organisationId, org.adminUserId, {
        scheduleId: parking[1]!.id, amountMinor: R('720'),
        effectiveFrom: '2026-06-01', reason: 'No change at all',
      }))).rejects.toThrow(/already being billed/);
  });

  it('bills the new amount from its date, and leaves the old months alone', async () => {
    // A run before the change, and a run after it.
    const bill = async (periodStart: string) => {
      const preview = await as(org.adminUserId, (tx) =>
        previewBillingRun(tx, org.organisationId, { periodStart }));
      const run = await as(org.adminUserId, (tx) =>
        saveBillingPreview(tx, org.organisationId, org.adminUserId, preview));
      return as(org.adminUserId, (tx) =>
        postBillingRun(tx, org.organisationId, org.adminUserId, {
          runId: run.runId, previewVersion: run.previewVersion,
          idempotencyKey: `sched-${periodStart}-${Date.now()}`, issueDate: periodStart,
        }));
    };

    await bill('2025-07-01');
    await bill('2026-07-01');

    const lines = await ownerSql()<{ period: string; amount: string; category: string }[]>`
      select cd.period_start::text as period, cl.amount_minor::text as amount, cl.category
        from charge_lines cl
        join charge_documents cd on cd.id = cl.document_id
       where cl.lease_id = ${leaseId} and cl.category = 'parking'
       order by cd.period_start
    `;
    expect(lines.map((l) => [l.period, l.amount])).toEqual([
      ['2025-07-01', R('650').toString()],
      ['2026-07-01', R('720').toString()],
    ]);
  });

  /* -------------------------------------------------------------- stopping */

  it('stops a charge without deleting what it already billed', async () => {
    const parking = (await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId)))
      .filter((s) => s.category === 'parking');

    await as(org.adminUserId, (tx) =>
      stopChargeSchedule(tx, org.organisationId, org.adminUserId, {
        scheduleId: parking[1]!.id, lastDay: '2026-08-31',
        reason: 'Tenant gave the bay up',
      }));

    const after = (await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId)))
      .filter((s) => s.category === 'parking');
    expect(after[1]?.endDate).toBe('2026-08-31');
    // The July charge it raised is untouched.
    expect(after[1]?.billedPeriods).toBeGreaterThan(0);
  });

  it('refuses to switch rent off, because that is ending a lease', async () => {
    const rent = (await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId)))
      .find((s) => s.category === 'rent')!;
    await expect(as(org.adminUserId, (tx) =>
      stopChargeSchedule(tx, org.organisationId, org.adminUserId, {
        scheduleId: rent.id, lastDay: '2026-09-30', reason: 'Trying it',
      }))).rejects.toThrow(/End or terminate the lease/);
  });

  /* ------------------------------------------------------------ escalation */

  it('sees the agreed escalation fall due, with the arithmetic', async () => {
    // One year after the lease started, 8% on R10,000.
    const due = await as(org.adminUserId, (tx) =>
      escalationsDue(tx, org.organisationId, { leaseId, today: '2026-03-15' }));

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      leaseId,
      currentAmountMinor: R('10000'),
      proposedAmountMinor: R('10800'),
      escalationPercent: 8,
      intervalMonths: 12,
      dueOn: '2026-01-01',
    });
  });

  it('does not apply it on its own', async () => {
    // Nothing above applied the increase, and the schedule still bills what
    // it billed. Raising somebody's rent is a decision, not a side effect.
    const rent = (await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId, '2026-03-15')))
      .find((s) => s.category === 'rent' && s.current)!;
    expect(rent.amountMinor).toBe(R('10000'));
  });

  it('stops reporting it once a person has applied it', async () => {
    const rent = (await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId, '2026-03-15')))
      .find((s) => s.category === 'rent' && s.current)!;

    await as(org.adminUserId, (tx) =>
      changeChargeScheduleAmount(tx, org.organisationId, org.adminUserId, {
        scheduleId: rent.id, amountMinor: R('10800'), effectiveFrom: '2026-01-01',
        reason: 'Agreed 8% escalation, first anniversary',
      }));

    expect(await as(org.adminUserId, (tx) =>
      escalationsDue(tx, org.organisationId, { leaseId, today: '2026-03-15' }))).toEqual([]);
  });

  it('reports no escalation where the lease agreed none', async () => {
    // "A blank escalation field authorises no automatic increase" — the
    // agreement's own words, so a blank one must produce nothing here.
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Kabelo', lastName: 'Sithole',
      }));
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Flat Rent House', code: `FLT${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '9 Steady Street', city: 'Pretoria',
      }));
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2024-01-01', endDate: '2026-12-31',
        rentMinor: R('7000'), depositRequiredMinor: R('7000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }));
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2024-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }));

    expect(await as(org.adminUserId, (tx) =>
      escalationsDue(tx, org.organisationId, { leaseId: lease.leaseId, today: '2026-06-01' })))
      .toEqual([]);
  });

  /* ------------------------------------------------------------- who may */

  it('withholds all of it from somebody who cannot activate a lease', async () => {
    const clerk = await addMember(org.organisationId, 'Finance Clerk', ['finance_preparer']);
    await expect(as(clerk, (tx) =>
      addChargeSchedule(tx, org.organisationId, clerk, {
        leaseId, category: 'levy', description: 'Levy', amountMinor: R('100'),
        startDate: '2026-10-01',
      }))).rejects.toThrow();

    const rent = (await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId, '2026-03-15')))
      .find((s) => s.category === 'rent' && s.current)!;
    await expect(as(clerk, (tx) =>
      changeChargeScheduleAmount(tx, org.organisationId, clerk, {
        scheduleId: rent.id, amountMinor: R('99999'), effectiveFrom: '2026-11-01',
        reason: 'Not mine to change',
      }))).rejects.toThrow();
  });

  it('never reaches another organisation’s schedules', async () => {
    const other = await createOrganisation('Nosy Escalations');
    const rent = (await as(org.adminUserId, (tx) =>
      listChargeSchedules(tx, org.organisationId, leaseId, '2026-03-15')))
      .find((s) => s.category === 'rent' && s.current)!;

    expect(await as(other.adminUserId, (tx) =>
      listChargeSchedules(tx, other.organisationId, leaseId))).toEqual([]);
    await expect(as(other.adminUserId, (tx) =>
      changeChargeScheduleAmount(tx, other.organisationId, other.adminUserId, {
        scheduleId: rent.id, amountMinor: R('1'), effectiveFrom: '2026-11-01',
        reason: 'Somebody else’s lease',
      }))).rejects.toThrow();
  });
});
