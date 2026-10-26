/**
 * Test factories.
 *
 * All data created here is clearly synthetic. Fixtures deliberately build TWO
 * organisations by default so that every isolation assertion has a real
 * neighbour to be denied access to, rather than an empty database that would
 * pass by accident.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { withActor, withPrivilegedActor } from '@propertyos/db';
import type { Sql } from '@propertyos/db';
import { createOrganisationWithOwner } from '@propertyos/domain';

let owner: Sql | undefined;

/** The privileged connection. Only used to seed auth users and to inspect state. */
export function ownerSql(): Sql {
  if (!owner) {
    owner = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} }) as Sql;
  }
  return owner;
}

export async function closeOwner(): Promise<void> {
  await owner?.end({ timeout: 5 });
  owner = undefined;
}

export async function createAuthUser(
  fullName: string,
  options: {
    platformOperator?: boolean;
    email?: string;
    /**
     * Which platform roles a Spike operator holds. Defaults to
     * `platform_admin`, which is what migration 0072 backfilled every operator
     * that already existed to: an operator made the old way — by flipping the
     * boolean — could do everything the console offers, so a fixture that
     * says `platformOperator: true` and nothing else still means that.
     * Name the roles to build a scoped operator instead.
     */
    platformRoles?: string[];
  } = {},
): Promise<string> {
  const id = randomUUID();
  // The derived address keeps fixtures unique; an explicit one exists because
  // an invitation is issued TO an address and must be accepted by that account.
  const email = options.email
    ?? `${fullName.toLowerCase().replace(/[^a-z]+/g, '.')}.${id.slice(0, 8)}@demo.invalid`;
  const sql = ownerSql();
  await sql`insert into auth.users (id, email) values (${id}, ${email})`;
  await sql`
    insert into user_profiles (auth_user_id, full_name, email, is_platform_operator)
    values (${id}, ${fullName}, ${email}, ${options.platformOperator ?? false})
  `;
  if (options.platformOperator) {
    for (const role of options.platformRoles ?? ['platform_admin']) {
      await sql`
        insert into platform_operator_roles (auth_user_id, role_key)
        values (${id}, ${role}) on conflict do nothing
      `;
    }
  }
  return id;
}

export interface OrganisationFixture {
  organisationId: string;
  bookId: string;
  adminUserId: string;
  slug: string;
}

