import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound, parsed } from './errors';
import { requireEntitlement } from './entitlements';
import { requirePermission } from './permissions';

/**
 * Colleagues.
 *
 * Roles, permissions and the per-role second-factor requirement have existed
 * since the eighth migration. There was no way to add a colleague: no command,
 * no screen, nothing. An organisation was created with exactly one member, and
 * every test that needed a second one inserted the rows on a privileged
 * connection — so the separation of duties the whole system is built around, a
 * preparer who is not the approver, could not be set up by the customer at
 * all.
 *
 * Two rules worth stating because they are easy to get wrong.
 *
 * A pending invitation grants NOTHING. The roles are applied when it is
 * accepted, not when it is sent, so an invitation sitting in a mailbox is not
 * a membership and revoking one takes nothing away.
 *
 * Nobody can raise their own access, and the last administrator cannot be
 * removed. The first is how a single compromised account becomes a compromised
 * organisation; the second is how a customer locks themselves out of their own
 * records with no way back in that does not involve Spike.
 */

export interface StaffMember {
  membershipId: string;
  authUserId: string;
  fullName: string | null;
  email: string | null;
  status: 'invited' | 'active' | 'suspended' | 'revoked';
  roles: string[];
  /** Whether any of their roles needs a second factor before it takes effect. */
  requiresMfa: boolean;
  /** True once they have actually enrolled one. */
  hasMfa: boolean;
  scope: {
    type: 'organisation' | 'portfolio' | 'property' | 'none';
    label: string | null;
    /** So a form can preselect what is already set rather than defaulting wider. */
    propertyId: string | null;
  };
  isSelf: boolean;
}

export interface StaffInvitation {
  id: string;
  invitedEmail: string;
  fullName: string;
  roles: string[];
  status: 'invited' | 'accepted' | 'revoked' | 'expired';
  scope: { type: string; label: string | null };
  invitedByName: string | null;
  invitedAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokeReason: string | null;
  /** True when the expiry has passed but nothing has marked it yet. */
  lapsed: boolean;
}

export interface AssignableRole {
  key: string;
  name: string;
  description: string;
  requiresMfa: boolean;
}

/** The roles a customer may confer, read from the database rather than listed here. */
export async function assignableRoles(tx: Sql): Promise<AssignableRole[]> {
  const rows = await tx<
    { key: string; name: string; description: string; requires_mfa: boolean }[]
  >`
    select key, name, description, requires_mfa from roles
     where assignable_to_staff
     order by key
  `;
  return rows.map((r) => ({
    key: r.key, name: r.name, description: r.description, requiresMfa: r.requires_mfa,
  }));
}

export async function listStaff(
  tx: Sql, organisationId: string, viewerAuthUserId: string,
): Promise<StaffMember[]> {
  await requirePermission(tx, organisationId, 'membership.manage');

  const rows = await tx<
    { membership_id: string; auth_user_id: string; full_name: string | null;
      email: string | null; status: string; roles: string[] | null;
      requires_mfa: boolean; has_mfa: boolean; scope_type: string | null;
      scope_label: string | null; scope_property_id: string | null }[]
  >`
    select m.id as membership_id, m.auth_user_id, up.full_name, up.email::text as email,
           m.status::text,
           coalesce(array_agg(distinct mr.role_key)
                    filter (where mr.role_key is not null), '{}') as roles,
           coalesce(bool_or(r.requires_mfa), false) as requires_mfa,
           -- Through a function that returns only the fact of enrolment.
           -- auth_mfa_factors holds TOTP secrets and is deliberately
           -- unreadable by the application role; reading it here would
           -- break that boundary to answer a yes-or-no question.
           app.has_verified_mfa(m.auth_user_id) as has_mfa,
           min(pa.scope_type) as scope_type,
           min(coalesce(p.name, pf.name)) as scope_label,
           min(pa.property_id::text) as scope_property_id
      from memberships m
      left join user_profiles up on up.auth_user_id = m.auth_user_id
      left join membership_roles mr on mr.membership_id = m.id
      left join roles r on r.key = mr.role_key
      left join property_assignments pa on pa.membership_id = m.id
      left join properties p on p.id = pa.property_id
      left join portfolios pf on pf.id = pa.portfolio_id
     where m.organisation_id = ${organisationId}::uuid
     group by m.id, m.auth_user_id, up.full_name, up.email, m.status
     order by up.full_name nulls last
  `;

  return rows.map((r) => ({
    membershipId: r.membership_id,
    authUserId: r.auth_user_id,
    fullName: r.full_name,
    email: r.email,
    status: r.status as StaffMember['status'],
    roles: r.roles ?? [],
    requiresMfa: r.requires_mfa,
    hasMfa: r.has_mfa,
    scope: {
      type: (r.scope_type ?? 'none') as StaffMember['scope']['type'],
      label: r.scope_label,
      propertyId: r.scope_property_id,
    },
    isSelf: r.auth_user_id === viewerAuthUserId,
  }));
}

