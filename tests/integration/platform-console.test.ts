import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  changePlan, closeSupportSession, createProperty, createUnit, customerDetail, listPlans,
  inviteStaff, openSupportSession, setAccountStatus, supportAccessHistory,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createAuthUser, createOrganisation,
  grantSupportSession, ownerSql, type OrganisationFixture,
} from '../support/factories';

/**
 * The Spike platform console.
 *
 * Every function exercised here existed in `packages/domain/src/platform.ts`
 * with no screen anywhere in the application, so the commercial side of the
 * product — plans, suspension, support sessions — had never been driven by
 * anything but a test. These assert the things a screen depends on: that an
 * operator can see a colleague's conduct, that the numbers shown are the
 * customer's real ones even though the underlying tables are closed to the
 * reader, and that a revoke either happens or says so.
 */
describe('Platform console', () => {
  let org: OrganisationFixture;
  let operator: string;
  let colleague: string;
  let propertyId: string;

  beforeAll(async () => {
    org = await createOrganisation('Console Co');
    operator = await createAuthUser('Console Operator', { platformOperator: true });
    colleague = await createAuthUser('Console Colleague', { platformOperator: true });
    const property = await as(org.adminUserId, (tx) =>
      createProperty(tx, org.organisationId, org.adminUserId, {
        name: 'Console Block', code: 'CON', propertyType: 'apartment_block',
        addressLine1: '2 Console Road', city: 'Cape Town',
      }),
    );
    propertyId = property.propertyId;
    for (const code of ['C1', 'C2']) {
      await as(org.adminUserId, (tx) =>
        createUnit(tx, org.organisationId, org.adminUserId, { propertyId, code }),
      );
    }
  });

  afterAll(async () => { await closeOwner(); });

  it('reports a customer’s real usage although every underlying table is closed to the reader', async () => {
    // The point of the assertion: an operator cannot read `units` at all, so a
    // count written the obvious way would return zero and the console would
    // show an empty customer. The counts come through the security-definer
    // usage function instead.
    const direct = await as(operator, (tx) =>
      tx`select count(*)::int as n from units where organisation_id = ${org.organisationId}::uuid`,
    );
    expect((direct as { n: number }[])[0]!.n).toBe(0);

    const detail = await as(operator, (tx) =>
      customerDetail(tx, operator, org.organisationId),
    );
    expect(detail.billableUnits).toBe(2);
    expect(detail.activeMembers).toBeGreaterThanOrEqual(1);
    expect(detail.plan?.key).toBe('starter');
  });

  it('carries no customer content', async () => {
    const detail = await as(operator, (tx) =>
      customerDetail(tx, operator, org.organisationId),
    );
    // Property names, unit codes and resident names are customer content; a
    // console that leaked one through a usage read would pass every other test.
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain('Console Block');
    expect(serialised).not.toContain('C1');
  });

  it('prices today’s usage from the plan and the overage', async () => {
    const plans = await as(operator, (tx) => listPlans(tx));
    const starter = plans.find((p) => p.key === 'starter')!;
    const detail = await as(operator, (tx) =>
      customerDetail(tx, operator, org.organisationId),
    );
    // Two units against an allowance of ten: the plan price, nothing over.
    expect(detail.unitsOverAllowance).toBe(0);
    expect(detail.monthlyChargeMinor).toBe(starter.monthlyPriceMinor);
  });

  it('shows a colleague’s support session, and names them', async () => {
    const session = await grantSupportSession(
      org.organisationId, colleague, org.adminUserId,
    );
    const detail = await as(operator, (tx) =>
      customerDetail(tx, operator, org.organisationId),
    );
    const found = detail.supportSessions.find((s) => s.id === session);
    expect(found).toBeDefined();
    // Before migration 0064 this read as "Spike operator", because a platform
    // operator shares a membership with nobody — and a review that cannot name
    // who acted is not a review.
    expect(found!.operatorName).toBe('Console Colleague');
    expect(found!.openedByMe).toBe(false);
    expect(found!.open).toBe(true);
  });

  it('shows platform actions by any operator, and nothing the customer did', async () => {
    await as(colleague, (tx) =>
      changePlan(tx, colleague, {
        organisationId: org.organisationId, planKey: 'portfolio',
        reason: 'Upgrade agreed on the call, ticket SPK-4100',
      }),
    );
    const detail = await as(operator, (tx) =>
      customerDetail(tx, operator, org.organisationId),
    );
    const planChange = detail.platformActions.find((a) => a.action === 'platform.plan.changed');
    expect(planChange?.actorName).toBe('Console Colleague');
    expect(planChange?.reason).toContain('SPK-4100');
    // The customer's own activity stays closed: the property and units created
    // in setup wrote audit entries, and none of them is readable here.
    expect(detail.platformActions.every((a) => a.action.startsWith('platform.'))).toBe(true);
  });

  it('suspends an account without touching a record', async () => {
    await as(operator, (tx) =>
      setAccountStatus(tx, operator, {
        organisationId: org.organisationId, status: 'suspended',
        reason: 'Non-payment, third notice sent',
      }),
    );
    const detail = await as(operator, (tx) =>
      customerDetail(tx, operator, org.organisationId),
    );
    expect(detail.status).toBe('suspended');
    // Suspension is not deletion, and the blueprint says so explicitly.
    expect(detail.billableUnits).toBe(2);
    expect(detail.activeLeases).toBe(0);

    await as(operator, (tx) =>
      setAccountStatus(tx, operator, {
        organisationId: org.organisationId, status: 'active',
        reason: 'Paid in full on 3 April',
      }),
    );
  });
});