export async function createOrganisation(
  name: string,
  /**
   * The plan decides the unit and staff ALLOWANCES, which are now enforced
   * where records are created. A suite exercising something else — invitation
   * mechanics, say — needs room rather than the smallest plan, or it starts
   * failing on a correct refusal that has nothing to do with what it tests.
   * The allowances themselves are exercised in `platform-console.test.ts`.
   */
  options: { planKey?: 'starter' | 'portfolio' | 'professional' | 'enterprise' } = {},
): Promise<OrganisationFixture> {
  const adminUserId = await createAuthUser(`${name} Admin`);
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 6)}`;
  // Provisioning runs on the privileged connection because the caller has no
  // membership yet; it only ever creates a NEW organisation for the caller.
  const sql = ownerSql();
  const result = await sql.begin(async (tx) =>
    createOrganisationWithOwner(
      tx as unknown as Sql,
      {
        name,
        slug,
        countryCode: 'ZA',
        currencyCode: 'ZAR',
        timeZone: 'Africa/Johannesburg',
        legalEntityName: `${name} (Pty) Ltd`,
        planKey: options.planKey ?? 'starter',
      },
      adminUserId,
    ),
  );
  return { ...(result as { organisationId: string; bookId: string }), adminUserId, slug };
}

/** Adds a member with the given roles and resource scope. */
export async function addMember(
  organisationId: string,
  fullName: string,
  roles: string[],
  scope: { type: 'organisation' } | { type: 'property'; propertyId: string } | { type: 'none' } = {
    type: 'organisation',
  },
): Promise<string> {
  const authUserId = await createAuthUser(fullName);
  const sql = ownerSql();
  const [membership] = await sql<{ id: string }[]>`
    insert into memberships (organisation_id, auth_user_id, status)
    values (${organisationId}, ${authUserId}, 'active')
    returning id
  `;
  for (const role of roles) {
    await sql`insert into membership_roles (membership_id, role_key) values (${membership!.id}, ${role})`;
  }
  if (scope.type === 'organisation') {
    await sql`
      insert into property_assignments (organisation_id, membership_id, scope_type)
      values (${organisationId}, ${membership!.id}, 'organisation')
    `;
  } else if (scope.type === 'property') {
    await sql`
      insert into property_assignments (organisation_id, membership_id, scope_type, property_id)
      values (${organisationId}, ${membership!.id}, 'property', ${scope.propertyId})
    `;
  }
  return authUserId;
}

/** Grants a resident a portal login for one lease. */
export async function grantPortalAccess(
  organisationId: string,
  leaseId: string,
  residentId: string,
  fullName: string,
): Promise<string> {
  const authUserId = await createAuthUser(fullName);
  const sql = ownerSql();
  // One live portal link per (organisation, lease, resident): re-granting access
  // replaces the previous link rather than creating a second one.
  await sql`
    insert into portal_links (
      organisation_id, resident_id, lease_id, auth_user_id, invited_email,
      status, accepted_at, expires_at
    ) values (
      ${organisationId}, ${residentId}, ${leaseId}, ${authUserId},
      ${`resident.${residentId.slice(0, 8)}@demo.invalid`}, 'active', now(), now() + interval '365 days'
    )
    on conflict (organisation_id, lease_id, resident_id) do update
      set auth_user_id = excluded.auth_user_id,
          status = 'active',
          revoked_at = null,
          accepted_at = now(),
          expires_at = excluded.expires_at
  `;
  return authUserId;
}

/**
 * An APPROVED support session, which is the only kind that reaches anything.
 *
 * `approved_at` is set here deliberately: since migration 0065 a session the
 * customer has not approved returns no organisation from
 * `app.support_organisation_ids()`, so a fixture without it would grant
 * nothing and every isolation test using it would pass for the wrong reason.
 * The approval path itself is exercised through `approveSupportSession`.
 */
export async function grantSupportSession(
  organisationId: string,
  operatorUserId: string,
  authorisedBy: string,
  hours = 2,
): Promise<string> {
  const sql = ownerSql();
  const [row] = await sql<{ id: string }[]>`
    insert into support_sessions (
      organisation_id, operator_user_id, reason, authorised_by, expires_at, read_only,
      approved_at
    ) values (
      ${organisationId}, ${operatorUserId},
      'Customer raised a reconciliation query via support ticket SPK-1001',
      ${authorisedBy}, now() + (${hours} || ' hours')::interval, true,
      now()
    )
    returning id
  `;
  return row!.id;
}

/** A session Spike has asked for and nobody has approved. Reaches nothing. */
export async function requestSupportSession(
  organisationId: string,
  operatorUserId: string,
  hours = 2,
): Promise<string> {
  const sql = ownerSql();
  const [row] = await sql<{ id: string }[]>`
    insert into support_sessions (
      organisation_id, operator_user_id, reason, expires_at, read_only
    ) values (
      ${organisationId}, ${operatorUserId},
      'Customer raised a reconciliation query via support ticket SPK-1002',
      now() + (${hours} || ' hours')::interval, true
    )
    returning id
  `;
  return row!.id;
}

/**
 * Runs a block as a given user under their RLS context.
 *
 * Defaults to aal2 (second factor verified) because most fixtures exercise
 * business rules rather than the MFA gate itself. `asSingleFactor` is the
 * explicit opposite, used by the tests that assert the gate works.
 */
export async function as<T>(authUserId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return withActor({ authUserId, assuranceLevel: 'aal2' }, ({ tx }) => fn(tx));
}

/**
 * A Spike platform operator provisioning a customer.
 *
 * Privileged, because every write policy in the schema is keyed on membership
 * and a Spike operator is a member of nothing — but still carrying the
 * operator's identity, so the command's own platform-operator and
 * second-factor checks run in SQL exactly as they would anywhere else.
 */
export async function asPlatformOperator<T>(
  authUserId: string,
  fn: (tx: Sql) => Promise<T>,
  assuranceLevel: 'aal1' | 'aal2' = 'aal2',
): Promise<T> {
  return withPrivilegedActor({ authUserId, assuranceLevel }, ({ tx }) => fn(tx));
}

/**
 * A session that proved its second factor JUST NOW.
 *
 * `as` deliberately supplies no authentication instant, so an ordinary test
 * session is stale. Anything gated on fresh authentication must opt in here,
 * which means a command that forgets its gate fails loudly in the suite rather
 * than passing because every session happened to look fresh.
 */
export async function asFreshlyAuthenticated<T>(
  authUserId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return withActor(
    { authUserId, assuranceLevel: 'aal2', authenticatedAt: Math.floor(Date.now() / 1000) },
    ({ tx }) => fn(tx),
  );
}

/** A second factor proved an hour ago: still aal2, no longer fresh. */
export async function asStaleAuthentication<T>(
  authUserId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return withActor(
    { authUserId, assuranceLevel: 'aal2', authenticatedAt: Math.floor(Date.now() / 1000) - 3600 },
    ({ tx }) => fn(tx),
  );
}

/** Runs a block on a password-only session, as an un-MFA'd user would. */
export async function asSingleFactor<T>(
  authUserId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return withActor({ authUserId, assuranceLevel: 'aal1' }, ({ tx }) => fn(tx));
}