export async function listStaffInvitations(
  tx: Sql, organisationId: string,
): Promise<StaffInvitation[]> {
  await requirePermission(tx, organisationId, 'membership.manage');

  const rows = await tx<
    { id: string; invited_email: string; full_name: string; roles: string[];
      status: string; scope_type: string; scope_label: string | null;
      invited_by_name: string | null; invited_at: string; expires_at: string;
      accepted_at: string | null; revoke_reason: string | null; lapsed: boolean }[]
  >`
    select i.id, i.invited_email::text as invited_email, i.full_name, i.roles, i.status,
           i.scope_type, coalesce(p.name, pf.name) as scope_label,
           up.full_name as invited_by_name,
           i.invited_at::text, i.expires_at::text, i.accepted_at::text, i.revoke_reason,
           (i.status = 'invited' and i.expires_at < now()) as lapsed
      from staff_invitations i
      left join properties p on p.id = i.property_id
      left join portfolios pf on pf.id = i.portfolio_id
      left join user_profiles up on up.auth_user_id = i.invited_by
     where i.organisation_id = ${organisationId}::uuid
     order by i.invited_at desc
     limit 200
  `;

  return rows.map((r) => ({
    id: r.id,
    invitedEmail: r.invited_email,
    fullName: r.full_name,
    roles: r.roles,
    status: r.status as StaffInvitation['status'],
    scope: { type: r.scope_type, label: r.scope_label },
    invitedByName: r.invited_by_name,
    invitedAt: r.invited_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    revokeReason: r.revoke_reason,
    lapsed: r.lapsed,
  }));
}

/* -------------------------------------------------------------------------- */
/* Inviting                                                                   */
/* -------------------------------------------------------------------------- */

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  fullName: z.string().trim().min(2).max(160),
  roles: z.array(z.string().trim().min(1)).min(1, 'Choose at least one role.').max(8),
  scope: z.discriminatedUnion('type', [
    z.object({ type: z.literal('organisation') }),
    z.object({ type: z.literal('property'), propertyId: z.string().uuid() }),
    z.object({ type: z.literal('portfolio'), portfolioId: z.string().uuid() }),
  ]),
  expiryDays: z.number().int().min(1).max(30).optional(),
});

/**
 * Invites a colleague.
 *
 * Returns the token ONCE. It is stored only as a hash, so this is the single
 * moment it exists in readable form: a leaked database does not hand over a way
 * in, and nobody — including Spike — can recover it afterwards to let somebody
 * in quietly.
 *
 * No email is sent from here and none is claimed to be. The caller decides
 * whether to send it through the configured adapter or hand the link over in
 * person, and the screen says which happened rather than displaying a
 * reassuring "invitation sent" over an adapter that delivered nothing.
 */
