import type { Sql } from '@propertyos/db';
import { DomainError, forbidden } from './errors';

export type PermissionKey =
  | 'organisation.settings.manage' | 'membership.manage' | 'support.access.manage'
  | 'portfolio.read' | 'property.create' | 'property.update'
  | 'resident.read' | 'resident.manage' | 'resident.identity.read'
  | 'lease.read' | 'lease.create' | 'lease.activate' | 'lease.close'
  | 'lease.template.manage' | 'lease.agreement.generate'
  | 'billing.preview' | 'billing.post' | 'charge.adjust' | 'invoice.send'
  | 'payment.record' | 'payment.allocate' | 'payment.reverse' | 'bank.import'
  | 'bank_account.read' | 'bank_account.manage' | 'bank_account.verify'
  | 'deposit.read' | 'deposit.record' | 'deposit.refund.approve'
  | 'expense.record' | 'expense.approve'
  | 'maintenance.read' | 'maintenance.manage' | 'maintenance.quote.approve'
  | 'inspection.manage'
  | 'document.read' | 'document.manage' | 'document.identity.read'
  | 'report.read' | 'period.lock' | 'platform.admin' | 'audit.read'
  | 'customer.export';

/**
 * Server-side authorisation for a command.
 *
 * Resolved against CURRENT membership and role grants on every call, not against
 * claims baked into a token, so revoking a role takes effect immediately.
 * Hiding a menu item is not an access control; this is.
 *
 * There is a second way to hold a permission here, and only one: a live
 * support session the customer approved, carrying a scope that includes this
 * permission. That is what lets a landlord say "please fix it" and have Spike
 * able to. `app.support_may` applies the allowlist itself, so the permissions
 * no scope may ever carry — anything touching money, memberships, support
 * access, period locks, the bulk export or identity documents — are refused
 * here even if a scope somehow carried them, and the tables behind them have
 * no support write policy at all.
 *
 * Asked in this order because membership is the overwhelmingly common case and
 * because the message should name the permission rather than the session.
 */
export async function requirePermission(
  tx: Sql,
  organisationId: string,
  permission: PermissionKey,
): Promise<void> {
  const [row] = await tx<{ allowed: boolean; via_support: boolean }[]>`
    select app.has_permission(${organisationId}::uuid, ${permission}) as allowed,
           app.support_may(${organisationId}::uuid, ${permission}) as via_support
  `;
  if (!row?.allowed && !row?.via_support) {
    throw forbidden(`This action requires the "${permission}" permission.`);
  }
}

/**
 * The live support session this caller is acting under, if any.
 *
 * For the handful of places that need to SAY so — a banner on the customer's
 * own screens, a reason line on a record. Audit attribution does not use it:
 * that is a trigger on `audit_events`, because "which session did this" must
 * not depend on a command remembering to pass it.
 */
export async function currentSupportSession(
  tx: Sql,
  organisationId: string,
): Promise<string | null> {
  const [row] = await tx<{ session_id: string | null }[]>`
    select app.current_support_session(${organisationId}::uuid) as session_id
  `;
  return row?.session_id ?? null;
}

/**
 * How recently a sensitive change must have been authenticated.
 *
 * Short enough that an unattended session cannot be used to redirect rent;
 * long enough to fill in a form. The window is a constant rather than a
 * per-call argument so every sensitive command agrees on what "recent" means.
 */
export const FRESH_AUTHENTICATION_SECONDS = 300;

/**
 * Demands that the caller proved their identity in the last few minutes.
 *
 * Assurance and freshness are different claims. `requirePermission` asks
 * whether this person may do it at all; this asks whether the person at the
 * keyboard right now is still them. Changing where money is paid needs both.
 *
 * Resolved in the database, like assurance, so there is no application path
 * that can skip it. A session with no authentication instant at all is stale,
 * never fresh: absent evidence is not evidence.
 */
export async function requireFreshAuthentication(
  tx: Sql,
  withinSeconds: number = FRESH_AUTHENTICATION_SECONDS,
): Promise<void> {
  const [row] = await tx<{ fresh: boolean }[]>`
    select app.authentication_is_fresh(make_interval(secs => ${withinSeconds})) as fresh
  `;
  if (!row?.fresh) {
    throw new DomainError(
      'reauthentication_required',
      'Confirm your second factor again before making this change.',
      { withinSeconds },
    );
  }
}

