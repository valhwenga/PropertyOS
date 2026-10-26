/**
 * Spike's own staff, and what each of them may do.
 *
 * "Platform operator" was one boolean, so every operator could change any
 * customer's plan, suspend any account, issue Spike's invoices and edit the
 * lease templates every customer inherits — and the only way to make somebody
 * an operator was an UPDATE typed into psql. A product that insists a
 * landlord's staff hold scoped, named roles cannot run its own staff on a flag.
 *
 * What these tests pin:
 *   * the migration locks nobody out — an existing operator keeps everything;
 *   * a narrower role is actually narrower, in the DOMAIN and in the POLICIES,
 *     because a check in one layer only is the arrangement this schema refuses
 *     to rely on anywhere else;
 *   * the console cannot be left without an administrator, and nobody can cut
 *     their own branch off;
 *   * an invitation is the only way in, and it admits one address.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  acceptOperatorInvitation, changePlan, describeOperatorInvitation, inviteOperator,
  listCustomers, listOperators, listPlatformRoles, openSupportSession,
  platformPermissionsOf, provisionCustomer, revokeOperator, saveBillingSettings,
  setOperatorRoles,
} from '@propertyos/domain';
import {
  as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

/** A Spike operator with a second factor and the roles named. */
async function createOperator(name: string, roles: string[]): Promise<string> {
  const authUserId = await createAuthUser(name);
  await ownerSql()`
    update user_profiles set is_platform_operator = true where auth_user_id = ${authUserId}
  `;
  await ownerSql()`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
    values (${authUserId}, 'totp', 'JBSWY3DPEHPK3PXP', now())
    on conflict (auth_user_id, factor_type) do update set verified_at = now()
  `;
  for (const role of roles) {
    await ownerSql()`
      insert into platform_operator_roles (auth_user_id, role_key)
      values (${authUserId}, ${role}) on conflict do nothing
    `;
  }
  return authUserId;
}