export async function inviteStaff(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof inviteSchema>,
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  await requirePermission(tx, organisationId, 'membership.manage');
  const i = parsed(inviteSchema, input);
  // The plan's staff allowance. Counted over members and unaccepted
  // invitations together, so a cap cannot be walked past by inviting ten
  // people and letting them accept later.
  await requireEntitlement(tx, organisationId, 'staff_accounts');

  // Only roles the product means to hand out, and only ones that exist. A
  // typo would otherwise produce a membership with a role nothing grants.
  const allowed = await assignableRoles(tx);
  const allowedKeys = new Set(allowed.map((r) => r.key));
  const rejected = i.roles.filter((r) => !allowedKeys.has(r));
  if (rejected.length > 0) {
    throw invalid(
      `${rejected.join(', ')} cannot be given to a colleague. Spike's own role and the `
        + 'resident and contractor portal roles are not assignable here.',
    );
  }

  // Already a member? Then this is a role change, not an invitation, and
  // saying so is more useful than a unique-violation.
  // Matched on either address: somebody invited as one address may well have
  // signed in with an account carrying another, and inviting them a second
  // time would produce a second membership for one person.
  const [existing] = await tx<{ status: string; full_name: string | null }[]>`
    select m.status::text, up.full_name
      from memberships m
      left join user_profiles up on up.auth_user_id = m.auth_user_id
     where m.organisation_id = ${organisationId}::uuid
       and (up.email = ${i.email} or m.invited_email = ${i.email})
  `;
  if (existing) {
    throw new DomainError(
      'duplicate',
      `${existing.full_name ?? i.email} is already ${existing.status === 'active'
        ? 'a member of this organisation' : `on this organisation as "${existing.status}"`}. `
        + 'Change their roles or reinstate them rather than inviting them again.',
    );
  }

  if (i.scope.type === 'property') {
    const [owned] = await tx<{ id: string }[]>`
      select id from properties
       where id = ${i.scope.propertyId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    if (!owned) throw notFound('Property');
  }
  if (i.scope.type === 'portfolio') {
    const [owned] = await tx<{ id: string }[]>`
      select id from portfolios
       where id = ${i.scope.portfolioId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    if (!owned) throw notFound('Portfolio');
  }

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest();
  const expiresAt = new Date(Date.now() + (i.expiryDays ?? 7) * 86_400_000);

  try {
    const [row] = await tx<{ id: string }[]>`
      insert into staff_invitations (
        organisation_id, invited_email, full_name, roles, scope_type,
        property_id, portfolio_id, invite_token_hash, invited_by, expires_at
      ) values (
        ${organisationId}, ${i.email}, ${i.fullName}, ${i.roles}, ${i.scope.type},
        ${i.scope.type === 'property' ? i.scope.propertyId : null},
        ${i.scope.type === 'portfolio' ? i.scope.portfolioId : null},
        ${tokenHash}, ${actorUserId}, ${expiresAt.toISOString()}
      )
      returning id
    `;
    if (!row) throw new DomainError('internal', 'Invitation insert returned no row.');

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'staff.invited', resourceType: 'staff_invitation', resourceId: row.id,
      // The token is never written here or anywhere else.
      after: {
        invitedEmail: i.email, roles: i.roles, scopeType: i.scope.type,
        expiresAt: expiresAt.toISOString(),
        // Said plainly: an invitation is not access.
        grantsAccessNow: false,
      },
    });

    return { invitationId: row.id, token, expiresAt };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const mapped = fromDatabaseError(error);
    if (mapped.code === 'duplicate') {
      throw new DomainError(
        'duplicate',
        `There is already an open invitation for ${i.email}. Revoke it before issuing another, `
          + 'so there is never more than one live link for one person.',
      );
    }
    throw mapped;
  }
}

export async function revokeStaffInvitation(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { invitationId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'membership.manage');
  const reason = parsed(
    z.string().trim().min(5, 'Say why the invitation is being withdrawn.').max(500),
    input.reason,
  );

  const [invitation] = await tx<{ id: string; status: string; invited_email: string }[]>`
    select id, status, invited_email::text as invited_email from staff_invitations
     where id = ${input.invitationId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!invitation) throw notFound('Invitation');
  if (invitation.status !== 'invited') {
    throw new DomainError(
      'conflict',
      `That invitation is already ${invitation.status}.`
        + (invitation.status === 'accepted'
          ? ' Suspend the member instead; revoking the invitation would not take their access away.'
          : ''),
    );
  }

  await tx`
    update staff_invitations
       set status = 'revoked', revoked_at = now(), revoked_by = ${actorUserId},
           revoke_reason = ${reason},
           -- The token stops working the moment it is withdrawn.
           invite_token_hash = null
     where id = ${input.invitationId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'staff.invitation_revoked', resourceType: 'staff_invitation',
    resourceId: input.invitationId, reason,
    after: { invitedEmail: invitation.invited_email },
  });
}

