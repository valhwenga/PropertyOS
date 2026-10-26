import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { DomainError, conflict, notFound, parsed } from './errors';
import { recordAudit } from './audit';
import {
  requirePlatformOperator, requirePlatformPermission, type PlatformPermissionKey,
} from './platform';

/**
 * Spike's own staff, and what each of them may do.
 *
 * Platform authority used to be one boolean: every operator could change any
 * customer's plan, suspend any account, issue Spike's invoices and edit the
 * lease templates every customer inherits. This is the same shape the product
 * already insists on for a landlord's staff — named permissions, collected
 * into roles, resolved on every call against current grants.
 *
 * The boolean on `user_profiles` keeps its meaning: it is the door into the
 * console, and the second-factor requirement lives with it in
 * `app.is_platform_operator()`. A role says what you may do once inside.
 *
 * See docs/decisions/0021-spikes-own-permissions.md.
 */

export interface PlatformRoleRow {
  key: string;
  name: string;
  description: string;
  isAdmin: boolean;
  permissions: PlatformPermissionKey[];
}

/** The platform role catalogue, with what each one carries. */
export async function listPlatformRoles(tx: Sql, authUserId: string): Promise<PlatformRoleRow[]> {
  // Readable by anybody already in the console: an operator is entitled to
  // know what their own role allows, and hiding it makes a refusal look like a
  // fault.
  await requirePlatformOperator(tx, authUserId);

  const rows = await tx<Array<{
    key: string; name: string; description: string; is_admin: boolean;
    permissions: PlatformPermissionKey[];
  }>>`
    select r.key, r.name, r.description, r.is_admin,
           coalesce(array_agg(rp.permission_key order by rp.permission_key)
                      filter (where rp.permission_key is not null), '{}') as permissions
      from platform_roles r
      left join platform_role_permissions rp on rp.role_key = r.key
     group by r.key, r.name, r.description, r.is_admin
     order by r.is_admin desc, r.name
  `;
  return rows.map((r) => ({
    key: r.key, name: r.name, description: r.description,
    isAdmin: r.is_admin, permissions: r.permissions,
  }));
}

export interface OperatorRow {
  authUserId: string;
  fullName: string;
  email: string;
  roles: string[];
  mfaEnrolled: boolean;
  /** True for the viewer's own row, so a screen can refuse to let them cut their own branch. */
  isSelf: boolean;
}

export interface OperatorInvitationRow {
  id: string;
  invitedEmail: string;
  fullName: string;
  roles: string[];
  invitedAt: string;
  expiresAt: string;
  lapsed: boolean;
}

export async function listOperators(
  tx: Sql,
  authUserId: string,
): Promise<{ operators: OperatorRow[]; invitations: OperatorInvitationRow[] }> {
  await requirePlatformOperator(tx, authUserId);

  const operators = await tx<Array<{
    auth_user_id: string; full_name: string; email: string;
    roles: string[]; mfa_enrolled: boolean;
  }>>`
    select p.auth_user_id, p.full_name, p.email::text as email, p.mfa_enrolled,
           coalesce(array_agg(r.role_key order by r.role_key)
                      filter (where r.role_key is not null), '{}') as roles
      from user_profiles p
      left join platform_operator_roles r on r.auth_user_id = p.auth_user_id
     where p.is_platform_operator
     group by p.auth_user_id, p.full_name, p.email, p.mfa_enrolled
     order by p.full_name
  `;

  // Invitations are readable only by the operators who administer people, so
  // this returns none to everybody else rather than refusing the whole page.
  const invitations = await tx<Array<{
    id: string; invited_email: string; full_name: string; roles: string[];
    invited_at: string; expires_at: string; lapsed: boolean;
  }>>`
    select id, invited_email::text as invited_email, full_name, roles,
           invited_at::text, expires_at::text, (expires_at < now()) as lapsed
      from platform_operator_invitations
     where status = 'invited'
     order by invited_at desc
  `;

  return {
    operators: operators.map((o) => ({
      authUserId: o.auth_user_id,
      fullName: o.full_name,
      email: o.email,
      roles: o.roles,
      mfaEnrolled: o.mfa_enrolled,
      isSelf: o.auth_user_id === authUserId,
    })),
    invitations: invitations.map((i) => ({
      id: i.id,
      invitedEmail: i.invited_email,
      fullName: i.full_name,
      roles: i.roles,
      invitedAt: i.invited_at,
      expiresAt: i.expires_at,
      lapsed: i.lapsed,
    })),
  };
}

const rolesInput = z.array(z.string().trim().min(2).max(40)).min(1, 'Choose at least one role.')
  .max(8);

async function assertRolesExist(tx: Sql, roles: string[]): Promise<void> {
  const known = await tx<{ key: string }[]>`
    select key from platform_roles where key = any(${roles})
  `;
  const missing = roles.filter((r) => !known.some((k) => k.key === r));
  if (missing.length > 0) throw notFound(`Platform role ${missing[0]}`);
}

