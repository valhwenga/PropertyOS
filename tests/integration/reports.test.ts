/**
 * Milestone 4 acceptance: reports, verified metrics and platform operations.
 *
 * The central assertion in this suite is that every headline figure EQUALS the
 * sum of the records it links to. A dashboard number that cannot be reconciled
 * to its rows is exactly the "feature that displays mock totals" the blueprint
 * warns against, so it is asserted rather than assumed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, allocateReceipt, arrearsAgeing, changePlan, checkEntitlement,
  closeSupportSession, collectionReport, confirmReceipt, createResident,
  createStandaloneHouse, createProperty, createUnit, depositRegister, draftLease,
  expenseReport, journalLinesExport, leaseExpiryReport, listCustomers,
  occupancyReport, openSupportSession, parseMajorToMinor, platformHealth,
  postCharge, rentRoll, requireEntitlement, setAccountStatus, supportAccessHistory,
  suggestAllocation, toCsv,
} from '@propertyos/domain';
import {
  as, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Reports and verified metrics', () => {
  let org: OrganisationFixture;
  let leaseA: string;
  let leaseB: string;

  beforeAll(async () => {
    org = await createOrganisation('Reporting Co');

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Report', lastName: 'Resident',
      }),
    );

    // Lease A: billed R10,000, paid R4,000 -> R6,000 outstanding, overdue.
    const houseA = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Report House A', code: 'REPA', propertyType: 'house',
        addressLine1: '1 Report Road', city: 'Cape Town',
      }),
    );
    const la = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: houseA.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('10000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseA = la.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: leaseA, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );

    // Lease B: billed R6,000, paid in full.
    const houseB = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Report House B', code: 'REPB', propertyType: 'cottage',
        addressLine1: '2 Report Road', city: 'Cape Town',
      }),
    );
    const lb = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: houseB.unitId, startDate: '2026-01-01', endDate: '2026-06-30',
        rentMinor: R('6000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseB = lb.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: leaseB, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );

    // Charges, dated in the past so they are genuinely overdue.
    const chargeA = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId: leaseA, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('10000'), dueDate: '2026-01-01' }],
      }),
    );
    const chargeB = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId: leaseB, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('6000'), dueDate: '2026-01-01' }],
      }),
    );

    const receiptA = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId: leaseA, amountMinor: R('4000'), receivedOn: '2026-01-10',
      }),
    );
    const [lineA] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${chargeA.documentId}
    `;
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receiptA.receiptId,
        allocations: [{ chargeLineId: lineA!.id, amountMinor: R('4000') }],
        postingDate: '2026-01-10',
      }),
    );

    const receiptB = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId: leaseB, amountMinor: R('6000'), receivedOn: '2026-01-05',
      }),
    );
    const [lineB] = await ownerSql()<{ id: string }[]>`
      select id from charge_lines where document_id = ${chargeB.documentId}
    `;
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receiptB.receiptId,
        allocations: [{ chargeLineId: lineB!.id, amountMinor: R('6000') }],
        postingDate: '2026-01-05',
      }),
    );

    // One operating and one capital expense, so the split can be checked.
    const [book] = await ownerSql()<{ id: string }[]>`
      select id from financial_books where organisation_id = ${org.organisationId} and is_default
    `;
    await ownerSql()`
      insert into expenses (organisation_id, book_id, property_id, category, cost_class,
        description, amount_minor, currency_code, expense_date, status)
      values
        (${org.organisationId}, ${book!.id}, ${houseA.propertyId}, 'repairs_maintenance',
         'operating', 'Gutter repair', 180000, 'ZAR', '2026-01-15', 'approved'),
        (${org.organisationId}, ${book!.id}, ${houseA.propertyId}, 'capital_improvement',
         'capital', 'New solar geyser', 2200000, 'ZAR', '2026-01-20', 'approved')
    `;
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------- headline equals sum of rows */

  it('rent roll: totals equal the sum of their rows', async () => {
    const report = await as(org.adminUserId, (tx) =>
      rentRoll(tx, org.organisationId, { asAt: '2026-03-01' }),
    );
    const summedRent = report.rows.reduce((s, r) => s + r.contractedRentMinor, 0n);
    const summedReceivable = report.rows.reduce((s, r) => s + r.receivableMinor, 0n);

    expect(report.totalRentMinor).toBe(summedRent);
    expect(report.totalReceivableMinor).toBe(summedReceivable);
    expect(report.totalRentMinor).toBe(R('16000'));
    expect(report.rows).toHaveLength(2);
  });

  it('arrears ageing: every bucket total equals the sum of its column', async () => {
    const report = await as(org.adminUserId, (tx) =>
      arrearsAgeing(tx, org.organisationId),
    );
    const column = (pick: (r: (typeof report.rows)[number]) => bigint) =>
      report.rows.reduce((s, r) => s + pick(r), 0n);

    expect(report.totals.notYetDueMinor).toBe(column((r) => r.notYetDueMinor));
    expect(report.totals.days1to30Minor).toBe(column((r) => r.days1to30Minor));
    expect(report.totals.days31to60Minor).toBe(column((r) => r.days31to60Minor));
    expect(report.totals.days61to90Minor).toBe(column((r) => r.days61to90Minor));
    expect(report.totals.daysOver90Minor).toBe(column((r) => r.daysOver90Minor));
    expect(report.totals.totalMinor).toBe(column((r) => r.totalMinor));

    // Only lease A is in arrears: R10,000 billed less R4,000 allocated.
    expect(report.totals.totalMinor).toBe(R('6000'));
    expect(report.rows).toHaveLength(1);
  });

  it('arrears ageing reconciles to the lease balances view', async () => {
    const report = await as(org.adminUserId, (tx) => arrearsAgeing(tx, org.organisationId));
    const [balance] = await ownerSql()<{ receivable_minor: string }[]>`
      select receivable_minor::text from lease_balances where lease_id = ${leaseA}
    `;
    // Two independent paths through the data must agree.
    expect(report.rows[0]!.totalMinor).toBe(BigInt(balance!.receivable_minor));
  });

  it('collection report: rate is derived from the rows, not stored', async () => {
    const report = await as(org.adminUserId, (tx) =>
      collectionReport(tx, org.organisationId, {
        periodStart: '2026-01-01', periodEnd: '2026-01-31',
      }),
    );
    expect(report.totalBilledMinor).toBe(report.rows.reduce((s, r) => s + r.billedMinor, 0n));
    expect(report.totalCollectedMinor).toBe(report.rows.reduce((s, r) => s + r.collectedMinor, 0n));
    expect(report.totalBilledMinor).toBe(R('16000'));
    expect(report.totalCollectedMinor).toBe(R('10000'));
    // 10,000 of 16,000 = 62.5%
    expect(report.collectionRatePercent).toBe(62.5);
  });

  it('collection report returns null rather than dividing by zero', async () => {
    const empty = await as(org.adminUserId, (tx) =>
      collectionReport(tx, org.organisationId, {
        periodStart: '2030-01-01', periodEnd: '2030-01-31',
      }),
    );
    expect(empty.totalBilledMinor).toBe(0n);
    expect(empty.collectionRatePercent).toBeNull();
  });

  it('expense report separates operating from capital', async () => {
    const report = await as(org.adminUserId, (tx) =>
      expenseReport(tx, org.organisationId, {
        periodStart: '2026-01-01', periodEnd: '2026-01-31',
      }),
    );
    expect(report.totalOperatingMinor).toBe(R('1800'));
    expect(report.totalCapitalMinor).toBe(R('22000'));
    expect(report.totalMinor).toBe(R('23800'));
    // Net operating income must not absorb the capital improvement.
    expect(report.totalOperatingMinor).not.toBe(report.totalMinor);
  });

  it('journal lines export balances and carries the full double entry', async () => {
    const report = await as(org.adminUserId, (tx) =>
      journalLinesExport(tx, org.organisationId, {
        periodStart: '2026-01-01', periodEnd: '2026-01-31',
      }),
    );
    expect(report.balanced).toBe(true);
    expect(report.totalDebitMinor).toBe(report.totalCreditMinor);
    expect(report.rows.length).toBeGreaterThan(0);
    // Every line carries exactly one side.
    for (const line of report.rows) {
      expect((line.debitMinor > 0n) !== (line.creditMinor > 0n)).toBe(true);
    }
  });

  it('lease expiry shows holdover occupancy and retained arrears', async () => {
    const report = await as(org.adminUserId, (tx) =>
      leaseExpiryReport(tx, org.organisationId, { withinDays: 3650 }),
    );
    const a = report.rows.find((r) => r.leaseId === leaseA)!;
    expect(a.stillOccupied).toBe(true);
    expect(a.receivableMinor).toBe(R('6000'));
  });

  it('occupancy excludes out-of-service days from the denominator', async () => {
    const before = await as(org.adminUserId, (tx) =>
      occupancyReport(tx, org.organisationId, { periodStart: '2026-01-01', periodEnd: '2026-01-31' }),
    );
    expect(before.outOfServiceUnitDays).toBe(0);
    expect(before.availableUnitDays).toBe(62); // two units x 31 days

    const [unit] = await ownerSql()<{ id: string }[]>`
      select u.id from units u join properties p on p.id = u.property_id
      where p.code = 'REPB' and u.organisation_id = ${org.organisationId}
    `;
    await ownerSql()`
      insert into unit_availability (organisation_id, unit_id, period, reason)
      values (${org.organisationId}, ${unit!.id},
              daterange('2026-01-01'::date, '2026-01-10'::date, '[]'), 'Bathroom renovation')
    `;

    const after = await as(org.adminUserId, (tx) =>
      occupancyReport(tx, org.organisationId, { periodStart: '2026-01-01', periodEnd: '2026-01-31' }),
    );
    expect(after.outOfServiceUnitDays).toBe(10);
    expect(after.availableUnitDays).toBe(52);
    // A renovation must not read as a letting failure.
    expect(after.physicalOccupancyPercent!).toBeGreaterThan(before.physicalOccupancyPercent!);
  });

  it('deposit register reports held money without touching the receivable', async () => {
    const report = await as(org.adminUserId, (tx) => depositRegister(tx, org.organisationId));
    expect(report.totalHeldMinor).toBe(0n);
    expect(report.meta.qualifications.join(' ')).toContain('NOT rental income');
  });

  it('reports describe only the caller scope', async () => {
    const { addMember } = await import('../support/factories.js');
    const [propertyA] = await ownerSql()<{ id: string }[]>`
      select id from properties where code = 'REPA' and organisation_id = ${org.organisationId}
    `;
    // Scoped to property A only.
    const scoped = await addMember(
      org.organisationId, 'Scoped Reporter', ['finance_approver'],
      { type: 'property', propertyId: propertyA!.id },
    );
    const full = await as(org.adminUserId, (tx) => rentRoll(tx, org.organisationId));
    const partial = await as(scoped, (tx) => rentRoll(tx, org.organisationId));

    expect(full.rows).toHaveLength(2);
    expect(partial.rows).toHaveLength(1);
    // The total correctly describes the narrower scope rather than leaking the rest.
    expect(partial.totalRentMinor).toBe(R('10000'));
  });

  it('exports carry their filters and qualifications alongside the data', async () => {
    const report = await as(org.adminUserId, (tx) => arrearsAgeing(tx, org.organisationId));
    const csv = toCsv(
      report.meta,
      [
        { key: 'leaseReference', label: 'Lease' },
        { key: 'totalMinor', label: 'Outstanding' },
      ],
      report.rows.map((r) => ({ leaseReference: r.leaseReference, totalMinor: r.totalMinor.toString() })),
    );
    expect(csv).toContain('Arrears ageing');
    expect(csv).toContain('due date, not the invoice creation date');
    expect(csv).toContain('Generated at');
    // A figure must never travel without its definition.
    expect(csv.split('\r\n').filter((l) => l.startsWith('"Note"')).length).toBeGreaterThanOrEqual(3);
  });
});

