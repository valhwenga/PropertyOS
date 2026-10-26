import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { conflict, notFound, parsed } from './errors';
import { recordAudit } from './audit';
import { requirePlatformOperator, requirePlatformPermission } from './platform';

/**
 * What every role can do, and the one thing a customer can be given extra.
 *
 * `roles`, `permissions` and `role_permissions` have been reference data since
 * the first migration — seeded by migrations, written by nothing, shown
 * nowhere. Two consequences: support could not answer "why can't our portfolio
 * manager approve that?" without reading SQL, and a customer who wanted their
 * managers to do one more thing had to be told no, because the only lever was
 * a migration changing it for every customer at once.
 *
 * The catalogue here is the answer to the first. `grantRolePermission` is the
 * answer to the second, and it is deliberately the smaller lever: one extra
 * permission, one role, one organisation, always MFA-gated, never a revoke.
 *
 * See docs/decisions/0024-what-a-role-can-do.md.
 */

export interface CatalogueRole {
  key: string;
  name: string;
  description: string;
  requiresMfa: boolean;
  /**
   * Whether a customer's administrator can give this role to a colleague.
   *
   * The reason the catalogue shows it: `spike_operator` carries
   * `platform.admin` and `resident` and `contractor` exist for people who are
   * not staff, so "why is that in the list?" has an answer, and an operator
   * reading the catalogue can see that the one role carrying Spike's own
   * permission is one no customer can hand out.
   */
  assignableToStaff: boolean;
  permissions: string[];
  /** How many customers have been given something extra on this role. */
  overrides: number;
}

export interface CataloguePermission {
  key: string;
  description: string;
  /** Which roles carry it everywhere. Empty means no role does. */
  roles: string[];
  /** Whether a customer may let a Spike support session exercise it. */
  grantableToSupport: boolean;
  /** How many customers have been given it on a role that does not carry it. */
  overrides: number;
}

/**
 * The whole catalogue, for the screen that answers "what can this role do".
 *
 * Readable by any operator in the console rather than by holders of
 * `platform.permissions.manage`: answering a customer's question about their
 * own roles is the most ordinary thing support does, and a reference table
 * nobody can read is how "ask an engineer" becomes the process.
 */
export async function permissionCatalogue(
  tx: Sql,
  authUserId: string,
): Promise<{ roles: CatalogueRole[]; permissions: CataloguePermission[] }> {
  await requirePlatformOperator(tx, authUserId);

  const roles = await tx<Array<{
    key: string; name: string; description: string; requires_mfa: boolean;
    assignable_to_staff: boolean; permissions: string[]; overrides: string;
  }>>`
    select r.key, r.name, r.description, r.requires_mfa, r.assignable_to_staff,
           coalesce(array_agg(rp.permission_key order by rp.permission_key)
                      filter (where rp.permission_key is not null), '{}') as permissions,
           (select count(distinct orp.organisation_id)
              from organisation_role_permissions orp
             where orp.role_key = r.key)::text as overrides
      from roles r
      left join role_permissions rp on rp.role_key = r.key
     group by r.key, r.name, r.description, r.requires_mfa, r.assignable_to_staff
     order by r.assignable_to_staff desc, r.key
  `;

  const permissions = await tx<Array<{
    key: string; description: string; roles: string[];
    grantable_to_support: boolean; overrides: string;
  }>>`
    select p.key, p.description,
           coalesce(array_agg(rp.role_key order by rp.role_key)
                      filter (where rp.role_key is not null), '{}') as roles,
           app.support_grantable_permission(p.key) as grantable_to_support,
           (select count(*) from organisation_role_permissions orp
             where orp.permission_key = p.key)::text as overrides
      from permissions p
      left join role_permissions rp on rp.permission_key = p.key
     group by p.key, p.description
     order by p.key
  `;

  return {
    roles: roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      requiresMfa: r.requires_mfa,
      assignableToStaff: r.assignable_to_staff,
      permissions: r.permissions,
      overrides: Number(r.overrides),
    })),
    permissions: permissions.map((p) => ({
      key: p.key,
      description: p.description,
      roles: p.roles,
      grantableToSupport: p.grantable_to_support,
      overrides: Number(p.overrides),
    })),
  };
}

export interface RolePermissionOverride {
  roleKey: string;
  roleName: string;
  permissionKey: string;
  permissionDescription: string;
  reason: string;
  grantedByName: string | null;
  grantedAt: string;
}

/**
 * The extra permissions one customer has.
 *
 * Readable by the customer's own members as well as by Spike — the policy says
 * so — because Spike widening what a landlord's staff may do, with the
 * landlord unable to see it, would be a back door whatever the audit trail
 * said.
 */