describe('Revoking Spike support access', () => {
  let org: OrganisationFixture;
  let operator: string;
  let preparer: string;

  beforeAll(async () => {
    org = await createOrganisation('Revoke Co');
    operator = await createAuthUser('Revoke Operator', { platformOperator: true });
    // A member with no `support.access.manage`: the role that must NOT be able
    // to revoke, and must not be told that it did.
    preparer = await addMember(org.organisationId, 'Revoke Finance Preparer', ['finance_preparer']);
  });

  afterAll(async () => { await closeOwner(); });

  it('lets an administrator end a session, which the history then shows', async () => {
    const session = await as(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'SPK-5200: duplicate receipt on the March statement',
        hours: 4,
      }),
    );

    await as(org.adminUserId, (tx) =>
      closeSupportSession(tx, org.adminUserId, { supportSessionId: session.supportSessionId }),
    );

    const history = await as(org.adminUserId, (tx) =>
      supportAccessHistory(tx, org.organisationId),
    );
    const row = history.find((h) => h.id === session.supportSessionId);
    expect(row?.revokedAt).not.toBeNull();
  });

  it('refuses a member without the permission, rather than reporting a revoke that did not happen', async () => {
    const session = await as(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'SPK-5201: second query on the same statement',
        hours: 4,
      }),
    );

    // Row-level security makes the UPDATE affect no rows rather than raise, so
    // the previous implementation returned success and left Spike's access
    // open. A silent failure here is the worst available outcome.
    await expect(
      as(preparer, (tx) =>
        closeSupportSession(tx, preparer, { supportSessionId: session.supportSessionId }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const [row] = await ownerSql()<{ revoked_at: string | null }[]>`
      select revoked_at from support_sessions where id = ${session.supportSessionId}
    `;
    expect(row!.revoked_at).toBeNull();

    await as(org.adminUserId, (tx) =>
      closeSupportSession(tx, org.adminUserId, { supportSessionId: session.supportSessionId }),
    );
  });

  it('lets the operator who opened a session close it themselves', async () => {
    const session = await as(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'SPK-5202: finished reading, closing early',
        hours: 8,
      }),
    );
    await as(operator, (tx) =>
      closeSupportSession(tx, operator, { supportSessionId: session.supportSessionId }),
    );
    const detail = await as(operator, (tx) =>
      customerDetail(tx, operator, org.organisationId),
    );
    expect(detail.supportSessions.find((s) => s.id === session.supportSessionId)!.open).toBe(false);
  });
});

