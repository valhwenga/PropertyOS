/**
 * What a role can do, and the one thing a customer can be given extra.
 *
 * `roles`, `permissions` and `role_permissions` were reference data with no
 * screen: support could not answer "why can't our portfolio manager approve
 * that?" without reading SQL, and a customer who wanted their managers to do
 * one more thing had to be told no, because the only lever changed it for
 * every customer at once.
 *
 * What these tests pin, in the order the design depends on them:
 *
 *   1. an extra permission works — the whole point;
 *   2. it is confined to the customer it was granted to;
 *   3. it ALWAYS needs a second factor, because `requires_mfa` describes the
 *      role and an override can put an elevated permission on a role that has
 *      no such requirement;
 *   4. it can only ever grant, so no row here can lock a customer out;
 *   5. the customer can see what Spike granted, because otherwise this is a
 *      back door however good the audit trail is.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createStandaloneHouse, grantRolePermission, organisationPermissionOverrides,
  permissionCatalogue, recordExpense, revokeRolePermission,
} from '@propertyos/domain';
import {
  addMember, as, asPlatformOperator, asSingleFactor, closeOwner, createAuthUser,
  createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

async function createOperator(name: string, roles = ['platform_admin']): Promise<string> {
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

describe('what a role can do', () => {
  let org: OrganisationFixture;
  let other: OrganisationFixture;
  let operator: string;
  let manager: string;
  let otherManager: string;
  let propertyId: string;

  beforeAll(async () => {
    org = await createOrganisation('Catalogue Co', { planKey: 'portfolio' });
    other = await createOrganisation('Untouched Co', { planKey: 'portfolio' });
    operator = await createOperator('Spike Cataloguer');

    // A property manager: the role carries `expense.record` nowhere, which is
    // what makes it the right subject for a grant.
    manager = await addMember(org.organisationId, 'Pat Manager', ['property_manager']);
    otherManager = await addMember(other.organisationId, 'Other Manager', ['property_manager']);

    const property = await as(org.adminUserId, (tx) => createStandaloneHouse(
      tx, org.organisationId, org.adminUserId, {
        name: 'Catalogue House', code: 'CAT', propertyType: 'house',
        addressLine1: '5 Catalogue Street', city: 'Cape Town',
      },
    ));
    propertyId = property.propertyId;
  });

  afterAll(async () => { await closeOwner(); });

  it('says what every role carries, and which permissions no role does', async () => {
    const { roles, permissions } = await asPlatformOperator(operator, (tx) =>
      permissionCatalogue(tx, operator),
    );

    const admin = roles.find((r) => r.key === 'org_admin')!;
    expect(admin.requiresMfa).toBe(true);
    expect(admin.permissions).toContain('membership.manage');
    // The seed gives org_admin everything except Spike's own.
    expect(admin.permissions).not.toContain('platform.admin');

    const propertyManager = roles.find((r) => r.key === 'property_manager')!;
    expect(propertyManager.permissions).toContain('maintenance.manage');
    expect(propertyManager.permissions).not.toContain('expense.record');

    // Which roles carry a permission is the question support is really asked,
    // so it is answered from the permission's side too.
    const expense = permissions.find((p) => p.key === 'expense.record')!;
    expect(expense.roles).toContain('finance_preparer');
    expect(expense.roles).not.toContain('property_manager');

    // And whether a customer could let a support session do it, which is a
    // different question with a different answer.
    expect(permissions.find((p) => p.key === 'maintenance.manage')!.grantableToSupport)
      .toBe(true);
    expect(permissions.find((p) => p.key === 'payment.reverse')!.grantableToSupport)
      .toBe(false);

    // Spike's own permission IS carried by a role — `spike_operator`, from the
    // original seed — and what makes that safe is not the grants but
    // `assignable_to_staff`: no customer administrator can hand it out. The
    // catalogue surfaces that, because "why is spike_operator in this list?"
    // is the first question an operator reading the page will have.
    expect(permissions.find((p) => p.key === 'platform.admin')!.roles)
      .toEqual(['spike_operator']);
    expect(roles.find((r) => r.key === 'spike_operator')!.assignableToStaff).toBe(false);
    expect(roles.find((r) => r.key === 'org_admin')!.assignableToStaff).toBe(true);
    // And the grant path refuses it regardless, which the trigger test covers.
  });

  it('refuses the manager the thing they have not been given', async () => {
    await expect(
      as(manager, (tx) =>
        recordExpense(tx, org.organisationId, manager, {
          propertyId, category: 'repairs_maintenance', amountMinor: 150_000n,
          expenseDate: '2026-10-01', description: 'Before the grant.',
        }),
      ),
    ).rejects.toThrow(/expense.record/);
  });

  it('grants one customer’s role one extra permission, and it works', async () => {
    await asPlatformOperator(operator, (tx) =>
      grantRolePermission(tx, operator, {
        organisationId: org.organisationId,
        roleKey: 'property_manager',
        permissionKey: 'expense.record',
        reason: 'SPK-7700: their managers buy materials and the owner wants it that way.',
      }),
    );

    const expense = await as(manager, (tx) =>
      recordExpense(tx, org.organisationId, manager, {
        propertyId, category: 'repairs_maintenance', amountMinor: 150_000n,
        expenseDate: '2026-10-01', description: 'After the grant.',
      }),
    );
    expect(expense.expenseId).toBeTruthy();
  });

  it('gives it to that customer only', async () => {
    // The same role, at a different customer, is untouched. This is the whole
    // reason the override exists rather than a migration.
    await expect(
      as(otherManager, (tx) =>
        recordExpense(tx, other.organisationId, otherManager, {
          propertyId, category: 'repairs_maintenance', amountMinor: 1000n,
          expenseDate: '2026-10-01', description: 'Should be refused.',
        }),
      ),
    ).rejects.toThrow();
  });

  it('always needs a second factor, whatever the role requires', async () => {
    // `property_manager` has `requires_mfa = false`, so the base path would
    // hand this out on a password alone. The override branch does not: MFA
    // describes the ROLE in this schema, and a permission somebody asked for
    // by email should not be easier to exercise than one the product shipped.
    const [role] = await ownerSql()<{ requires_mfa: boolean }[]>`
      select requires_mfa from roles where key = 'property_manager'
    `;
    expect(role!.requires_mfa).toBe(false);

    await expect(
      asSingleFactor(manager, (tx) =>
        recordExpense(tx, org.organisationId, manager, {
          propertyId, category: 'repairs_maintenance', amountMinor: 1000n,
          expenseDate: '2026-10-01', description: 'On a password alone.',
        }),
      ),
    ).rejects.toThrow();

    // And what the role carries on its own still works on one factor, so this
    // is the override being stricter rather than the role being broken.
    const tickets = await asSingleFactor(manager, (tx) =>
      tx`select id from maintenance_tickets limit 1`,
    );
    expect(Array.isArray(tickets)).toBe(true);
  });

  it('shows the customer what Spike granted them', async () => {
    // Their own administrator, reading their own account. Without this the
    // feature is a back door however complete the audit trail is.
    const seen = await as(org.adminUserId, (tx) =>
      organisationPermissionOverrides(tx, org.organisationId),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.roleName).toBe('Property manager');
    expect(seen[0]!.permissionKey).toBe('expense.record');
    expect(seen[0]!.reason).toContain('SPK-7700');
    expect(seen[0]!.grantedByName).toBe('Spike Cataloguer');

    // And a different customer sees nothing of it.
    const strangers = await as(other.adminUserId, (tx) =>
      organisationPermissionOverrides(tx, other.organisationId),
    );
    expect(strangers).toHaveLength(0);
  });

  it('cannot grant Spike’s own permission, or one the role already has', async () => {
    await expect(
      asPlatformOperator(operator, (tx) =>
        grantRolePermission(tx, operator, {
          organisationId: org.organisationId,
          roleKey: 'property_manager',
          permissionKey: 'platform.admin',
          reason: 'Trying it on, which should fail.',
        }),
      ),
    ).rejects.toThrow(/belongs to Spike/i);

    await expect(
      asPlatformOperator(operator, (tx) =>
        grantRolePermission(tx, operator, {
          organisationId: org.organisationId,
          roleKey: 'property_manager',
          permissionKey: 'maintenance.manage',
          reason: 'Already carried everywhere, so this is noise.',
        }),
      ),
    ).rejects.toThrow(/already/i);
  });

  it('keeps the write to operators who hold the permission for it', async () => {
    const support = await createOperator('Spike Support Only', ['platform_support']);
    await expect(
      asPlatformOperator(support, (tx) =>
        grantRolePermission(tx, support, {
          organisationId: org.organisationId,
          roleKey: 'property_manager',
          permissionKey: 'deposit.read',
          reason: 'Support should not be able to do this.',
        }),
      ),
    ).rejects.toThrow(/platform role does not include this/i);

    // And the table refuses it on the ordinary connection too, so the check is
    // not only in the command.
    await expect(
      as(support, (tx) => tx`
        insert into organisation_role_permissions (
          organisation_id, role_key, permission_key, reason, granted_by
        ) values (
          ${org.organisationId}, 'property_manager', 'deposit.read',
          'Writing it directly, which should fail.', ${support}::uuid
        )
      `),
    ).rejects.toThrow();

    // A support operator can still READ the catalogue: answering a customer's
    // question about their own roles is the most ordinary thing support does.
    const catalogue = await asPlatformOperator(support, (tx) =>
      permissionCatalogue(tx, support),
    );
    expect(catalogue.roles.length).toBeGreaterThan(0);
  });

  it('takes it back without taking anything else away', async () => {
    await asPlatformOperator(operator, (tx) =>
      revokeRolePermission(tx, operator, {
        organisationId: org.organisationId,
        roleKey: 'property_manager',
        permissionKey: 'expense.record',
        reason: 'SPK-7700 closed; they changed their mind.',
      }),
    );

    await expect(
      as(manager, (tx) =>
        recordExpense(tx, org.organisationId, manager, {
          propertyId, category: 'repairs_maintenance', amountMinor: 1000n,
          expenseDate: '2026-10-01', description: 'After the revoke.',
        }),
      ),
    ).rejects.toThrow(/expense.record/);

    // The floor is unchanged: what the role carries in the catalogue is still
    // theirs, which is the point of grants-only.
    const stillTheirs = await as(manager, (tx) =>
      tx`select id from maintenance_tickets limit 1`,
    );
    expect(Array.isArray(stillTheirs)).toBe(true);

    // Revoking something they do not have is a refusal, not a silent success.
    await expect(
      asPlatformOperator(operator, (tx) =>
        revokeRolePermission(tx, operator, {
          organisationId: org.organisationId,
          roleKey: 'property_manager',
          permissionKey: 'expense.record',
          reason: 'Already gone, so this should refuse.',
        }),
      ),
    ).rejects.toThrow(/does not have/i);
  });

  it('records both decisions against the customer they changed', async () => {
    const trail = await ownerSql()<{ action: string; reason: string }[]>`
      select action, reason from audit_events
       where organisation_id = ${org.organisationId}
         and action like 'platform.role_permission%'
       order by occurred_at
    `;
    expect(trail.map((t) => t.action)).toEqual([
      'platform.role_permission_granted',
      'platform.role_permission_revoked',
    ]);
    // Against the customer, so it reads in the trail somebody reviewing that
    // customer would open — not in a platform-only log beside it.
    expect(trail[0]!.reason).toContain('SPK-7700');
  });
});