/**
 * Inviting a colleague.
 *
 * Spike staff belong to no organisation, so none of the existing invitation
 * paths can reach them — there is nothing to be a member of. The token is the
 * same shape as every other invitation in the product and is returned once:
 * only its hash is stored.
 */
export async function inviteOperator(
  tx: Sql,
  authUserId: string,
  input: { email: string; fullName: string; roles: string[] },
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const actor = await requirePlatformPermission(tx, authUserId, 'platform.operators.manage');

  const details = parsed(
    z.object({
      email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
      fullName: z.string().trim().min(2, 'Enter their full name.').max(160),
      roles: rolesInput,
    }),
    input,
  );
  await assertRolesExist(tx, details.roles);

  const [already] = await tx<{ auth_user_id: string }[]>`
    select auth_user_id from user_profiles
     where email = ${details.email} and is_platform_operator
  `;
  if (already) {
    throw conflict(
      'That address is already a Spike operator. Change their roles instead of inviting them again.',
    );
  }

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest();
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);

  const [invitation] = await tx<{ id: string }[]>`
    insert into platform_operator_invitations (
      invited_email, full_name, roles, invite_token_hash, invited_by, expires_at
    ) values (
      ${details.email}, ${details.fullName}, ${details.roles}, ${tokenHash},
      ${authUserId}::uuid, ${expiresAt.toISOString()}
    )
    returning id
  `;
  if (!invitation) {
    // The partial unique index: one open invitation per address.
    throw conflict('There is already an open invitation for that address.');
  }

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.operator_invited',
    resourceType: 'platform_operator_invitation',
    resourceId: invitation.id,
    reason: `Invited by ${actor.fullName}.`,
    after: { email: details.email, roles: details.roles },
  });

  return { invitationId: invitation.id, token, expiresAt };
}

export async function withdrawOperatorInvitation(
  tx: Sql,
  authUserId: string,
  invitationId: string,
): Promise<void> {
  await requirePlatformPermission(tx, authUserId, 'platform.operators.manage');

  const withdrawn = await tx<{ id: string }[]>`
    update platform_operator_invitations
       set status = 'withdrawn'
     where id = ${invitationId}::uuid and status = 'invited'
     returning id
  `;
  if (withdrawn.length === 0) {
    throw conflict('That invitation is no longer open. Nothing was changed.');
  }

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.operator_invitation_withdrawn',
    resourceType: 'platform_operator_invitation',
    resourceId: invitationId,
  });
}

/** What the redemption page may say before anybody has signed in. */
export async function describeOperatorInvitation(
  tx: Sql,
  token: string,
): Promise<{ invitedEmail: string; fullName: string; roleNames: string[] } | null> {
  const tokenHash = createHash('sha256').update(token).digest();
  const [row] = await tx<Array<{
    invited_email: string; full_name: string; role_names: string[];
  }>>`
    select i.invited_email::text as invited_email, i.full_name,
           coalesce(array_agg(r.name order by r.name)
                      filter (where r.name is not null), '{}') as role_names
      from platform_operator_invitations i
      left join platform_roles r on r.key = any(i.roles)
     where i.invite_token_hash = ${tokenHash}
       and i.status = 'invited'
       and i.expires_at > now()
     group by i.invited_email, i.full_name
  `;
  if (!row) return null;
  return {
    invitedEmail: row.invited_email,
    fullName: row.full_name,
    roleNames: row.role_names,
  };
}

/**
 * Accepting one.
 *
 * The only path in the product that may set `is_platform_operator`, and it
 * sets it for the address the invitation was issued to and no other. The
 * caller has already proved they hold the password for an existing account, or
 * has just created one — the invitation authorises the role, never the
 * identity.
 */