/** Whether the session is currently fresh, for deciding what to offer. */
export async function authenticationIsFresh(
  tx: Sql,
  withinSeconds: number = FRESH_AUTHENTICATION_SECONDS,
): Promise<boolean> {
  const [row] = await tx<{ fresh: boolean }[]>`
    select app.authentication_is_fresh(make_interval(secs => ${withinSeconds})) as fresh
  `;
  return Boolean(row?.fresh);
}

export async function hasPermission(
  tx: Sql,
  organisationId: string,
  permission: PermissionKey,
): Promise<boolean> {
  const [row] = await tx<{ allowed: boolean }[]>`
    select app.has_permission(${organisationId}::uuid, ${permission}) as allowed
  `;
  return Boolean(row?.allowed);
}

/**
 * What to offer, and what is being withheld only for want of a second factor.
 *
 * The difference matters on a menu. A permission the caller's roles do not
 * include should not be offered at all; one their roles DO include, withheld
 * because this session has only a password, must not simply vanish — hiding it
 * hides the remedy, and the person is left believing the product is closed to
 * them. `app.permission_needs_mfa` answers exactly that second question, and
 * is itself false once the permission is actually held.
 *
 * One round trip for both, because the menu is rendered on every page.
 */
export async function resolveMenuPermissions<K extends PermissionKey>(
  tx: Sql,
  organisationId: string,
  permissions: readonly K[],
): Promise<{ held: K[]; withheldForSecondFactor: K[] }> {
  if (permissions.length === 0) return { held: [], withheldForSecondFactor: [] };
  const rows = await tx<{ key: string; held: boolean; needs_mfa: boolean }[]>`
    select k as key,
           app.has_permission(${organisationId}::uuid, k) as held,
           app.permission_needs_mfa(${organisationId}::uuid, k) as needs_mfa
    from unnest(${permissions as unknown as string[]}::text[]) as k
  `;
  return {
    held: rows.filter((r) => r.held).map((r) => r.key as K),
    withheldForSecondFactor: rows.filter((r) => !r.held && r.needs_mfa).map((r) => r.key as K),
  };
}

/**
 * Resource scope check for a property-bound command.
 *
 * Membership is necessary but never sufficient: an unassigned property is denied
 * even inside the caller's own organisation.
 *
 * A support session is the exception, and deliberately so: what the customer
 * authorises is access to their ORGANISATION for a few hours, not to a list of
 * properties — there is no screen on which they could assign one, and no
 * meaning to "Spike is assigned to 12B". The support write policies omit the
 * property condition for the same reason. The scope itself is still the limit:
 * this says nothing about WHAT may be done, which `requirePermission` has
 * already decided.
 */
export async function requirePropertyScope(
  tx: Sql,
  organisationId: string,
  propertyId: string,
): Promise<void> {
  const [row] = await tx<{ allowed: boolean; under_session: boolean }[]>`
    select app.can_access_property(${organisationId}::uuid, ${propertyId}::uuid) as allowed,
           app.current_support_session(${organisationId}::uuid) is not null as under_session
  `;
  if (!row?.allowed && !row?.under_session) {
    throw forbidden('This property is not in your assigned scope.');
  }
}

/**
 * Resolves the organisation a request may operate in.
 *
 * The caller-supplied id is verified against an ACTIVE membership before it is
 * used for anything. An id that does not match is rejected outright rather than
 * being passed to a query and quietly returning an empty result, so that a
 * probing request is indistinguishable from a wrong-organisation request.
 */
export async function resolveOrganisation(
  tx: Sql,
  requestedOrganisationId: string,
): Promise<{ organisationId: string; membershipId: string }> {
  const [row] = await tx<{ id: string }[]>`
    select app.current_membership(${requestedOrganisationId}::uuid) as id
  `;
  if (!row?.id) {
    throw new DomainError('forbidden', 'You are not an active member of this organisation.');
  }
  return { organisationId: requestedOrganisationId, membershipId: row.id };
}

export async function requireSupportAuthorisation(
  tx: Sql,
  organisationId: string,
): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    select app.has_support_access(${organisationId}::uuid) as allowed
  `;
  if (!row?.allowed) {
    throw forbidden(
      'Spike support access to customer content requires an authorised, unexpired support session.',
    );
  }
}