export async function organisationPermissionOverrides(
  tx: Sql,
  organisationId: string,
): Promise<RolePermissionOverride[]> {
  const rows = await tx<Array<{
    role_key: string; role_name: string; permission_key: string;
    permission_description: string; reason: string; granted_by_name: string | null;
    granted_at: string;
  }>>`
    select orp.role_key, r.name as role_name, orp.permission_key,
           p.description as permission_description, orp.reason,
           by.full_name as granted_by_name, orp.granted_at::text
      from organisation_role_permissions orp
      join roles r on r.key = orp.role_key
      join permissions p on p.key = orp.permission_key
      left join user_profiles by on by.auth_user_id = orp.granted_by
     where orp.organisation_id = ${organisationId}::uuid
     order by r.name, orp.permission_key
  `;
  return rows.map((r) => ({
    roleKey: r.role_key,
    roleName: r.role_name,
    permissionKey: r.permission_key,
    permissionDescription: r.permission_description,
    reason: r.reason,
    grantedByName: r.granted_by_name,
    grantedAt: r.granted_at,
  }));
}

const overrideSchema = z.object({
  organisationId: z.string().uuid(),
  roleKey: z.string().trim().min(2).max(40),
  permissionKey: z.string().trim().min(2).max(60),
  reason: z.string().trim()
    .min(5, 'Say who asked for this and why, so it is reviewable later.').max(500),
});

/**
 * Giving one customer's role one extra permission.
 *
 * Grants only. There is no revoke in this module beyond removing a grant it
 * made, which is why no combination of rows here can lock a customer out of
 * their own account. What a customer wants taken away they do by not assigning
 * the role.
 *
 * The database refuses `platform.admin` and refuses a permission the role
 * already carries everywhere; both arrive here as sentences rather than as
 * raw errors.
 */
export async function grantRolePermission(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof overrideSchema>,
): Promise<void> {
  const actor = await requirePlatformPermission(
    tx, authUserId, 'platform.permissions.manage',
  );
  const details = parsed(overrideSchema, input);

  const [role] = await tx<{ key: string; name: string }[]>`
    select key, name from roles where key = ${details.roleKey}
  `;
  if (!role) throw notFound('Role');
  const [permission] = await tx<{ key: string }[]>`
    select key from permissions where key = ${details.permissionKey}
  `;
  if (!permission) throw notFound('Permission');

  const [organisation] = await tx<{ name: string }[]>`
    select name from organisations where id = ${details.organisationId}::uuid
  `;
  if (!organisation) throw notFound('Customer');

  const [existing] = await tx<{ permission_key: string }[]>`
    select permission_key from organisation_role_permissions
     where organisation_id = ${details.organisationId}::uuid
       and role_key = ${details.roleKey}
       and permission_key = ${details.permissionKey}
  `;
  if (existing) {
    throw conflict(`Every ${role.name} at this customer already has that.`);
  }

  await tx`
    insert into organisation_role_permissions (
      organisation_id, role_key, permission_key, reason, granted_by
    ) values (
      ${details.organisationId}::uuid, ${details.roleKey}, ${details.permissionKey},
      ${details.reason}, ${authUserId}::uuid
    )
  `;

  // Audited against the CUSTOMER rather than against no organisation: this
  // changes what their own staff may do, so it belongs in the trail somebody
  // reviewing that customer would read.
  await recordAudit(tx, {
    organisationId: details.organisationId,
    actorUserId: authUserId,
    action: 'platform.role_permission_granted',
    resourceType: 'role',
    resourceId: null,
    reason: details.reason,
    after: {
      role: details.roleKey,
      permission: details.permissionKey,
      grantedBy: actor.fullName,
      // Said in the record, because it is the thing that makes the grant
      // safe and nobody reading this later should have to go and check.
      secondFactorRequired: true,
    },
  });
}

/**
 * Taking an extra permission back.
 *
 * This removes a GRANT, which returns the role to what every other customer's
 * version of it can do. It cannot take away anything the role carries in the
 * catalogue, so the floor is the same before and after.
 */
export async function revokeRolePermission(
  tx: Sql,
  authUserId: string,
  input: { organisationId: string; roleKey: string; permissionKey: string; reason: string },
): Promise<void> {
  const actor = await requirePlatformPermission(
    tx, authUserId, 'platform.permissions.manage',
  );
  const details = parsed(overrideSchema, input);

  const removed = await tx<{ permission_key: string }[]>`
    delete from organisation_role_permissions
     where organisation_id = ${details.organisationId}::uuid
       and role_key = ${details.roleKey}
       and permission_key = ${details.permissionKey}
     returning permission_key
  `;
  if (removed.length === 0) {
    throw conflict('That customer does not have that extra permission. Nothing was changed.');
  }

  await recordAudit(tx, {
    organisationId: details.organisationId,
    actorUserId: authUserId,
    action: 'platform.role_permission_revoked',
    resourceType: 'role',
    resourceId: null,
    reason: details.reason,
    before: { role: details.roleKey, permission: details.permissionKey },
    after: { revokedBy: actor.fullName },
  });
}
