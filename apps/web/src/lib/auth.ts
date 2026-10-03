import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { withActor, withAnonymous } from '@propertyos/db';
import type { Sql } from '@propertyos/db';
import { DomainError } from '@propertyos/domain';
import { currentAuthUserId } from './session';

export interface Viewer {
  authUserId: string;
  fullName: string;
  email: string;
  isPlatformOperator: boolean;
  organisations: Array<{
    id: string; name: string; slug: string; currencyCode: string;
    timeZone: string; status: string; roles: string[];
  }>;
  residentLeases: Array<{ leaseId: string; organisationId: string; reference: string }>;
}

/**
 * Resolves who is calling, and what they are a member of.
 *
 * Memberships and roles are read fresh on every request under the caller's own
 * RLS context. There are no long lived role claims in the session cookie, so
 * revoking a role or a portal link takes effect on the next request.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const authUserId = await currentAuthUserId();
  if (!authUserId) return null;

  return withActor({ authUserId }, async ({ tx }) => {
    const [profile] = await tx<
      { full_name: string; email: string; is_platform_operator: boolean }[]
    >`
      select full_name, email, is_platform_operator
      from user_profiles where auth_user_id = ${authUserId}::uuid
    `;
    if (!profile) return null;

    const organisations = await tx<
      { id: string; name: string; slug: string; currency_code: string;
        time_zone: string; status: string; roles: string[] }[]
    >`
      select o.id, o.name, o.slug, o.currency_code, o.time_zone, o.status::text,
             coalesce(array_agg(mr.role_key) filter (where mr.role_key is not null), '{}') as roles
      from memberships m
      join organisations o on o.id = m.organisation_id
      left join membership_roles mr on mr.membership_id = m.id
      where m.auth_user_id = ${authUserId}::uuid and m.status = 'active'
      group by o.id, o.name, o.slug, o.currency_code, o.time_zone, o.status
      order by o.name
    `;

    const residentLeases = await tx<
      { lease_id: string; organisation_id: string; reference: string }[]
    >`
      select l.id as lease_id, l.organisation_id, l.reference
      from portal_links pl
      join leases l on l.id = pl.lease_id
      where pl.auth_user_id = ${authUserId}::uuid
        and pl.status = 'active' and pl.revoked_at is null and pl.expires_at > now()
    `;

    return {
      authUserId,
      fullName: profile.full_name,
      email: profile.email,
      isPlatformOperator: profile.is_platform_operator,
      organisations: organisations.map((o) => ({
        id: o.id, name: o.name, slug: o.slug, currencyCode: o.currency_code,
        timeZone: o.time_zone, status: o.status, roles: o.roles,
      })),
      residentLeases: residentLeases.map((r) => ({
        leaseId: r.lease_id, organisationId: r.organisation_id, reference: r.reference,
      })),
    };
  });
});

export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect('/sign-in');
  return viewer;
}

export interface OperatorContext {
  viewer: Viewer;
  organisationId: string;
  organisationName: string;
  currencyCode: string;
  timeZone: string;
  roles: string[];
}

/**
 * Resolves the operator context for an organisation slug in the URL.
 *
 * The slug is UNTRUSTED input. It is matched against the viewer's own
 * memberships; a slug the viewer is not a member of produces a redirect to
 * their own organisation list, never a peek at another customer's name.
 */
export async function requireOperator(slug: string): Promise<OperatorContext> {
  const viewer = await requireViewer();
  const organisation = viewer.organisations.find((o) => o.slug === slug);
  if (!organisation) redirect('/app');
  return {
    viewer,
    organisationId: organisation.id,
    organisationName: organisation.name,
    currencyCode: organisation.currencyCode,
    timeZone: organisation.timeZone,
    roles: organisation.roles,
  };
}

/** Runs a read under the caller's RLS context. */
export async function readAs<T>(viewer: Viewer, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return withActor({ authUserId: viewer.authUserId }, ({ tx }) => fn(tx));
}

export { withAnonymous, DomainError };