/**
 * Enforcement, which is the part that was missing.
 *
 * `requireEntitlement` was written, tested in isolation and called from
 * nowhere in the product, so every plan in the price list was effectively
 * unlimited. These assert the two enforcement points and — just as important —
 * that hitting a limit leaves everything the customer already has alone.
 */
describe('Plan allowances are enforced where records are created', () => {
  let org: OrganisationFixture;
  let operator: string;
  let propertyId: string;

  beforeAll(async () => {
    org = await createOrganisation('Allowance Co');   // starter: 10 units, 3 staff
    operator = await createAuthUser('Allowance Operator', { platformOperator: true });
    const property = await as(org.adminUserId, (tx) =>
      createProperty(tx, org.organisationId, org.adminUserId, {
        name: 'Allowance Block', code: 'ALW', propertyType: 'apartment_block',
        addressLine1: '3 Allowance Street', city: 'Johannesburg',
      }),
    );
    propertyId = property.propertyId;
  });

  afterAll(async () => { await closeOwner(); });

  it('refuses the eleventh unit on a ten-unit plan', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await as(org.adminUserId, (tx) =>
        createUnit(tx, org.organisationId, org.adminUserId, { propertyId, code: `A${i}` }),
      );
    }

    await expect(
      as(org.adminUserId, (tx) =>
        createUnit(tx, org.organisationId, org.adminUserId, { propertyId, code: 'A11' }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The ten they have are untouched, and the refusal says what to do.
    const [row] = await ownerSql()<{ n: number }[]>`
      select count(*)::int as n from units
      where organisation_id = ${org.organisationId} and status = 'active'
    `;
    expect(row!.n).toBe(10);
  });

  it('lets the eleventh through once Spike moves them up a plan', async () => {
    await as(operator, (tx) =>
      changePlan(tx, operator, {
        organisationId: org.organisationId, planKey: 'portfolio',
        reason: 'Customer asked for room to grow, ticket SPK-6001',
      }),
    );
    const created = await as(org.adminUserId, (tx) =>
      createUnit(tx, org.organisationId, org.adminUserId, { propertyId, code: 'A11' }),
    );
    expect(created.unitId).toBeTruthy();
  });

  it('counts an unaccepted invitation against the staff allowance', async () => {
    // Back to starter: three staff included, and this organisation has one.
    await as(operator, (tx) =>
      changePlan(tx, operator, {
        organisationId: org.organisationId, planKey: 'starter',
        reason: 'Customer downgraded, ticket SPK-6002',
      }),
    );

    const invited: string[] = [];
    for (const name of ['One', 'Two']) {
      const invitation = await as(org.adminUserId, (tx) =>
        inviteStaff(tx, org.organisationId, org.adminUserId, {
          email: `allowance.${name.toLowerCase()}@demo.invalid`,
          fullName: `Allowance ${name}`,
          roles: ['finance_preparer'],
          scope: { type: 'organisation' },
        }),
      );
      invited.push(invitation.invitationId);
    }
    expect(invited).toHaveLength(2);

    // One member plus two invitations is three: the next one is refused even
    // though nobody has accepted, because otherwise a cap could be walked past
    // by inviting ten people at once.
    await expect(
      as(org.adminUserId, (tx) =>
        inviteStaff(tx, org.organisationId, org.adminUserId, {
          email: 'allowance.three@demo.invalid',
          fullName: 'Allowance Three',
          roles: ['finance_preparer'],
          scope: { type: 'organisation' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('shows the operator that they are over, without hiding anything they have', async () => {
    const detail = await as(operator, (tx) =>
      customerDetail(tx, operator, org.organisationId),
    );
    const units = detail.allowances.find((a) => a.feature === 'billable_units')!;
    expect(units.used).toBe(11);
    expect(units.limit).toBe(10);
    expect(units.withinLimit).toBe(false);
    // One unit beyond the starter allowance, at the plan's own overage price.
    expect(detail.unitsOverAllowance).toBe(1);
    expect(detail.monthlyChargeMinor).toBe(
      detail.plan!.monthlyPriceMinor + detail.plan!.additionalUnitPriceMinor,
    );
  });
});