/**
 * Redeems an invitation.
 *
 * Runs on a privileged connection, because the recipient has no session yet
 * and no membership to be scoped by. It is narrowly scoped in return: it can
 * only ever bind ONE auth user to the single invitation whose token hash
 * matches, and it consumes the token in doing so.
 *
 * A wrong, expired, revoked or already-used token all produce the same answer,
 * so the endpoint cannot be used to find out whether an address was invited.
 */
export async function acceptStaffInvitation(
  tx: Sql,
  params: { token: string; authUserId: string },
): Promise<{ organisationId: string; membershipId: string; roles: string[] }> {
  const tokenHash = createHash('sha256').update(params.token).digest();

  const [invitation] = await tx<
    { id: string; organisation_id: string; invited_email: string; roles: string[];
      scope_type: string; property_id: string | null; portfolio_id: string | null;
      status: string; expires_at: string }[]
  >`
    select id, organisation_id, invited_email::text as invited_email, roles, scope_type,
           property_id, portfolio_id, status, expires_at::text
      from staff_invitations
     where invite_token_hash = ${tokenHash}
     for update
  `;
  const generic = new DomainError(
    'not_found',
    'This invitation is not valid. It may have expired, been withdrawn, or already been used. '
      + 'Ask whoever invited you for a new one.',
  );
  if (!invitation || invitation.status !== 'invited') throw generic;
  if (new Date(invitation.expires_at) < new Date()) {
    // Deliberately writes nothing. Marking it expired here and then throwing
    // would roll the marking back with the rest of the transaction, so the
    // code would look like it tidied up and would not have. `expires_at` is
    // the only thing that decides whether a token works, and the listing
    // reports a lapsed invitation from the same column.
    throw generic;
  }

  // One account, one membership. Accepting twice from two accounts would leave
  // the organisation unable to say who the invitation was for.
  const [already] = await tx<{ id: string }[]>`
    select id from memberships
     where organisation_id = ${invitation.organisation_id}::uuid
       and auth_user_id = ${params.authUserId}::uuid
  `;
  if (already) {
    throw new DomainError(
      'conflict', 'You are already a member of this organisation.',
    );
  }

  const [membership] = await tx<{ id: string }[]>`
    insert into memberships (organisation_id, auth_user_id, status, invited_email)
    values (
      ${invitation.organisation_id}, ${params.authUserId}, 'active',
      ${invitation.invited_email}
    )
    returning id
  `;
  if (!membership) throw new DomainError('internal', 'Membership insert returned no row.');

  for (const role of invitation.roles) {
    await tx`
      insert into membership_roles (membership_id, role_key)
      values (${membership.id}, ${role})
    `;
  }
  await tx`
    insert into property_assignments (
      organisation_id, membership_id, scope_type, property_id, portfolio_id
    ) values (
      ${invitation.organisation_id}, ${membership.id}, ${invitation.scope_type},
      ${invitation.property_id}, ${invitation.portfolio_id}
    )
  `;

  await tx`
    update staff_invitations
       set status = 'accepted', accepted_at = now(),
           accepted_user_id = ${params.authUserId},
           invite_token_hash = null
     where id = ${invitation.id}::uuid
  `;

  await recordAudit(tx, {
    organisationId: invitation.organisation_id,
    actorUserId: params.authUserId,
    action: 'staff.invitation_accepted', resourceType: 'membership',
    resourceId: membership.id,
    after: { roles: invitation.roles, scopeType: invitation.scope_type },
  });

  return {
    organisationId: invitation.organisation_id,
    membershipId: membership.id,
    roles: invitation.roles,
  };
}

