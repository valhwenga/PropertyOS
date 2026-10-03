import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import { requirePermission } from './permissions';

export interface InvitationReview {
  leaseId: string;
  leaseReference: string;
  unitLabel: string;
  residentId: string;
  residentName: string;
  residentEmail: string | null;
  /** Shown to the operator before sending, so a mis-linked invite is caught. */
  existingPortalUser: string | null;
}

/**
 * Loads exactly what the operator must confirm before an invitation is sent.
 *
 * "An administrator linking an email to the wrong resident is a security
 * incident risk, so show the lease and recipient during invite review." This is
 * the review payload for that screen.
 */
export async function prepareInvitation(
  tx: Sql,
  organisationId: string,
  params: { leaseId: string; residentId: string },
): Promise<InvitationReview> {
  await requirePermission(tx, organisationId, 'resident.manage');

  const [row] = await tx<
    { lease_id: string; lease_reference: string; unit_label: string;
      resident_id: string; resident_name: string; resident_email: string | null;
      existing_user: string | null }[]
  >`
    select l.id as lease_id, l.reference as lease_reference,
           p.name || ' / ' || u.code as unit_label,
           rp.id as resident_id,
           rp.first_name || ' ' || rp.last_name as resident_name,
           rp.email as resident_email,
           (select pl.invited_email from portal_links pl
            where pl.lease_id = l.id and pl.resident_id = rp.id and pl.status = 'active'
            limit 1) as existing_user
    from leases l
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    join lease_parties lpty on lpty.lease_id = l.id and lpty.resident_id = ${params.residentId}::uuid
    join resident_profiles rp on rp.id = lpty.resident_id
    where l.id = ${params.leaseId}::uuid
      and l.organisation_id = ${organisationId}::uuid
      and lpty.removed_on is null
  `;
  // No row means the resident is not a party to that lease — which is precisely
  // the mis-link we are guarding against.
  if (!row) {
    throw new DomainError(
      'not_found',
      'That resident is not a party to that lease, so an invitation cannot be issued.',
    );
  }

  return {
    leaseId: row.lease_id,
    leaseReference: row.lease_reference,
    unitLabel: row.unit_label,
    residentId: row.resident_id,
    residentName: row.resident_name,
    residentEmail: row.resident_email,
    existingPortalUser: row.existing_user,
  };
}

/**
 * Issues a portal invitation.
 *
 * Only the SHA-256 of the token is stored, so a database read cannot be replayed
 * as an invitation. The plaintext token is returned once, to be emailed, and is
 * never persisted or logged.
 */
export async function issueInvitation(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: {
    leaseId: string; residentId: string; email: string;
    /** The operator must confirm the reviewed recipient, not just the ids. */
    confirmedRecipient: string;
    expiryDays?: number;
  },
): Promise<{ portalLinkId: string; token: string; expiresAt: Date }> {
  await requirePermission(tx, organisationId, 'resident.manage');

  const review = await prepareInvitation(tx, organisationId, {
    leaseId: params.leaseId, residentId: params.residentId,
  });
  // Guards against an operator approving a review screen for one resident while
  // the request carries another.
  if (review.residentName !== params.confirmedRecipient) {
    throw invalid(
      'The confirmed recipient does not match the resident on this lease. ' +
        'Review the lease and recipient again before sending.',
    );
  }

  const email = params.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Enter a valid email address.');

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest();
  const expiresAt = new Date(Date.now() + (params.expiryDays ?? 14) * 86_400_000);

  try {
    const [link] = await tx<{ id: string }[]>`
      insert into portal_links (
        organisation_id, resident_id, lease_id, invited_email, invite_token_hash,
        status, invited_by, expires_at
      ) values (
        ${organisationId}, ${params.residentId}, ${params.leaseId}, ${email},
        ${tokenHash}, 'invited', ${actorUserId}, ${expiresAt.toISOString()}
      )
      on conflict (organisation_id, lease_id, resident_id) do update
        set invited_email = excluded.invited_email,
            invite_token_hash = excluded.invite_token_hash,
            status = 'invited',
            invited_at = now(),
            invited_by = excluded.invited_by,
            revoked_at = null,
            accepted_at = null,
            expires_at = excluded.expires_at
      returning id
    `;
    if (!link) throw new DomainError('internal', 'Portal link insert returned no row.');

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'portal.invitation.issued', resourceType: 'portal_link', resourceId: link.id,
      // The token is redacted by recordAudit and is never written anywhere.
      after: {
        leaseId: params.leaseId, residentId: params.residentId,
        invitedEmail: email, expiresAt: expiresAt.toISOString(),
      },
    });
    await emitEvent(tx, {
      organisationId, eventType: 'portal.invitation.issued',
      resourceType: 'portal_link', resourceId: link.id,
      payload: { leaseId: params.leaseId },
    });

    return { portalLinkId: link.id, token, expiresAt };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Redeems an invitation token.
 *
 * Runs on a privileged connection because the recipient has no session yet. It
 * is narrowly scoped: it can only ever bind ONE auth user to the single portal
 * link whose token hash matches, and the token is consumed in the process so it
 * cannot be replayed.
 */
export async function acceptInvitation(
  tx: Sql,
  params: { token: string; authUserId: string },
): Promise<{ organisationId: string; leaseId: string }> {
  const tokenHash = createHash('sha256').update(params.token).digest();

  const [link] = await tx<
    { id: string; organisation_id: string; lease_id: string; status: string; expires_at: string }[]
  >`
    select id, organisation_id, lease_id, status, expires_at
    from portal_links
    where invite_token_hash = ${tokenHash}
    for update
  `;
  // A wrong, expired or already-used token all produce the same response, so the
  // endpoint cannot be used to probe for valid invitations.
  const generic = new DomainError(
    'not_found',
    'This invitation link is not valid. It may have expired or already been used. Ask your landlord for a new one.',
  );
  if (!link) throw generic;
  if (link.status !== 'invited') throw generic;
  if (new Date(link.expires_at) < new Date()) {
    await tx`update portal_links set status = 'expired' where id = ${link.id}`;
    throw generic;
  }

  await tx`
    update portal_links set
      auth_user_id = ${params.authUserId},
      status = 'active',
      accepted_at = now(),
      -- The token is consumed: it cannot be replayed to attach a second account.
      invite_token_hash = null
    where id = ${link.id}
  `;

  await recordAudit(tx, {
    organisationId: link.organisation_id,
    actorUserId: params.authUserId,
    action: 'portal.invitation.accepted', resourceType: 'portal_link', resourceId: link.id,
    after: { leaseId: link.lease_id },
  });

  return { organisationId: link.organisation_id, leaseId: link.lease_id };
}

export async function revokePortalAccess(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { portalLinkId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'resident.manage');
  if (params.reason.trim().length < 3) throw invalid('A revocation requires a reason.');

  const [link] = await tx<{ id: string }[]>`
    select id from portal_links
    where id = ${params.portalLinkId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!link) throw notFound('Portal access');

  await tx`
    update portal_links set status = 'revoked', revoked_at = now(), invite_token_hash = null
    where id = ${params.portalLinkId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'portal.access.revoked', resourceType: 'portal_link', resourceId: params.portalLinkId,
    reason: params.reason,
  });
}
