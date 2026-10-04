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
import { withActor } from '@propertyos/db';
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
  options: { platformOperator?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const email = `${fullName.toLowerCase().replace(/[^a-z]+/g, '.')}.${id.slice(0, 8)}@demo.invalid`;
  const sql = ownerSql();
  await sql`insert into auth.users (id, email) values (${id}, ${email})`;
  await sql`
    insert into user_profiles (auth_user_id, full_name, email, is_platform_operator)
    values (${id}, ${fullName}, ${email}, ${options.platformOperator ?? false})
  `;
  return id;
}

export interface OrganisationFixture {
  organisationId: string;
  bookId: string;
  adminUserId: string;
  slug: string;
}

export async function createOrganisation(name: string): Promise<OrganisationFixture> {
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
        planKey: 'starter',
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

export async function grantSupportSession(
  organisationId: string,
  operatorUserId: string,
  authorisedBy: string,
  hours = 2,
): Promise<string> {
  const sql = ownerSql();
  const [row] = await sql<{ id: string }[]>`
    insert into support_sessions (
      organisation_id, operator_user_id, reason, authorised_by, expires_at, read_only
    ) values (
      ${organisationId}, ${operatorUserId},
      'Customer raised a reconciliation query via support ticket SPK-1001',
      ${authorisedBy}, now() + (${hours} || ' hours')::interval, true
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

/** Runs a block on a password-only session, as an un-MFA'd user would. */
export async function asSingleFactor<T>(
  authUserId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return withActor({ authUserId, assuranceLevel: 'aal1' }, ({ tx }) => fn(tx));
}