/** What an invitation is for, read before anybody signs in to accept it. */
export async function describeStaffInvitation(
  tx: Sql, token: string,
): Promise<{
  organisationName: string;
  fullName: string;
  invitedEmail: string;
  roles: string[];
  expiresAt: string;
} | undefined> {
  const tokenHash = createHash('sha256').update(token).digest();
  const [row] = await tx<
    { organisation_name: string; full_name: string; invited_email: string;
      roles: string[]; expires_at: string }[]
  >`
    select o.name as organisation_name, i.full_name,
           i.invited_email::text as invited_email, i.roles, i.expires_at::text
      from staff_invitations i
      join organisations o on o.id = i.organisation_id
     where i.invite_token_hash = ${tokenHash}
       and i.status = 'invited'
       and i.expires_at > now()
  `;
  if (!row) return undefined;
  return {
    organisationName: row.organisation_name,
    fullName: row.full_name,
    invitedEmail: row.invited_email,
    roles: row.roles,
    expiresAt: row.expires_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Changing what a colleague may do                                           */
/* -------------------------------------------------------------------------- */

async function loadMembership(
  tx: Sql, organisationId: string, membershipId: string,
): Promise<{ id: string; authUserId: string; status: string; roles: string[]; name: string }> {
  const [row] = await tx<
    { id: string; auth_user_id: string; status: string; roles: string[] | null;
      full_name: string | null; email: string | null }[]
  >`
    select m.id, m.auth_user_id, m.status::text,
           coalesce(array_agg(mr.role_key) filter (where mr.role_key is not null), '{}') as roles,
           up.full_name, up.email::text as email
      from memberships m
      left join membership_roles mr on mr.membership_id = m.id
      left join user_profiles up on up.auth_user_id = m.auth_user_id
     where m.id = ${membershipId}::uuid and m.organisation_id = ${organisationId}::uuid
     group by m.id, m.auth_user_id, m.status, up.full_name, up.email
  `;
  if (!row) throw notFound('Member');
  return {
    id: row.id,
    authUserId: row.auth_user_id,
    status: row.status,
    roles: row.roles ?? [],
    name: row.full_name ?? row.email ?? 'that member',
  };
}

/**
 * How many administrators are left who could still sign in.
 *
 * A suspended administrator cannot act, so counting them would let the last
 * usable one be removed on the grounds that a suspended colleague still holds
 * the role.
 */
async function activeAdminCount(tx: Sql, organisationId: string): Promise<number> {
  const [row] = await tx<{ total: string }[]>`
    select count(distinct m.id)::text as total
      from memberships m
      join membership_roles mr on mr.membership_id = m.id
     where m.organisation_id = ${organisationId}::uuid
       and m.status = 'active'
       and mr.role_key = 'org_admin'
  `;
  return Number(row?.total ?? '0');
}

export async function changeMemberRoles(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { membershipId: string; roles: string[]; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'membership.manage');
  const reason = parsed(
    z.string().trim().min(5, 'Say why the roles are changing.').max(500),
    input.reason,
  );
  const roles = parsed(
    z.array(z.string().trim().min(1)).min(1, 'A member needs at least one role.').max(8),
    input.roles,
  );

  const member = await loadMembership(tx, organisationId, input.membershipId);

  // Nobody raises their own access. This is how one compromised account
  // becomes a compromised organisation, and an administrator who genuinely
  // needs a different role has a colleague who can give it to them.
  if (member.authUserId === actorUserId) {
    throw new DomainError(
      'forbidden',
      'You cannot change your own roles. Ask another administrator to do it.',
    );
  }

  const allowed = await assignableRoles(tx);
  const allowedKeys = new Set(allowed.map((r) => r.key));
  const rejected = roles.filter((r) => !allowedKeys.has(r));
  if (rejected.length > 0) {
    throw invalid(`${rejected.join(', ')} cannot be given to a colleague.`);
  }

  // Taking the administrator role off the last one who has it locks the
  // customer out of their own records, with no way back that does not involve
  // Spike reaching into their data.
  const losingAdmin = member.roles.includes('org_admin') && !roles.includes('org_admin');
  if (losingAdmin && member.status === 'active' && await activeAdminCount(tx, organisationId) <= 1) {
    throw new DomainError(
      'conflict',
      `${member.name} is the only active administrator. Give somebody else that role first, `
        + 'otherwise nobody could manage this organisation afterwards.',
    );
  }

  await tx`delete from membership_roles where membership_id = ${input.membershipId}::uuid`;
  for (const role of roles) {
    await tx`
      insert into membership_roles (membership_id, role_key)
      values (${input.membershipId}, ${role})
    `;
  }

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'staff.roles_changed', resourceType: 'membership',
    resourceId: input.membershipId, reason,
    before: { roles: member.roles },
    after: { roles },
  });
}