describe('platform operator roles', () => {
  let admin: string;
  let support: string;
  let viewer: string;
  let customer: OrganisationFixture;
  let stamp: string;

  beforeAll(async () => {
    stamp = Date.now().toString(36);
    admin = await createOperator('Spike Admin', ['platform_admin']);
    support = await createOperator('Spike Support Agent', ['platform_support']);
    viewer = await createOperator('Spike Analyst', ['platform_viewer']);
    customer = await createOrganisation(`Roleplay Co ${stamp}`, { planKey: 'portfolio' });
  });

  afterAll(async () => { await closeOwner(); });

  it('backfills every operator the migration found, so nobody is locked out', async () => {
    // The demo operator predates this work: it must still hold everything,
    // because the alternative is a console Spike cannot enter after a deploy.
    const [seeded] = await ownerSql()<{ auth_user_id: string }[]>`
      select p.auth_user_id from user_profiles p
       where p.email = 'support@demo.invalid' and p.is_platform_operator
    `;
    if (seeded) {
      const held = await asPlatformOperator(seeded.auth_user_id, (tx) =>
        platformPermissionsOf(tx, seeded.auth_user_id),
      );
      expect(held).toContain('platform.operators.manage');
    }

    const mine = await asPlatformOperator(admin, (tx) => platformPermissionsOf(tx, admin));
    expect(mine).toContain('platform.customers.plan');
    expect(mine).toContain('platform.billing.manage');
  });

  it('lets a support operator read the accounts', async () => {
    const customers = await asPlatformOperator(support, (tx) => listCustomers(tx, support));
    expect(customers.length).toBeGreaterThan(0);
    // Still metadata only: the support session machinery is what reaches
    // records, and a role carries no part of that.
    expect(Object.keys(customers[0]!)).not.toContain('residents');
  });

  it('refuses a support operator the commercial decisions', async () => {
    await expect(
      asPlatformOperator(support, (tx) =>
        changePlan(tx, support, {
          organisationId: customer.organisationId, planKey: 'starter',
          reason: 'Trying it on.',
        }),
      ),
    ).rejects.toThrow(/platform role does not include this/i);

    await expect(
      asPlatformOperator(support, (tx) =>
        saveBillingSettings(tx, support, {
          legalName: 'Not Spike', address: 'Nowhere', email: 'x@example.invalid',
        }),
      ),
    ).rejects.toThrow(/platform role does not include this/i);

    await expect(
      asPlatformOperator(support, (tx) =>
        provisionCustomer(tx, support, {
          name: 'Sneaky Co', slug: `sneaky-${stamp}`, legalEntityName: 'Sneaky (Pty) Ltd',
          planKey: 'starter',
          administrator: { fullName: 'Nobody At All', email: `nobody-${stamp}@example.invalid` },
          reason: 'Should not be allowed.',
        }),
      ),
    ).rejects.toThrow(/platform role does not include this/i);
  });

  it('refuses a read-only operator the right to ask for access', async () => {
    await expect(
      asPlatformOperator(viewer, (tx) =>
        openSupportSession(tx, viewer, {
          organisationId: customer.organisationId,
          reason: 'Curiosity is not a support request.',
          hours: 2,
        }),
      ),
    ).rejects.toThrow(/platform role does not include this/i);
  });

  it('refuses the same writes in the POLICIES, not only in the code', async () => {
    // The point of the second migration: a check that lives only in the
    // domain layer is one forgotten call away from nothing.
    //
    // Note what a refusal LOOKS like here. An UPDATE whose USING clause fails
    // does not raise — the row is simply not visible to it, so the statement
    // affects nothing and reports success. Asserting a thrown error would
    // therefore pass against a policy that allowed everybody, so these assert
    // the state afterwards, and that the operator who DOES hold the permission
    // changes it, which is what tells the two apart.
    await as(support, (tx) => tx`
      update organisations set status = 'suspended'
       where id = ${customer.organisationId}::uuid
    `);
    const [afterSupport] = await ownerSql()<{ status: string }[]>`
      select status from organisations where id = ${customer.organisationId}
    `;
    expect(afterSupport!.status).not.toBe('suspended');

    await as(admin, (tx) => tx`
      update organisations set status = 'suspended'
       where id = ${customer.organisationId}::uuid
    `);
    const [afterAdmin] = await ownerSql()<{ status: string }[]>`
      select status from organisations where id = ${customer.organisationId}
    `;
    expect(afterAdmin!.status).toBe('suspended');
    await ownerSql()`
      update organisations set status = 'active' where id = ${customer.organisationId}
    `;

    // Spike's own billing identity, the same way.
    await as(viewer, (tx) => tx`
      update platform_billing_settings set legal_name = 'Not Spike' where id
    `);
    const [settings] = await ownerSql()<{ legal_name: string | null }[]>`
      select legal_name from platform_billing_settings where id
    `;
    expect(settings!.legal_name).not.toBe('Not Spike');

    // And the read a role does allow still works, so this is scoping rather
    // than a blanket lockout.
    const readable = await as(viewer, (tx) =>
      tx`select key from platform_roles order by key`,
    );
    expect(readable.length).toBeGreaterThan(0);
  });

  it('keeps role granting to the operators who administer people', async () => {
    await expect(
      asPlatformOperator(support, (tx) =>
        setOperatorRoles(tx, support, { operatorUserId: support, roles: ['platform_admin'] }),
      ),
    ).rejects.toThrow(/platform role does not include this/i);

    // Including through the table itself: a support operator holds the SELECT
    // but not the write.
    await expect(
      as(support, (tx) => tx`
        insert into platform_operator_roles (auth_user_id, role_key)
        values (${support}::uuid, 'platform_admin')
      `),
    ).rejects.toThrow();
  });

  it('admits a colleague by invitation, and only at the address invited', async () => {
    const email = `new-operator-${stamp}@spike.invalid`;
    const invited = await asPlatformOperator(admin, (tx) =>
      inviteOperator(tx, admin, {
        email, fullName: 'Lerato Ndlovu', roles: ['platform_support'],
      }),
    );
    expect(invited.token).toHaveLength(43);

    const described = await ownerSql().begin(async (tx) =>
      describeOperatorInvitation(tx as never, invited.token),
    );
    expect(described?.invitedEmail).toBe(email);
    expect(described?.roleNames).toEqual(['Support']);

    // Somebody else holding the link cannot become an operator with it: the
    // invitation authorises the role, never the identity.
    const stranger = await createAuthUser('Passing Stranger');
    await expect(
      ownerSql().begin((tx) =>
        acceptOperatorInvitation(tx as never, { token: invited.token, authUserId: stranger }),
      ),
    ).rejects.toThrow(/not valid/i);

    // The person it was issued to.
    const theirAccount = await createAuthUser('Lerato Ndlovu', { email });
    const accepted = await ownerSql().begin((tx) =>
      acceptOperatorInvitation(tx as never, { token: invited.token, authUserId: theirAccount }),
    );
    expect(accepted.roles).toEqual(['platform_support']);

    const [profile] = await ownerSql()<{ is_platform_operator: boolean }[]>`
      select is_platform_operator from user_profiles where auth_user_id = ${theirAccount}
    `;
    expect(profile!.is_platform_operator).toBe(true);

    // And it is consumed.
    await expect(
      ownerSql().begin((tx) =>
        acceptOperatorInvitation(tx as never, { token: invited.token, authUserId: theirAccount }),
      ),
    ).rejects.toThrow(/not valid/i);
  });

  it('shows an administrator who holds what', async () => {
    const { operators } = await asPlatformOperator(admin, (tx) => listOperators(tx, admin));
    const me = operators.find((o) => o.authUserId === admin)!;
    expect(me.isSelf).toBe(true);
    expect(me.roles).toContain('platform_admin');
    expect(operators.find((o) => o.authUserId === support)?.roles).toEqual(['platform_support']);

    const roles = await asPlatformOperator(support, (tx) => listPlatformRoles(tx, support));
    // Readable by anybody in the console: an operator is entitled to know what
    // their own role allows, and hiding it makes a refusal look like a fault.
    expect(roles.find((r) => r.key === 'platform_admin')?.isAdmin).toBe(true);
    expect(roles.find((r) => r.key === 'platform_viewer')?.permissions)
      .toEqual(['platform.audit.read', 'platform.customers.read']);
  });

  it('will not leave the console without an administrator, or let one cut their own branch', async () => {
    await expect(
      asPlatformOperator(admin, (tx) => revokeOperator(tx, admin, admin)),
    ).rejects.toThrow(/cannot remove your own console access/i);

    // The only administrator in this fixture set is `admin`, and the trigger
    // counts the whole table — so narrow it to a case with exactly one.
    const lonely = await createOperator('Only Admin', ['platform_admin']);
    await ownerSql()`
      delete from platform_operator_roles
       where role_key = 'platform_admin' and auth_user_id <> ${lonely}
    `;
    await expect(
      ownerSql()`
        delete from platform_operator_roles
         where auth_user_id = ${lonely} and role_key = 'platform_admin'
      `,
    ).rejects.toThrow(/last platform administrator/i);

    // Put the fixture back, so later files are not affected by this one.
    await ownerSql()`
      insert into platform_operator_roles (auth_user_id, role_key)
      values (${admin}, 'platform_admin') on conflict do nothing
    `;
  });

  it('removes a colleague who leaves, and keeps their name on what they did', async () => {
    const leaving = await createOperator('Departing Operator', ['platform_support']);
    await asPlatformOperator(admin, (tx) => revokeOperator(tx, admin, leaving));

    const [profile] = await ownerSql()<{ is_platform_operator: boolean }[]>`
      select is_platform_operator from user_profiles where auth_user_id = ${leaving}
    `;
    expect(profile!.is_platform_operator).toBe(false);
    const roles = await ownerSql()`
      select role_key from platform_operator_roles where auth_user_id = ${leaving}
    `;
    expect(roles).toHaveLength(0);

    // The account itself survives: they are a colleague who left, not a
    // person being deleted, and their name stays readable on their own audit
    // entries.
    const [stillThere] = await ownerSql()<{ full_name: string }[]>`
      select full_name from user_profiles where auth_user_id = ${leaving}
    `;
    expect(stillThere!.full_name).toBe('Departing Operator');

    // And the revoke itself is audited against no organisation, because it
    // happened to Spike rather than inside a customer.
    const [audit] = await ownerSql()<{ action: string; organisation_id: string | null }[]>`
      select action, organisation_id from audit_events
       where resource_type = 'platform_operator' and resource_id = ${leaving}::uuid
    `;
    expect(audit!.action).toBe('platform.operator_revoked');
    expect(audit!.organisation_id).toBeNull();
  });
});