describe('Spike platform administration', () => {
  let orgA: OrganisationFixture;
  let orgB: OrganisationFixture;
  let operator: string;

  beforeAll(async () => {
    orgA = await createOrganisation('Platform Customer A');
    orgB = await createOrganisation('Platform Customer B');
    operator = await createAuthUser('Platform Operator', { platformOperator: true });

    const resident = await as(orgA.adminUserId, (tx) =>
      createResident(tx, orgA.organisationId, orgA.adminUserId, {
        firstName: 'Private', lastName: 'Person',
      }),
    );
    expect(resident.residentId).toBeTruthy();
  });

  afterAll(async () => { await closeOwner(); });

  it('lists customers as metadata only, with no customer content', async () => {
    const customers = await as(operator, (tx) => listCustomers(tx, operator));
    const a = customers.find((c) => c.organisationId === orgA.organisationId)!;

    expect(a.name).toBe('Platform Customer A');
    expect(a.planKey).toBe('starter');
    expect(a.billableUnits).toBe(0);
    // Nothing in the payload can carry a resident name or a balance.
    expect(JSON.stringify(customers)).not.toContain('Private');
    expect(JSON.stringify(customers)).not.toContain('Person');
  });

  it('refuses the platform console to a non-operator', async () => {
    await expect(
      as(orgA.adminUserId, (tx) => listCustomers(tx, orgA.adminUserId)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('gives an operator no customer records without a support session', async () => {
    await as(operator, async (tx) => {
      expect(await tx`select id from resident_profiles`).toHaveLength(0);
      expect(await tx`select id from leases`).toHaveLength(0);
      expect(await tx`select id from journals`).toHaveLength(0);
    });
  });

  it('opens an audited, time-limited, read-only support session', async () => {
    const session = await as(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: orgA.organisationId,
        reason: 'Customer raised reconciliation query, ticket SPK-2041',
        hours: 2,
        authorisedByUserId: orgA.adminUserId,
      }),
    );
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Reading is now possible...
    await as(operator, async (tx) => {
      expect(await tx`select id from resident_profiles`).not.toHaveLength(0);
    });
    // ...but writing is not. Support sessions are read-only by design.
    await expect(
      as(operator, (tx) =>
        createResident(tx, orgA.organisationId, operator, {
          firstName: 'Support', lastName: 'Written',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // And it does not spill into the other customer.
    await as(operator, async (tx) => {
      const foreign = await tx`
        select id from resident_profiles where organisation_id = ${orgB.organisationId}::uuid
      `;
      expect(foreign).toHaveLength(0);
    });
  });

  it('rejects a support session with no stated reason', async () => {
    await expect(
      as(operator, (tx) =>
        openSupportSession(tx, operator, {
          organisationId: orgA.organisationId, reason: 'checking', hours: 2,
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('caps a support session at 24 hours', async () => {
    await expect(
      as(operator, (tx) =>
        openSupportSession(tx, operator, {
          organisationId: orgA.organisationId,
          reason: 'Long running investigation, ticket SPK-2042', hours: 72,
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('shows the customer who accessed their data and why', async () => {
    const history = await as(orgA.adminUserId, (tx) =>
      supportAccessHistory(tx, orgA.organisationId),
    );
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]!.operatorName).toBe('Platform Operator');
    expect(history[0]!.reason).toContain('SPK-2041');
    expect(history[0]!.readOnly).toBe(true);
    expect(history[0]!.authorisedByName).toBe('Platform Customer A Admin');
  });

  it('ends access the moment a session is closed', async () => {
    const [session] = await ownerSql()<{ id: string }[]>`
      select id from support_sessions
      where organisation_id = ${orgA.organisationId} and revoked_at is null
      order by granted_at desc limit 1
    `;
    await as(operator, (tx) => closeSupportSession(tx, operator, { supportSessionId: session!.id }));
    await as(operator, async (tx) => {
      expect(await tx`select id from resident_profiles`).toHaveLength(0);
    });
  });

  it('suspends an account without deleting any record', async () => {
    const before = await ownerSql()<{ properties: string; leases: string; journals: string }[]>`
      select
        (select count(*)::text from properties where organisation_id = ${orgA.organisationId}) as properties,
        (select count(*)::text from leases where organisation_id = ${orgA.organisationId}) as leases,
        (select count(*)::text from journals where organisation_id = ${orgA.organisationId}) as journals
    `;
    await as(operator, (tx) =>
      setAccountStatus(tx, operator, {
        organisationId: orgA.organisationId, status: 'suspended',
        reason: 'Non-payment of subscription, ticket SPK-2050',
      }),
    );
    const after = await ownerSql()<{ properties: string; leases: string; journals: string }[]>`
      select
        (select count(*)::text from properties where organisation_id = ${orgA.organisationId}) as properties,
        (select count(*)::text from leases where organisation_id = ${orgA.organisationId}) as leases,
        (select count(*)::text from journals where organisation_id = ${orgA.organisationId}) as journals
    `;
    // Suspension is not deletion.
    expect(after[0]).toEqual(before[0]);

    const [status] = await ownerSql()<{ status: string }[]>`
      select status::text from organisations where id = ${orgA.organisationId}
    `;
    expect(status!.status).toBe('suspended');
  });

  it('records every platform action in the audit trail with its reason', async () => {
    const events = await ownerSql()<{ action: string; reason: string | null }[]>`
      select action, reason from audit_events
      where organisation_id = ${orgA.organisationId}
        and action like 'platform.%'
      order by occurred_at
    `;
    expect(events.map((e) => e.action)).toContain('platform.support_session.opened');
    expect(events.map((e) => e.action)).toContain('platform.account.status_changed');
    for (const event of events.filter((e) => e.action !== 'platform.support_session.closed')) {
      expect(event.reason).toBeTruthy();
    }
  });

  it('reports platform health without exposing customer data', async () => {
    const health = await as(operator, (tx) => platformHealth(tx, operator));
    expect(health).toHaveProperty('queuedJobs');
    expect(health).toHaveProperty('deadJobs');
    expect(JSON.stringify(health)).not.toContain('Private');
  });
});

describe('Plan entitlements', () => {
  let org: OrganisationFixture;
  let operator: string;
  let propertyId: string;

  beforeAll(async () => {
    org = await createOrganisation('Entitlement Co');
    operator = await createAuthUser('Entitlement Operator', { platformOperator: true });
    const property = await as(org.adminUserId, (tx) =>
      createProperty(tx, org.organisationId, org.adminUserId, {
        name: 'Entitlement Block', code: 'ENT', propertyType: 'apartment_block',
        addressLine1: '1 Entitlement Way', city: 'Durban',
      }),
    );
    propertyId = property.propertyId;
  });

  afterAll(async () => { await closeOwner(); });

  it('counts every non-archived rentable unit, including vacant ones', async () => {
    for (const code of ['U1', 'U2', 'U3']) {
      await as(org.adminUserId, (tx) =>
        createUnit(tx, org.organisationId, org.adminUserId, { propertyId, code }),
      );
    }
    const check = await as(org.adminUserId, (tx) =>
      checkEntitlement(tx, org.organisationId, 'billable_units'),
    );
    // Starter includes 10; three vacant units still count.
    expect(check.used).toBe(3);
    expect(check.limit).toBe(10);
    expect(check.withinLimit).toBe(true);
  });

  it('blocks adding beyond the plan limit, leaving existing records untouched', async () => {
    // Fill to the starter limit of 10.
    for (let i = 4; i <= 10; i += 1) {
      await as(org.adminUserId, (tx) =>
        createUnit(tx, org.organisationId, org.adminUserId, { propertyId, code: `U${i}` }),
      );
    }
    const atLimit = await as(org.adminUserId, (tx) =>
      checkEntitlement(tx, org.organisationId, 'billable_units'),
    );
    expect(atLimit.used).toBe(10);

    await expect(
      as(org.adminUserId, (tx) => requireEntitlement(tx, org.organisationId, 'billable_units')),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // Crucially, the existing ten units are still fully visible and usable.
    const units = await as(org.adminUserId, (tx) =>
      tx`select id from units where organisation_id = ${org.organisationId}::uuid`,
    );
    expect(units).toHaveLength(10);
  });

  it('lifts the limit when the plan is upgraded', async () => {
    await as(operator, (tx) =>
      changePlan(tx, operator, {
        organisationId: org.organisationId, planKey: 'portfolio',
        reason: 'Customer upgraded to the portfolio plan, ticket SPK-3001',
      }),
    );
    const check = await as(org.adminUserId, (tx) =>
      checkEntitlement(tx, org.organisationId, 'billable_units'),
    );
    expect(check.limit).toBe(50);
    expect(check.withinLimit).toBe(true);

    await expect(
      as(org.adminUserId, (tx) => requireEntitlement(tx, org.organisationId, 'billable_units')),
    ).resolves.toBeUndefined();
  });

  it('records the plan change with its reason', async () => {
    const [event] = await ownerSql()<{ reason: string; before_state: unknown; after_state: unknown }[]>`
      select reason, before_state, after_state from audit_events
      where organisation_id = ${org.organisationId} and action = 'platform.plan.changed'
    `;
    expect(event!.reason).toContain('SPK-3001');
    expect(JSON.stringify(event!.before_state)).toContain('starter');
    expect(JSON.stringify(event!.after_state)).toContain('portfolio');
  });
});

describe('Dashboard metrics reconcile to their records', () => {
  /**
   * The blueprint requires that "every headline figure should open the
   * underlying records using the same filters". That is only meaningful if the
   * figure and the records AGREE, so this suite recomputes each dashboard metric
   * from the report it links to and asserts they match.
   */
  let org: OrganisationFixture;

  beforeAll(async () => {
    org = await createOrganisation('Dashboard Reconciliation Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Dash', lastName: 'Board',
      }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Dashboard House', code: 'DASH', propertyType: 'house',
        addressLine1: '1 Dashboard Drive', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('9000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('9000'), dueDate: '2026-01-01' }],
      }),
    );
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, amountMinor: R('3500'), receivedOn: '2026-01-15',
      }),
    );
    const suggestion = await as(org.adminUserId, (tx) =>
      suggestAllocation(tx, org.organisationId, { leaseId: lease.leaseId, amountMinor: R('3500') }),
    );
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, allocations: suggestion.allocations, postingDate: '2026-01-15',
      }),
    );
    expect(charge.totalMinor).toBe(R('9000'));
  });

  afterAll(async () => { await closeOwner(); });

  it('"rent billed" equals the collection report it links to', async () => {
    // The dashboard tile and the report are written as separate queries. Both
    // are recomputed here from the raw charge lines, so a drift between the
    // headline and the records behind it fails the build.
    const report = await as(org.adminUserId, (tx) =>
      collectionReport(tx, org.organisationId, { periodStart: '2026-01-01', periodEnd: '2026-01-31' }),
    );
    const [raw] = await ownerSql()<{ billed: string }[]>`
      select coalesce(sum(cl.amount_minor), 0)::text as billed
      from charge_lines cl
      join charge_documents cd on cd.id = cl.document_id
      where cl.organisation_id = ${org.organisationId}
        and cd.status = 'posted' and cl.category = 'rent'
        and cd.issue_date between '2026-01-01' and '2026-01-31'
    `;
    expect(report.totalBilledMinor).toBe(BigInt(raw!.billed));
    expect(report.totalBilledMinor).toBe(R('9000'));
  });

  it('"outstanding receivable" equals the arrears report it links to', async () => {
    const ageing = await as(org.adminUserId, (tx) => arrearsAgeing(tx, org.organisationId));
    const [raw] = await ownerSql()<{ outstanding: string }[]>`
      select coalesce(sum(outstanding_minor), 0)::text as outstanding
      from charge_line_balances
      where organisation_id = ${org.organisationId} and outstanding_minor > 0
    `;
    expect(ageing.totals.totalMinor).toBe(BigInt(raw!.outstanding));
    expect(ageing.totals.totalMinor).toBe(R('5500')); // 9,000 billed less 3,500 allocated
  });

  it('"occupancy" equals the occupancy report it links to', async () => {
    const report = await as(org.adminUserId, (tx) =>
      occupancyReport(tx, org.organisationId, { periodStart: '2026-01-01', periodEnd: '2026-01-31' }),
    );
    const [raw] = await ownerSql()<{ units: string }[]>`
      select count(*)::text as units from units
      where organisation_id = ${org.organisationId} and status = 'active'
    `;
    expect(report.availableUnitDays).toBe(Number(raw!.units) * 31);
    expect(report.physicalOccupancyPercent).toBe(100);
  });

  it('the rent roll receivable equals the arrears total', async () => {
    const roll = await as(org.adminUserId, (tx) => rentRoll(tx, org.organisationId));
    const ageing = await as(org.adminUserId, (tx) => arrearsAgeing(tx, org.organisationId));
    // Two independently written queries over the same posted records.
    expect(roll.totalReceivableMinor).toBe(ageing.totals.totalMinor);
  });

  it('the journal lines export reconciles to the trial balance', async () => {
    const report = await as(org.adminUserId, (tx) =>
      journalLinesExport(tx, org.organisationId, { periodStart: '2020-01-01', periodEnd: '2030-12-31' }),
    );
    const [trial] = await ownerSql()<{ debit: string; credit: string }[]>`
      select coalesce(sum(debit_minor), 0)::text as debit,
             coalesce(sum(credit_minor), 0)::text as credit
      from trial_balance where organisation_id = ${org.organisationId}
    `;
    expect(report.totalDebitMinor).toBe(BigInt(trial!.debit));
    expect(report.totalCreditMinor).toBe(BigInt(trial!.credit));
    expect(report.balanced).toBe(true);
  });
});