/**
 * Suspends a colleague.
 *
 * Suspension is not deletion: the membership stays, its roles stay, and
 * everything the person did stays attributed to them. §3 is explicit about it,
 * and an audit trail whose actors could be deleted would be worth very little.
 */
export async function suspendMember(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { membershipId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'membership.manage');
  const reason = parsed(
    z.string().trim().min(5, 'Say why access is being suspended.').max(500),
    input.reason,
  );

  const member = await loadMembership(tx, organisationId, input.membershipId);
  if (member.authUserId === actorUserId) {
    throw new DomainError(
      'forbidden',
      'You cannot suspend your own access. Ask another administrator to do it.',
    );
  }
  if (member.status === 'suspended') {
    throw new DomainError('conflict', `${member.name} is already suspended.`);
  }
  if (member.roles.includes('org_admin') && await activeAdminCount(tx, organisationId) <= 1) {
    throw new DomainError(
      'conflict',
      `${member.name} is the only active administrator. Suspending them would leave nobody `
        + 'able to manage this organisation.',
    );
  }

  await tx`
    update memberships set status = 'suspended', updated_at = now()
     where id = ${input.membershipId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'staff.suspended', resourceType: 'membership',
    resourceId: input.membershipId, reason,
    before: { status: member.status },
    // Said plainly, because "suspended" is often read as "removed".
    after: { status: 'suspended', rolesRetained: member.roles, recordsRetained: true },
  });
}

export async function reinstateMember(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { membershipId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'membership.manage');
  const reason = parsed(z.string().trim().min(5).max(500), input.reason);

  const member = await loadMembership(tx, organisationId, input.membershipId);
  if (member.status !== 'suspended') {
    throw new DomainError('conflict', `${member.name} is not suspended.`);
  }

  await tx`
    update memberships set status = 'active', updated_at = now()
     where id = ${input.membershipId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'staff.reinstated', resourceType: 'membership',
    resourceId: input.membershipId, reason,
    before: { status: 'suspended' }, after: { status: 'active', roles: member.roles },
  });
}

/** Changes which properties a colleague can reach. */
export async function setMemberScope(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: {
    membershipId: string;
    scope: { type: 'organisation' } | { type: 'property'; propertyId: string }
      | { type: 'portfolio'; portfolioId: string };
    reason: string;
  },
): Promise<void> {
  await requirePermission(tx, organisationId, 'membership.manage');
  const reason = parsed(
    z.string().trim().min(5, 'Say why the scope is changing.').max(500),
    input.reason,
  );

  const member = await loadMembership(tx, organisationId, input.membershipId);
  if (member.authUserId === actorUserId) {
    throw new DomainError(
      'forbidden',
      'You cannot change your own scope. Ask another administrator to do it.',
    );
  }

  const [before] = await tx<{ scope_type: string; property_id: string | null }[]>`
    select scope_type, property_id from property_assignments
     where membership_id = ${input.membershipId}::uuid
     limit 1
  `;

  if (input.scope.type === 'property') {
    const [owned] = await tx<{ id: string }[]>`
      select id from properties
       where id = ${input.scope.propertyId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    if (!owned) throw notFound('Property');
  }
  if (input.scope.type === 'portfolio') {
    const [owned] = await tx<{ id: string }[]>`
      select id from portfolios
       where id = ${input.scope.portfolioId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    if (!owned) throw notFound('Portfolio');
  }

  await tx`delete from property_assignments where membership_id = ${input.membershipId}::uuid`;
  await tx`
    insert into property_assignments (
      organisation_id, membership_id, scope_type, property_id, portfolio_id
    ) values (
      ${organisationId}, ${input.membershipId}, ${input.scope.type},
      ${input.scope.type === 'property' ? input.scope.propertyId : null},
      ${input.scope.type === 'portfolio' ? input.scope.portfolioId : null}
    )
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'staff.scope_changed', resourceType: 'membership',
    resourceId: input.membershipId, reason,
    before: { scopeType: before?.scope_type ?? null, propertyId: before?.property_id ?? null },
    after: { scopeType: input.scope.type },
  });
}
