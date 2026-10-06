import type { Sql } from '@propertyos/db';
import { DomainError, forbidden } from './errors';

export type PermissionKey =
  | 'organisation.settings.manage' | 'membership.manage' | 'support.access.manage'
  | 'portfolio.read' | 'property.create' | 'property.update'
  | 'resident.read' | 'resident.manage' | 'resident.identity.read'
  | 'lease.read' | 'lease.create' | 'lease.activate' | 'lease.close'
  | 'lease.template.manage' | 'lease.agreement.generate'
  | 'billing.preview' | 'billing.post' | 'charge.adjust'
  | 'payment.record' | 'payment.allocate' | 'payment.reverse' | 'bank.import'
  | 'deposit.read' | 'deposit.record' | 'deposit.refund.approve'
  | 'expense.record' | 'expense.approve'
  | 'maintenance.read' | 'maintenance.manage' | 'maintenance.quote.approve'
  | 'inspection.manage'
  | 'document.read' | 'document.manage' | 'document.identity.read'
  | 'report.read' | 'period.lock' | 'platform.admin';

/**
 * Server-side authorisation for a command.
 *
 * Resolved against CURRENT membership and role grants on every call, not against
 * claims baked into a token, so revoking a role takes effect immediately.
 * Hiding a menu item is not an access control; this is.
 */
export async function requirePermission(
  tx: Sql,
  organisationId: string,
  permission: PermissionKey,
): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    select app.has_permission(${organisationId}::uuid, ${permission}) as allowed
  `;
  if (!row?.allowed) {
    throw forbidden(`This action requires the "${permission}" permission.`);
  }
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
 * Resource scope check for a property-bound command.
 *
 * Membership is necessary but never sufficient: an unassigned property is denied
 * even inside the caller's own organisation.
 */
export async function requirePropertyScope(
  tx: Sql,
  organisationId: string,
  propertyId: string,
): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    select app.can_access_property(${organisationId}::uuid, ${propertyId}::uuid) as allowed
  `;
  if (!row?.allowed) {
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