export async function acceptOperatorInvitation(
  tx: Sql,
  params: { token: string; authUserId: string },
): Promise<{ roles: string[] }> {
  const tokenHash = createHash('sha256').update(params.token).digest();

  const [invitation] = await tx<Array<{
    id: string; invited_email: string; roles: string[]; status: string; expires_at: string;
    invited_by: string;
  }>>`
    select id, invited_email::text as invited_email, roles, status, expires_at::text, invited_by
      from platform_operator_invitations
     where invite_token_hash = ${tokenHash}
     for update
  `;
  const generic = new DomainError(
    'not_found',
    'This invitation is not valid. It may have expired, been withdrawn, or already been used. '
      + 'Ask whoever invited you for a new one.',
  );
  if (!invitation || invitation.status !== 'invited') throw generic;
  if (new Date(invitation.expires_at) < new Date()) throw generic;

  const [profile] = await tx<{ email: string }[]>`
    select email::text as email from user_profiles where auth_user_id = ${params.authUserId}::uuid
  `;
  if (!profile || profile.email.toLowerCase() !== invitation.invited_email.toLowerCase()) {
    // The invitation is for one address. Accepting it as somebody else would
    // make the audit entry a lie about who Spike let in.
    throw generic;
  }

  await tx`
    update user_profiles set is_platform_operator = true, updated_at = now()
     where auth_user_id = ${params.authUserId}::uuid
  `;
  for (const role of invitation.roles) {
    await tx`
      insert into platform_operator_roles (auth_user_id, role_key, granted_by)
      values (${params.authUserId}::uuid, ${role}, ${invitation.invited_by}::uuid)
      on conflict do nothing
    `;
  }
  await tx`
    update platform_operator_invitations
       set status = 'accepted', accepted_at = now(), accepted_by = ${params.authUserId}::uuid
     where id = ${invitation.id}::uuid
  `;

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: params.authUserId,
    action: 'platform.operator_invitation_accepted',
    resourceType: 'platform_operator_invitation',
    resourceId: invitation.id,
    after: { roles: invitation.roles },
  });

  return { roles: invitation.roles };
}

/**
 * Changing what somebody may do.
 *
 * Replaces the whole set rather than adding one at a time, so the screen shows
 * what will be true afterwards. The database refuses a grant to a non-operator
 * and refuses to leave the console with no administrator; this reports both as
 * sentences.
 */
export async function setOperatorRoles(
  tx: Sql,
  authUserId: string,
  input: { operatorUserId: string; roles: string[] },
): Promise<void> {
  const actor = await requirePlatformPermission(tx, authUserId, 'platform.operators.manage');
  const details = parsed(
    z.object({ operatorUserId: z.string().uuid(), roles: rolesInput }),
    input,
  );
  await assertRolesExist(tx, details.roles);

  const [target] = await tx<{ full_name: string; is_platform_operator: boolean }[]>`
    select full_name, is_platform_operator from user_profiles
     where auth_user_id = ${details.operatorUserId}::uuid
  `;
  if (!target) throw notFound('Operator');
  if (!target.is_platform_operator) {
    throw conflict('That person is not a Spike operator.');
  }

  const before = await tx<{ role_key: string }[]>`
    select role_key from platform_operator_roles
     where auth_user_id = ${details.operatorUserId}::uuid
     order by role_key
  `;

  await tx`
    delete from platform_operator_roles
     where auth_user_id = ${details.operatorUserId}::uuid
       and role_key <> all(${details.roles})
  `;
  for (const role of details.roles) {
    await tx`
      insert into platform_operator_roles (auth_user_id, role_key, granted_by)
      values (${details.operatorUserId}::uuid, ${role}, ${authUserId}::uuid)
      on conflict (auth_user_id, role_key) do nothing
    `;
  }

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.operator_roles_changed',
    resourceType: 'platform_operator',
    resourceId: details.operatorUserId,
    reason: `Changed by ${actor.fullName}.`,
    before: { roles: before.map((r) => r.role_key) },
    after: { roles: details.roles, operator: target.full_name },
  });
}

/**
 * Taking the console away from somebody.
 *
 * Their account survives: this is a Spike colleague leaving the team, not a
 * person being deleted, and their name must stay readable on everything they
 * did. The roles go with it, so a later reinstatement starts from nothing
 * rather than from what they held years ago.
 */
export async function revokeOperator(
  tx: Sql,
  authUserId: string,
  operatorUserId: string,
): Promise<void> {
  const actor = await requirePlatformPermission(tx, authUserId, 'platform.operators.manage');
  if (operatorUserId === authUserId) {
    throw conflict(
      'You cannot remove your own console access. Ask another administrator to do it.',
    );
  }

  const [target] = await tx<{ full_name: string; is_platform_operator: boolean }[]>`
    select full_name, is_platform_operator from user_profiles
     where auth_user_id = ${operatorUserId}::uuid
  `;
  if (!target?.is_platform_operator) throw notFound('Operator');

  const before = await tx<{ role_key: string }[]>`
    select role_key from platform_operator_roles
     where auth_user_id = ${operatorUserId}::uuid order by role_key
  `;

  // The trigger refuses to remove the last administrator, so this deletes
  // first and reports that refusal rather than second-guessing it.
  await tx`
    delete from platform_operator_roles where auth_user_id = ${operatorUserId}::uuid
  `;
  await tx`
    update user_profiles set is_platform_operator = false, updated_at = now()
     where auth_user_id = ${operatorUserId}::uuid
  `;

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.operator_revoked',
    resourceType: 'platform_operator',
    resourceId: operatorUserId,
    reason: `Revoked by ${actor.fullName}.`,
    before: { roles: before.map((r) => r.role_key), operator: target.full_name },
    after: { consoleAccess: 'none' },
  });
}
