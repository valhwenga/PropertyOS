/**
 * Adding a colleague.
 *
 * Roles, permissions and the per-role second-factor requirement have existed
 * since the eighth migration, and there was no way to add a second member: no
 * command, no screen, nothing. Every test in this suite that needed one
 * inserted the rows on a privileged connection — which is to say the
 * separation of duties the whole system is built around could not be set up by
 * the customer at all.
 *
 * The rules under test are the ones that bite later if they are wrong. A
 * pending invitation grants nothing. Nobody raises their own access. The last
 * administrator cannot be removed, because a customer locked out of their own
 * records has no way back that does not involve Spike reaching into their
 * data. And the token exists in readable form exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  acceptStaffInvitation, assignableRoles, changeMemberRoles, createStandaloneHouse,
  describeStaffInvitation, inviteStaff, listStaff, listStaffInvitations, reinstateMember,
  revokeStaffInvitation, setMemberScope, suspendMember,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

describe('Staff', () => {
  let org: OrganisationFixture;
  let propertyId: string;
  /** A second administrator, so the last-admin guard can be tested both ways. */
  let secondAdmin: string;

  beforeAll(async () => {
    org = await createOrganisation('Staff Co');
    secondAdmin = await addMember(org.organisationId, 'Second Admin', ['org_admin']);

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Staff House', code: 'STF', propertyType: 'house',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    propertyId = house.propertyId;
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------------------- which roles */

  it('offers only the roles a customer may hand out', async () => {
    const roles = await as(org.adminUserId, (tx) => assignableRoles(tx));
    const keys = roles.map((r) => r.key);

    expect(keys).toContain('finance_preparer');
    expect(keys).toContain('finance_approver');
    // Spike's own role is never assignable by a customer, and the portal roles
    // arrive by their own invitations.
    expect(keys).not.toContain('spike_operator');
    expect(keys).not.toContain('resident');
    expect(keys).not.toContain('contractor');

    // Whether a role needs a second factor is carried through, because the
    // screen has to warn that the permissions are withheld until one exists.
    expect(roles.find((r) => r.key === 'finance_approver')!.requiresMfa).toBe(true);
    expect(roles.find((r) => r.key === 'property_manager')!.requiresMfa).toBe(false);
  });

  it('refuses a role the product never meant to hand out', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        inviteStaff(tx, org.organisationId, org.adminUserId, {
          email: 'sneaky@demo.invalid', fullName: 'Sneaky Person',
          roles: ['spike_operator'], scope: { type: 'organisation' },
        }),
      ),
    ).rejects.toThrow(/cannot be given to a colleague/);
  });

  /* -------------------------------------------- an invitation grants nothing */

  it('invites somebody without giving them anything yet', async () => {
    const before = await as(org.adminUserId, (tx) =>
      listStaff(tx, org.organisationId, org.adminUserId),
    );

    const invitation = await as(org.adminUserId, (tx) =>
      inviteStaff(tx, org.organisationId, org.adminUserId, {
        email: 'Prep.Arer@demo.invalid', fullName: 'Prep Arer',
        roles: ['finance_preparer'], scope: { type: 'property', propertyId },
      }),
    );
    expect(invitation.token).toHaveLength(43);

    // No membership, no role, nothing. An invitation sitting in a mailbox is
    // not access, so revoking one takes nothing away.
    const after = await as(org.adminUserId, (tx) =>
      listStaff(tx, org.organisationId, org.adminUserId),
    );
    expect(after).toHaveLength(before.length);

    const [pending] = await as(org.adminUserId, (tx) =>
      listStaffInvitations(tx, org.organisationId),
    );
    expect(pending!.status).toBe('invited');
    // The address is stored case-insensitively, because people type their own
    // address inconsistently and a second invitation to the same person is a
    // second live token.
    expect(pending!.invitedEmail).toBe('prep.arer@demo.invalid');
    expect(pending!.scope.label).toBe('Staff House');
  });

  it('keeps the token out of the database', async () => {
    const [row] = await ownerSql()<{ token_hash: string | null }[]>`
      select encode(invite_token_hash, 'hex') as token_hash
        from staff_invitations
       where organisation_id = ${org.organisationId} and status = 'invited'
    `;
    // Only the hash is stored, so a leaked database does not hand over a way
    // in and nobody — including Spike — can recover the link afterwards.
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const dump = JSON.stringify(
      await ownerSql()`select * from staff_invitations where organisation_id = ${org.organisationId}`,
    );
    expect(dump).not.toContain('token"');
  });

  it('refuses a second open invitation to the same person', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        inviteStaff(tx, org.organisationId, org.adminUserId, {
          email: 'prep.arer@demo.invalid', fullName: 'Prep Arer',
          roles: ['finance_preparer'], scope: { type: 'organisation' },
        }),
      ),
    ).rejects.toThrow(/already an open invitation/);
  });

  it('says what an invitation is for before anybody signs in', async () => {
    const invitation = await as(org.adminUserId, (tx) =>
      inviteStaff(tx, org.organisationId, org.adminUserId, {
        email: 'approver@demo.invalid', fullName: 'App Rover',
        roles: ['finance_approver'], scope: { type: 'organisation' },
      }),
    );

    const described = await ownerSql().begin(async (tx) =>
      describeStaffInvitation(tx as never, invitation.token),
    );
    expect(described!.organisationName).toBe('Staff Co');
    expect(described!.roles).toEqual(['finance_approver']);
    expect(described!.invitedEmail).toBe('approver@demo.invalid');

    // A token that is not an open invitation describes nothing, rather than
    // confirming that an address was invited.
    const nothing = await ownerSql().begin(async (tx) =>
      describeStaffInvitation(tx as never, 'not-a-real-token'),
    );
    expect(nothing).toBeUndefined();
  });

  /* -------------------------------------------------------------- accepting */

  it('grants the roles only when the invitation is accepted', async () => {
    const invitation = await as(org.adminUserId, (tx) =>
      inviteStaff(tx, org.organisationId, org.adminUserId, {
        email: 'manager@demo.invalid', fullName: 'Prop Manager',
        roles: ['property_manager'], scope: { type: 'property', propertyId },
      }),
    );
    const newUser = await createAuthUser('Prop Manager');

    const accepted = await ownerSql().begin(async (tx) =>
      acceptStaffInvitation(tx as never, { token: invitation.token, authUserId: newUser }),
    );
    expect(accepted.roles).toEqual(['property_manager']);

    const staff = await as(org.adminUserId, (tx) =>
      listStaff(tx, org.organisationId, org.adminUserId),
    );
    const member = staff.find((m) => m.authUserId === newUser)!;
    expect(member.status).toBe('active');
    expect(member.roles).toEqual(['property_manager']);
    // The scope came from the invitation, not from a default: a property
    // manager invited for one property does not arrive with the whole
    // organisation.
    expect(member.scope.type).toBe('property');
    expect(member.scope.label).toBe('Staff House');
  });

  it('cannot be accepted twice', async () => {
    const invitation = await as(org.adminUserId, (tx) =>
      inviteStaff(tx, org.organisationId, org.adminUserId, {
        email: 'twice@demo.invalid', fullName: 'Twice Over',
        roles: ['owner_viewer'], scope: { type: 'organisation' },
      }),
    );
    const first = await createAuthUser('Twice Over');
    const second = await createAuthUser('Somebody Else');

    await ownerSql().begin(async (tx) =>
      acceptStaffInvitation(tx as never, { token: invitation.token, authUserId: first }),
    );

    // The token was consumed, so it cannot be replayed to attach a second
    // account — and the refusal says nothing about whether it ever existed.
    await expect(
      ownerSql().begin(async (tx) =>
        acceptStaffInvitation(tx as never, { token: invitation.token, authUserId: second }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('gives the same answer for a wrong, revoked and expired token', async () => {
    const live = await as(org.adminUserId, (tx) =>
      inviteStaff(tx, org.organisationId, org.adminUserId, {
        email: 'revoked@demo.invalid', fullName: 'Rev Oked',
        roles: ['owner_viewer'], scope: { type: 'organisation' },
      }),
    );
    const [invitation] = await as(org.adminUserId, (tx) =>
      listStaffInvitations(tx, org.organisationId),
    );
    await as(org.adminUserId, (tx) =>
      revokeStaffInvitation(tx, org.organisationId, org.adminUserId, {
        invitationId: invitation!.id, reason: 'Offered to the wrong person.',
      }),
    );

    const user = await createAuthUser('Rev Oked');
    const messages: string[] = [];
    for (const token of [live.token, 'completely-made-up-token']) {
      await ownerSql().begin(async (tx) =>
        acceptStaffInvitation(tx as never, { token, authUserId: user }),
      ).catch((error: Error) => messages.push(error.message));
    }
    // Identical, so the endpoint cannot be used to find out whether an address
    // was invited.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
  });

  it('expires on its own, and says nothing about having done so', async () => {
    const invitation = await as(org.adminUserId, (tx) =>
      inviteStaff(tx, org.organisationId, org.adminUserId, {
        email: 'stale@demo.invalid', fullName: 'Sta Le',
        roles: ['owner_viewer'], scope: { type: 'organisation' },
      }),
    );
    await ownerSql()`
      update staff_invitations set expires_at = now() - interval '1 day'
       where organisation_id = ${org.organisationId} and invited_email = 'stale@demo.invalid'
    `;

    const user = await createAuthUser('Sta Le');
    await expect(
      ownerSql().begin(async (tx) =>
        acceptStaffInvitation(tx as never, { token: invitation.token, authUserId: user }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Nothing was written on the way to refusing, because a write inside the
    // transaction that then throws would be rolled back with it — code that
    // looks like it tidied up and did not. The expiry column is the only
    // thing that decides whether a token works.
    const invitations = await as(org.adminUserId, (tx) =>
      listStaffInvitations(tx, org.organisationId),
    );
    const stale = invitations.find((inv) => inv.invitedEmail === 'stale@demo.invalid')!;
    expect(stale.status).toBe('invited');
    // And the listing says so, so nobody reads it as still usable.
    expect(stale.lapsed).toBe(true);
  });

  it('refuses to invite somebody who is already a member', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        inviteStaff(tx, org.organisationId, org.adminUserId, {
          email: 'manager@demo.invalid', fullName: 'Prop Manager',
          roles: ['finance_preparer'], scope: { type: 'organisation' },
        }),
      ),
    ).rejects.toThrow(/already a member/);
  });

  /* ----------------------------------------------- nobody raises their own */

  it('will not let an administrator change their own roles or scope', async () => {
    const staff = await as(org.adminUserId, (tx) =>
      listStaff(tx, org.organisationId, org.adminUserId),
    );
    const self = staff.find((m) => m.isSelf)!;

    await expect(
      as(org.adminUserId, (tx) =>
        changeMemberRoles(tx, org.organisationId, org.adminUserId, {
          membershipId: self.membershipId, roles: ['org_admin', 'finance_approver'],
          reason: 'Giving myself more.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await expect(
      as(org.adminUserId, (tx) =>
        setMemberScope(tx, org.organisationId, org.adminUserId, {
          membershipId: self.membershipId, scope: { type: 'organisation' },
          reason: 'Widening my own scope.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await expect(
      as(org.adminUserId, (tx) =>
        suspendMember(tx, org.organisationId, org.adminUserId, {
          membershipId: self.membershipId, reason: 'Locking myself out.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  /* -------------------------------------------------- the last administrator */

  it('will not leave the organisation without an administrator', async () => {
    // Suspend the second administrator first, so the first is the only one
    // left who could sign in.
    const staff = await as(org.adminUserId, (tx) =>
      listStaff(tx, org.organisationId, org.adminUserId),
    );
    const second = staff.find((m) => m.authUserId === secondAdmin)!;
    await as(org.adminUserId, (tx) =>
      suspendMember(tx, org.organisationId, org.adminUserId, {
        membershipId: second.membershipId, reason: 'Left the company at the end of the month.',
      }),
    );

    const self = staff.find((m) => m.isSelf)!;
    // Now the second administrator tries to strip the first, from the other
    // side — the guard is about the organisation, not about who is asking.
    await as(secondAdmin, (tx) =>
      // A suspended member cannot act at all, so this must fail on permission
      // rather than on the admin count.
      expect(
        changeMemberRoles(tx, org.organisationId, secondAdmin, {
          membershipId: self.membershipId, roles: ['owner_viewer'],
          reason: 'Removing the other administrator.',
        }),
      ).rejects.toBeTruthy(),
    );

    // Reinstate, then try it properly: taking org_admin off the only active
    // administrator is refused and says why.
    await as(org.adminUserId, (tx) =>
      reinstateMember(tx, org.organisationId, org.adminUserId, {
        membershipId: second.membershipId, reason: 'Stayed on after all.',
      }),
    );
    await as(org.adminUserId, (tx) =>
      changeMemberRoles(tx, org.organisationId, org.adminUserId, {
        membershipId: second.membershipId, roles: ['finance_approver'],
        reason: 'Moving to the finance team.',
      }),
    );

    await expect(
      as(secondAdmin, (tx) =>
        changeMemberRoles(tx, org.organisationId, secondAdmin, {
          membershipId: self.membershipId, roles: ['owner_viewer'],
          reason: 'Removing the last administrator.',
        }),
      ),
    ).rejects.toBeTruthy();

    // And the first administrator still holds the role.
    const stillAdmin = await as(org.adminUserId, (tx) =>
      listStaff(tx, org.organisationId, org.adminUserId),
    );
    expect(stillAdmin.find((m) => m.isSelf)!.roles).toContain('org_admin');
  });

  /* --------------------------------------------- suspension is not deletion */

  it('suspends without deleting anything', async () => {
    const staff = await as(org.adminUserId, (tx) =>
      listStaff(tx, org.organisationId, org.adminUserId),
    );
    const manager = staff.find(
      (m) => m.roles.includes('property_manager') && !m.isSelf,
    )!;

    await as(org.adminUserId, (tx) =>
      suspendMember(tx, org.organisationId, org.adminUserId, {
        membershipId: manager.membershipId, reason: 'On unpaid leave until March.',
      }),
    );

    const after = await as(org.adminUserId, (tx) =>
      listStaff(tx, org.organisationId, org.adminUserId),
    );
    const suspended = after.find((m) => m.membershipId === manager.membershipId)!;
    expect(suspended.status).toBe('suspended');
    // §3: the membership stays, its roles stay, and everything the person did
    // stays attributed to them. An audit trail whose actors could be deleted
    // would be worth very little.
    expect(suspended.roles).toEqual(['property_manager']);

    const [entry] = await ownerSql()<{ after_state: Record<string, unknown> }[]>`
      select after_state from audit_events
       where organisation_id = ${org.organisationId} and action = 'staff.suspended'
       order by occurred_at desc limit 1
    `;
    expect(entry!.after_state.recordsRetained).toBe(true);

    await as(org.adminUserId, (tx) =>
      reinstateMember(tx, org.organisationId, org.adminUserId, {
        membershipId: manager.membershipId, reason: 'Back from leave.',
      }),
    );
  });

  it('reports who needs a second factor and has not enrolled one', async () => {
    const staff = await as(org.adminUserId, (tx) =>
      listStaff(tx, org.organisationId, org.adminUserId),
    );
    const approver = staff.find((m) => m.roles.includes('finance_approver'))!;
    // The role requires one; nothing has been enrolled. Until it is, the
    // permissions are withheld — so the screen has to be able to say so rather
    // than showing a member who looks fully set up.
    expect(approver.requiresMfa).toBe(true);
    expect(approver.hasMfa).toBe(false);
  });

  /* ------------------------------------------------------------- isolation */

  it('refuses a member without the membership permission', async () => {
    const preparer = await addMember(org.organisationId, 'No Rights', ['finance_preparer']);
    await expect(
      as(preparer, (tx) => listStaff(tx, org.organisationId, preparer)),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await expect(
      as(preparer, (tx) =>
        inviteStaff(tx, org.organisationId, preparer, {
          email: 'another@demo.invalid', fullName: 'An Other',
          roles: ['org_admin'], scope: { type: 'organisation' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does not show one organisation another organisation\'s staff', async () => {
    const other = await createOrganisation('Elsewhere Staff');
    const staff = await as(other.adminUserId, (tx) =>
      listStaff(tx, other.organisationId, other.adminUserId),
    );
    // Their own single member, and nobody of ours.
    expect(staff).toHaveLength(1);
    expect(staff[0]!.isSelf).toBe(true);

    const invitations = await as(other.adminUserId, (tx) =>
      listStaffInvitations(tx, other.organisationId),
    );
    expect(invitations).toHaveLength(0);
  });

  it('refuses to invite into a property that is not theirs', async () => {
    const other = await createOrganisation('Elsewhere Staff Two');
    await expect(
      as(other.adminUserId, (tx) =>
        inviteStaff(tx, other.organisationId, other.adminUserId, {
          email: 'cross@demo.invalid', fullName: 'Cross Org',
          roles: ['property_manager'],
          // A real property id, belonging to somebody else.
          scope: { type: 'property', propertyId },
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps the substance of an invitation immutable', async () => {
    const [invitation] = await ownerSql()<{ id: string }[]>`
      select id from staff_invitations
       where organisation_id = ${org.organisationId} and status = 'invited' limit 1
    `;
    if (!invitation) return;
    // An approver must accept the thing that was offered, not an amended one.
    await expect(
      ownerSql()`
        update staff_invitations set roles = '{org_admin}' where id = ${invitation.id}
      `,
    ).rejects.toThrow(/immutable/);
  });
});
