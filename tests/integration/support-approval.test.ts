import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  approveSupportSession, closeSupportSession, createProperty, createResident,
  grantSupportAccess, openSupportSession, revokeSupportAccessGrant, supportAccessState,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createAuthUser, createOrganisation, ownerSql,
  requestSupportSession, type OrganisationFixture,
} from '../support/factories';

/**
 * Spike reaching a customer's records requires the customer's approval.
 *
 * The product said so in three places — the schema comments, the customer's own
 * screen, the reconciliation document — and the condition was not implemented.
 * An operator inserted a session for themselves and read at once;
 * `support_sessions.authorised_by` was nullable, set by no path, and the
 * customer's history rendered "Not authorised by you" against every session
 * there had ever been.
 *
 * The first test here is the one that would have failed before migration 0065,
 * and it is deliberately asserted on the READ rather than on a flag.
 */
describe('Support access needs the customer', () => {
  let org: OrganisationFixture;
  let operator: string;
  let preparer: string;

  beforeAll(async () => {
    org = await createOrganisation('Approval Co');
    operator = await createAuthUser('Approval Operator', { platformOperator: true });
    preparer = await addMember(org.organisationId, 'Approval Preparer', ['finance_preparer']);
    await as(org.adminUserId, (tx) =>
      createProperty(tx, org.organisationId, org.adminUserId, {
        name: 'Approval Block', code: 'APR', propertyType: 'apartment_block',
        addressLine1: '4 Approval Way', city: 'Pretoria',
      }),
    );
    await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Approval', lastName: 'Resident',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('reaches nothing while it is waiting, and everything the moment it is approved', async () => {
    const session = await as(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'SPK-7001: customer cannot reconcile the March statement',
        hours: 2,
      }),
    );
    expect(session.approved).toBe(false);

    await as(operator, async (tx) => {
      expect(await tx`select id from resident_profiles`).toHaveLength(0);
      expect(await tx`select id from properties`).toHaveLength(0);
    });

    await as(org.adminUserId, (tx) =>
      approveSupportSession(tx, org.adminUserId, { supportSessionId: session.supportSessionId }),
    );

    await as(operator, async (tx) => {
      expect(await tx`select id from resident_profiles`).not.toHaveLength(0);
      expect(await tx`select id from properties`).not.toHaveLength(0);
    });

    // Still read-only. Approval is permission to look, and nothing else.
    await expect(
      as(operator, (tx) =>
        createResident(tx, org.organisationId, operator, {
          firstName: 'Support', lastName: 'Wrote',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await as(org.adminUserId, (tx) =>
      closeSupportSession(tx, org.adminUserId, { supportSessionId: session.supportSessionId }),
    );
    await as(operator, async (tx) => {
      expect(await tx`select id from resident_profiles`).toHaveLength(0);
    });
  });

  it('cannot be approved by the operator who asked for it', async () => {
    const id = await requestSupportSession(org.organisationId, operator);
    // This passed before migration 0066, which is why the migration exists.
    // `support_sessions_platform_update` lets an operator update the session
    // they opened — so that they can revoke it — and policies are OR-ed, so it
    // also let them set `approved_at` and read the customer's records on their
    // own say-so. The trigger in 0066 is the control; row-level security cannot
    // express "may revoke but may not approve", because a policy sees the new
    // row and never which column changed.
    await expect(
      as(operator, (tx) => approveSupportSession(tx, operator, { supportSessionId: id })),
    ).rejects.toThrow(/administrator of this organisation can approve/);

    const [row] = await ownerSql()<{ approved_at: string | null }[]>`
      select approved_at from support_sessions where id = ${id}
    `;
    expect(row!.approved_at).toBeNull();
  });

  it('cannot be approved by a member without the permission, and says so', async () => {
    const id = await requestSupportSession(org.organisationId, operator);
    await expect(
      as(preparer, (tx) => approveSupportSession(tx, preparer, { supportSessionId: id })),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const [row] = await ownerSql()<{ approved_at: string | null }[]>`
      select approved_at from support_sessions where id = ${id}
    `;
    expect(row!.approved_at).toBeNull();
  });

  it('declining leaves the request in the record rather than erasing it', async () => {
    const id = await requestSupportSession(org.organisationId, operator);
    await as(org.adminUserId, (tx) =>
      closeSupportSession(tx, org.adminUserId, { supportSessionId: id }),
    );
    const state = await as(org.adminUserId, (tx) =>
      supportAccessState(tx, org.organisationId),
    );
    const row = state.sessions.find((s) => s.id === id)!;
    expect(row.revokedAt).not.toBeNull();
    expect(row.approvedAt).toBeNull();   // declined, not approved and then ended
    expect(row.waiting).toBe(false);
    expect(row.live).toBe(false);
  });
});

describe('Letting support in in advance', () => {
  let org: OrganisationFixture;
  let operator: string;
  let preparer: string;

  beforeAll(async () => {
    org = await createOrganisation('Window Co');
    operator = await createAuthUser('Window Operator', { platformOperator: true });
    preparer = await addMember(org.organisationId, 'Window Preparer', ['finance_preparer']);
    await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Window', lastName: 'Resident',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('approves a session as it arrives, and records which window let it in', async () => {
    await as(org.adminUserId, (tx) =>
      grantSupportAccess(tx, org.organisationId, org.adminUserId, {
        hours: 4, reason: 'Raising a query about the March statement',
      }),
    );

    const session = await as(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'SPK-7100: looking at the March statement as agreed',
        hours: 2,
      }),
    );
    expect(session.approved).toBe(true);

    await as(operator, async (tx) => {
      expect(await tx`select id from resident_profiles`).not.toHaveLength(0);
    });

    const state = await as(org.adminUserId, (tx) =>
      supportAccessState(tx, org.organisationId),
    );
    const row = state.sessions.find((s) => s.id === session.supportSessionId)!;
    expect(row.approvedViaGrant).toBe(true);
    // Attributed to the person who opened the window, not to Spike.
    expect(row.authorisedByName).toContain('Approval Co Admin'.slice(0, 0) + 'Window Co Admin');
    expect(state.openWindow?.sessionsOpened).toBe(1);
  });

  it('never lets a session outlast the window that approved it', async () => {
    // A one-hour window and an eight-hour request: the window wins.
    const narrow = await createOrganisation('Narrow Window Co');
    await as(narrow.adminUserId, (tx) =>
      grantSupportAccess(tx, narrow.organisationId, narrow.adminUserId, {
        hours: 1, reason: 'One hour only, please',
      }),
    );
    const session = await as(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: narrow.organisationId,
        reason: 'SPK-7101: asking for eight hours inside a one-hour window',
        hours: 8,
      }),
    );
    expect(session.approved).toBe(true);
    // Within a minute of the hour, not eight hours out.
    expect(session.expiresAt.getTime()).toBeLessThan(Date.now() + 61 * 60_000);
  });

  it('closing the window stops new sessions and says what is still open', async () => {
    const state = await as(org.adminUserId, (tx) =>
      supportAccessState(tx, org.organisationId),
    );
    const result = await as(org.adminUserId, (tx) =>
      revokeSupportAccessGrant(tx, org.adminUserId, { grantId: state.openWindow!.id }),
    );
    // Honest about the consequence: the window is shut, and the session opened
    // under it is a separate record that is still live until it is ended.
    expect(result.sessionsStillLive).toBe(1);

    const next = await as(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'SPK-7102: asking again after the window closed',
        hours: 2,
      }),
    );
    expect(next.approved).toBe(false);
  });

  it('cannot be manufactured by the operator who would benefit from it', async () => {
    // The other half of the approval control. A window approves sessions on
    // arrival, so an operator who could insert one could admit themselves —
    // and the insert policy requires the customer's own permission AND
    // `authorised_by = auth.uid()`, which an operator cannot satisfy in either
    // half.
    await expect(
      as(operator, (tx) => tx`
        insert into support_access_grants (organisation_id, authorised_by, reason, expires_at)
        values (${org.organisationId}::uuid, ${operator}::uuid, 'Letting myself in',
                now() + interval '4 hours')
      `),
    ).rejects.toThrow(/row-level security|permission denied/i);

    const [row] = await ownerSql()<{ n: string }[]>`
      select count(*)::text as n from support_access_grants
       where organisation_id = ${org.organisationId} and authorised_by = ${operator}
    `;
    expect(row!.n).toBe('0');
  });

  it('refuses a member without the permission, in both directions', async () => {
    await expect(
      as(preparer, (tx) =>
        grantSupportAccess(tx, org.organisationId, preparer, {
          hours: 4, reason: 'Trying to let support in without the permission',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const grant = await as(org.adminUserId, (tx) =>
      grantSupportAccess(tx, org.organisationId, org.adminUserId, {
        hours: 4, reason: 'A window for the preparer to fail to close',
      }),
    );
    // Not "forbidden" but "not found", and that is the right answer: the
    // window's own select policy is the same permission, so to a member without
    // it the row does not exist. Telling them it exists and they may not touch
    // it would be the leak.
    await expect(
      as(preparer, (tx) =>
        revokeSupportAccessGrant(tx, preparer, { grantId: grant.grantId }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
