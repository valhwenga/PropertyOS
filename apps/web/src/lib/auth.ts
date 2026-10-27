import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { withActor, withAnonymous, withPrivilegedActor } from '@propertyos/db';
import type { Sql } from '@propertyos/db';
import { DomainError } from '@propertyos/domain';
import { currentSession, type AssuranceLevel } from './session';

export interface Viewer {
  authUserId: string;
  /** From the verified session. Permission resolution depends on it. */
  assuranceLevel: AssuranceLevel;
  /**
   * When the second factor was last asserted, epoch seconds. Undefined on a
   * single-factor session, and read everywhere as "not recently".
   */
  authenticatedAt?: number;
  fullName: string;
  email: string;
  isPlatformOperator: boolean;
  organisations: Array<{
    id: string; name: string; slug: string; currencyCode: string;
    timeZone: string; status: string; roles: string[];
    /**
     * Set when this organisation is reachable NOT through membership but
     * through a live support session the customer approved. The console is
     * the same console; what differs is that it ends, it is theirs to end
     * sooner, and every screen says so.
     */
    supportSession?: { id: string; expiresAt: string; scopes: string[] };
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
  const session = await currentSession();
  if (!session) return null;
  const { authUserId, assuranceLevel, authenticatedAt } = session;

  return withActor({ authUserId, assuranceLevel, authenticatedAt }, async ({ tx }) => {
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

    // Organisations reachable through a live, customer-approved support
    // session rather than through membership. Read on the caller's own
    // context: `support_sessions_platform_select` shows an operator their own
    // sessions, and `organisations_platform_select` shows account metadata, so
    // nothing here is privileged.
    const supportOrganisations = profile.is_platform_operator
      ? await tx<
        { id: string; name: string; slug: string; currency_code: string; time_zone: string;
          status: string; session_id: string; expires_at: string; scopes: string[] }[]
      >`
        select o.id, o.name, o.slug, o.currency_code, o.time_zone, o.status::text,
               s.id as session_id, s.expires_at::text, s.scopes
          from support_sessions s
          join organisations o on o.id = s.organisation_id
         where s.operator_user_id = ${authUserId}::uuid
           and s.approved_at is not null
           and s.revoked_at is null
           and s.expires_at > now()
         order by o.name
      `
      : [];

    const residentLeases = await tx<
      { lease_id: string; organisation_id: string; reference: string }[]
    >`
      select l.id as lease_id, l.organisation_id, l.reference
      from portal_links pl
      join leases l on l.id = pl.lease_id
      where pl.auth_user_id = ${authUserId}::uuid
        and pl.status = 'active' and pl.revoked_at is null and pl.expires_at > now()
        -- The portal can be switched off for one customer. Applied HERE rather
        -- than on the portal pages: this is what every portal screen and every
        -- portal action resolves a lease through, so one condition closes all
        -- of them, and a resident of another landlord is unaffected.
        and app.setting_enabled(l.organisation_id, 'resident.portal')
    `;

    return {
      authUserId,
      assuranceLevel,
      authenticatedAt,
      fullName: profile.full_name,
      email: profile.email,
      isPlatformOperator: profile.is_platform_operator,
      organisations: [
        ...organisations.map((o) => ({
          id: o.id, name: o.name, slug: o.slug, currencyCode: o.currency_code,
          timeZone: o.time_zone, status: o.status, roles: o.roles,
        })),
        // Membership wins where somebody has both, so a real member is never
        // shown as a visitor on their own organisation.
        ...supportOrganisations
          .filter((s) => !organisations.some((o) => o.id === s.id))
          .map((s) => ({
            id: s.id, name: s.name, slug: s.slug, currencyCode: s.currency_code,
            timeZone: s.time_zone, status: s.status, roles: [] as string[],
            supportSession: { id: s.session_id, expiresAt: s.expires_at, scopes: s.scopes },
          })),
      ],
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
  /**
   * Set when the caller is here on a support session rather than as a member.
   * Every console screen renders a banner from it: who they are, whose records
   * these are, what they may change, and when it ends.
   */
  supportSession?: { id: string; expiresAt: string; scopes: string[] };
}

/**
 * Resolves the operator context for an organisation slug in the URL.
 *
 * The slug is UNTRUSTED input. It is matched against the viewer's own
 * memberships; a slug the viewer is not a member of produces a redirect to
 * their own organisation list, never a peek at another customer's name.
 *
 * It is also where a suspended account stops. `setAccountStatus` has always
 * said "Suspension stops access" and nothing read the column: no permission
 * function, no policy and no screen, so a suspended customer's staff carried on
 * working exactly as before. The check belongs HERE rather than in the layout
 * because every console page and every Server Action passes through this
 * function, and a layout can be served from the client router's cache while a
 * new page loads — a suspension that is only cosmetic is worse than none.
 *
 * What suspension deliberately does not touch: the records themselves, the
 * billing run, the worker, and the resident portal, which is reached through a
 * lease rather than through here. A landlord's dispute with Spike is not a
 * reason to take a tenant's statements away from them.
 */
export async function requireOperator(slug: string): Promise<OperatorContext> {
  const viewer = await requireViewer();
  const organisation = viewer.organisations.find((o) => o.slug === slug);
  if (!organisation) redirect('/app');
  if (organisation.status === 'suspended' || organisation.status === 'closed') {
    // Suspension is Spike's lever against the CUSTOMER, so it stops the
    // customer and not the support operator the customer let in: a landlord
    // suspended for non-payment who then asks for help would otherwise be
    // unreachable by the only people who could sort it out. The banner still
    // says whose records these are, and the session still ends on its own.
    if (!organisation.supportSession) {
      redirect(`/account-suspended/${organisation.slug}`);
    }
  }
  return {
    viewer,
    organisationId: organisation.id,
    organisationName: organisation.name,
    currencyCode: organisation.currencyCode,
    timeZone: organisation.timeZone,
    roles: organisation.roles,
    ...(organisation.supportSession ? { supportSession: organisation.supportSession } : {}),
  };
}

/** Runs a read under the caller's RLS context. */
export async function readAs<T>(viewer: Viewer, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return withActor(
    {
      authUserId: viewer.authUserId,
      assuranceLevel: viewer.assuranceLevel,
      authenticatedAt: viewer.authenticatedAt,
    },
    ({ tx }) => fn(tx),
  );
}

/**
 * A read that lifts row-level FILTERING while keeping the caller's identity.
 *
 * For the handful of platform reads that are about organisations the caller is
 * deliberately not a member of. A Spike operator is a member of nothing, so
 * every membership-keyed policy filters those rows away — correctly for
 * customer content, and uselessly for the account metadata the platform page
 * exists to show.
 *
 * The identity is still set on the transaction, so the function being called
 * performs its own `requirePlatformOperator` check in SQL, second factor and
 * all. Use it only for reads that return account metadata, never for customer
 * records: those are reachable only through an authorised, time-limited,
 * audited support session.
 */
export async function readPrivilegedAs<T>(
  viewer: Viewer, fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return withPrivilegedActor(
    {
      authUserId: viewer.authUserId,
      assuranceLevel: viewer.assuranceLevel,
      authenticatedAt: viewer.authenticatedAt,
    },
    ({ tx }) => fn(tx),
  );
}

export { withAnonymous, DomainError };
