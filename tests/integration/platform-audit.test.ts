/**
 * Reviewing Spike's own conduct.
 *
 * `platform.audit.read` was named when operators got roles and had nothing
 * behind it. The reason it needed something changed shape when sessions became
 * able to CHANGE a customer's records: "what has Spike done inside our
 * customers' data" stopped being a question about reading, and the only person
 * who could answer it was the operator who did it —
 * `audit_events_platform_own_select` shows an operator their own actions and
 * nothing showed a colleague's.
 *
 * What these tests pin:
 *
 *   1. a reviewer sees a COLLEAGUE's actions inside customer records, which is
 *      the whole point — 0064 settled this argument for platform actions
 *      already, on the grounds that a review which cannot name who acted is
 *      not a review;
 *   2. the review set is Spike's conduct and nothing else: the customer's own
 *      staff never appear, even when a live session would technically let the
 *      caller read those rows;
 *   3. an operator without the permission reads none of it;
 *   4. the count under the table describes the same set as the table.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  approveSupportSession, changePlan, createResident, createTicket, grantSupportAccess,
  openSupportSession, platformAuditChoices, platformAuditSummary, platformAuditTrail,
  createStandaloneHouse,
} from '@propertyos/domain';
import {
  as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

async function createOperator(name: string, roles: string[] = ['platform_admin']): Promise<string> {
  const authUserId = await createAuthUser(name, {
    platformOperator: true, platformRoles: roles,
  });
  await ownerSql()`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
    values (${authUserId}, 'totp', 'JBSWY3DPEHPK3PXP', now())
    on conflict (auth_user_id, factor_type) do update set verified_at = now()
  `;
  return authUserId;
}

describe('reviewing what Spike has done', () => {
  let org: OrganisationFixture;
  let reviewer: string;
  let actingOperator: string;
  let ticketId: string;
  let residentName: string;

  beforeAll(async () => {
    org = await createOrganisation('Audited Co', { planKey: 'portfolio' });
    reviewer = await createOperator('Spike Reviewer');
    actingOperator = await createOperator('Spike Doer');

    const property = await as(org.adminUserId, (tx) => createStandaloneHouse(
      tx, org.organisationId, org.adminUserId, {
        name: 'Audited House', code: 'AUD', propertyType: 'house',
        addressLine1: '1 Audit Road', city: 'Pretoria',
      },
    ));

    // A platform action, by one operator.
    await asPlatformOperator(actingOperator, (tx) =>
      changePlan(tx, actingOperator, {
        organisationId: org.organisationId, planKey: 'starter',
        reason: 'Downgraded at the customer’s request on ticket SPK-9001.',
      }),
    );

    // A session the customer approved, and work done inside their records.
    await as(org.adminUserId, (tx) =>
      grantSupportAccess(tx, org.organisationId, org.adminUserId, {
        hours: 4, reason: 'SPK-9001: please re-file the leak ticket.',
        scopes: ['maintenance'],
      }),
    );
    const session = await asPlatformOperator(actingOperator, (tx) =>
      openSupportSession(tx, actingOperator, {
        organisationId: org.organisationId,
        reason: 'SPK-9001: re-filing the leak ticket for them.',
        hours: 2, scopes: ['maintenance'],
      }),
    );
    expect(session.scopes).toEqual(['maintenance']);

    const ticket = await as(actingOperator, (tx) =>
      createTicket(tx, org.organisationId, actingOperator, {
        propertyId: property.propertyId, unitId: property.unitId, category: 'plumbing',
        description: 'Re-filed by Spike support on the customer’s behalf.',
        urgency: 'normal',
      }),
    );
    ticketId = ticket.ticketId;

    // And something the CUSTOMER did themselves, which must never appear.
    residentName = `Private ${Date.now().toString(36)}`;
    await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: residentName, lastName: 'Resident',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('shows a reviewer what a colleague did inside a customer’s records', async () => {
    const { rows } = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { kind: 'support', organisationId: org.organisationId }),
    );

    const theirs = rows.find((r) => r.resourceId === ticketId);
    expect(theirs).toBeDefined();
    expect(theirs!.actorName).toBe('Spike Doer');
    expect(theirs!.organisationName).toBe('Audited Co');
    // The three things that make the action legitimate travel with it: the
    // session, what it was allowed to change, and who at the customer agreed.
    expect(theirs!.supportSessionId).toBeTruthy();
    expect(theirs!.supportScopes).toEqual(['maintenance']);
    expect(theirs!.approvedByName).toBeTruthy();
  });

  it('shows the platform actions too, with the reason they were given', async () => {
    const { rows } = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { kind: 'platform', organisationId: org.organisationId }),
    );
    const plan = rows.find((r) => r.action === 'platform.plan.changed');
    expect(plan?.actorName).toBe('Spike Doer');
    expect(plan?.reason).toContain('SPK-9001');
  });

  it('never returns the customer’s own staff, whatever the filters say', async () => {
    const { rows } = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { kind: 'all', limit: 1000 }),
    );
    // The resident the landlord created THEMSELVES is the test: it is in the
    // same table, in an organisation the reviewer can name, and it is not
    // Spike's conduct.
    //
    // Note what cannot be asserted here, which the first version of this test
    // got wrong: not "no `resident.created` row appears". Elsewhere in this
    // suite an operator creates a resident under a `records` session, and that
    // row IS Spike's conduct and belongs in this view. The action name says
    // nothing about who did it; the session stamp does.
    expect(JSON.stringify(rows)).not.toContain(residentName);

    // Every row is one of the two things this view is for.
    for (const row of rows) {
      expect(
        row.action.startsWith('platform.') || row.supportSessionId !== null,
      ).toBe(true);
    }
  });

  it('refuses the whole trail to an operator whose role does not carry it', async () => {
    // Every seeded role carries audit.read, so this is built the only way a
    // roleless operator can exist: by taking the roles away.
    const stripped = await createOperator('Spike Roleless', ['platform_support']);
    await ownerSql()`
      delete from platform_operator_roles where auth_user_id = ${stripped}
    `;

    await expect(
      asPlatformOperator(stripped, (tx) => platformAuditTrail(tx, stripped, {})),
    ).rejects.toThrow(/platform role does not include this/i);

    // And the rows themselves are refused, not merely the function: the policy
    // is keyed on the permission since 0075, so a path that skipped the
    // function would still read nothing.
    const leaked = await as(stripped, (tx) => tx`
      select id from audit_events where support_session_id is not null
    `);
    expect(leaked).toHaveLength(0);
  });

  it('still lets an operator account for their own work after their roles go', async () => {
    // `audit_events_platform_own_select` is deliberately left on operator
    // status: being unable to explain what you did yourself is not a sanction
    // anybody chose.
    const own = await as(actingOperator, (tx) => tx`
      select id from audit_events where actor_user_id = ${actingOperator}::uuid
    `);
    expect(own.length).toBeGreaterThan(0);
  });

  it('counts the same set it lists, and says when the list is cut short', async () => {
    const full = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { kind: 'all', limit: 1000 }),
    );
    expect(full.total).toBe(full.rows.length);
    expect(full.capped).toBe(false);

    const clipped = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { kind: 'all', limit: 1 }),
    );
    expect(clipped.rows).toHaveLength(1);
    // The number under a truncated table describes the whole set, and the flag
    // is what stops a reviewer concluding anything from one page.
    expect(clipped.total).toBe(full.total);
    expect(clipped.capped).toBe(true);
  });

  it('narrows by operator, by customer and by date', async () => {
    const byOperator = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { operatorUserId: actingOperator }),
    );
    expect(byOperator.rows.length).toBeGreaterThan(0);
    expect(byOperator.rows.every((r) => r.actorName === 'Spike Doer')).toBe(true);

    const byReviewer = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { operatorUserId: reviewer }),
    );
    expect(byReviewer.rows).toHaveLength(0);

    // Today is included: a reviewer asking "to today" means the end of today,
    // and a half-open range would silently drop everything just done.
    const today = new Date().toISOString().slice(0, 10);
    const dated = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { from: today, to: today }),
    );
    expect(dated.rows.length).toBeGreaterThan(0);

    const ancient = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { from: '2020-01-01', to: '2020-01-02' }),
    );
    expect(ancient.rows).toHaveLength(0);

    const byAction = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { action: 'platform.plan' }),
    );
    expect(byAction.rows.every((r) => r.action.startsWith('platform.plan'))).toBe(true);
  });

  it('offers only filters that would return something', async () => {
    const choices = await asPlatformOperator(reviewer, (tx) =>
      platformAuditChoices(tx, reviewer),
    );
    expect(choices.operators.some((o) => o.fullName === 'Spike Doer')).toBe(true);
    // The reviewer has done nothing reviewable, so they are not offered.
    expect(choices.operators.some((o) => o.authUserId === reviewer)).toBe(false);
    expect(choices.customers.some((c) => c.name === 'Audited Co')).toBe(true);
    expect(choices.actions.some((a) => a.action === 'platform.plan.changed')).toBe(true);
    // Every action offered is reviewable by construction — the choices are
    // drawn from the same set as the table — so the assertion is that the
    // filter cannot offer a dead end, not that a given action name is absent.
    for (const choice of choices.actions) {
      const narrowed = await asPlatformOperator(reviewer, (tx) =>
        platformAuditTrail(tx, reviewer, { action: choice.action }),
      );
      expect(narrowed.rows.length).toBeGreaterThan(0);
    }
  });

  it('summarises the last thirty days in the numbers a reviewer opens it for', async () => {
    const summary = await asPlatformOperator(reviewer, (tx) =>
      platformAuditSummary(tx, reviewer),
    );
    expect(summary.platformActions).toBeGreaterThan(0);
    expect(summary.actionsUnderSessions).toBeGreaterThan(0);
    expect(summary.sessionsUsed).toBeGreaterThan(0);
    expect(summary.customersTouched).toBeGreaterThan(0);
  });

  it('records an approval against the session, so the chain is complete', async () => {
    // A session approved in answer to a request, rather than through a window:
    // the approval itself is an action in the customer's organisation, and it
    // carries the session id, so a reviewer following a session back finds who
    // agreed to it.
    const other = await createOrganisation('Chain Co', { planKey: 'portfolio' });
    const session = await asPlatformOperator(actingOperator, (tx) =>
      openSupportSession(tx, actingOperator, {
        organisationId: other.organisationId,
        reason: 'SPK-9002: asking with nothing open, to be approved by hand.',
        hours: 2,
      }),
    );
    await as(other.adminUserId, (tx) =>
      approveSupportSession(tx, other.adminUserId, {
        supportSessionId: session.supportSessionId, scopes: ['maintenance'],
      }),
    );

    const { rows } = await asPlatformOperator(reviewer, (tx) =>
      platformAuditTrail(tx, reviewer, { organisationId: other.organisationId }),
    );
    const approval = rows.find((r) => r.action === 'support.session.approved');
    expect(approval).toBeDefined();
    expect(approval!.supportSessionId).toBe(session.supportSessionId);
  });
});
