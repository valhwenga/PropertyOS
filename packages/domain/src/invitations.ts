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
    // Writes nothing. Marking it expired here and then throwing would roll the
    // marking back with the rest of the transaction: the code would look like
    // it tidied up and would not have. `expires_at` is the only thing that
    // decides whether a token works.
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

export interface PortalInvitationCandidate {
  leaseId: string;
  leaseReference: string;
  unitLabel: string;
  residentId: string;
  residentName: string;
  email: string | null;
  /** Why this one cannot be invited yet, if it cannot. */
  blockedReason: string | null;
}

/**
 * Everybody on an active lease who could be given portal access and has not
 * been.
 *
 * The onboarding import brings in properties, units, residents and leases in
 * one sitting, and then every resident had to be invited from their own lease
 * screen, one at a time — fifty leases is fifty screens, which is how a
 * landlord decides the portal is not worth it.
 *
 * It lists the ones that CANNOT be invited too, with the reason, because a
 * list that silently omits them is a list somebody will trust: a resident with
 * no email address recorded is the common case, and the fix is to add it rather
 * than to wonder where they went.
 */
export async function listPortalInvitationCandidates(
  tx: Sql,
  organisationId: string,
): Promise<PortalInvitationCandidate[]> {
  await requirePermission(tx, organisationId, 'resident.manage');

  const rows = await tx<
    { lease_id: string; lease_reference: string; unit_label: string; resident_id: string;
      resident_name: string; email: string | null; live_link: boolean }[]
  >`
    select l.id as lease_id, l.reference as lease_reference,
           p.name || ' / ' || u.code as unit_label,
           rp.id as resident_id,
           rp.first_name || ' ' || rp.last_name as resident_name,
           rp.email::text as email,
           exists (
             select 1 from portal_links pl
              where pl.lease_id = l.id and pl.resident_id = rp.id
                and pl.revoked_at is null
                and pl.status in ('invited', 'active')
                and pl.expires_at > now()
           ) as live_link
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      join lease_parties lpty on lpty.lease_id = l.id and lpty.removed_on is null
      join resident_profiles rp on rp.id = lpty.resident_id
     where l.organisation_id = ${organisationId}::uuid
       and l.status in ('active', 'notice_given')
     order by p.name, u.code, rp.last_name, rp.first_name
     limit 500
  `;

  return rows
    .filter((r) => !r.live_link)
    .map((r) => ({
      leaseId: r.lease_id,
      leaseReference: r.lease_reference,
      unitLabel: r.unit_label,
      residentId: r.resident_id,
      residentName: r.resident_name,
      email: r.email,
      blockedReason: r.email
        ? null
        : 'No email address recorded for this resident. Add one on their record first.',
    }));
}

export interface IssuedPortalInvitation {
  residentName: string;
  leaseReference: string;
  email: string;
  token: string;
  expiresAt: string;
}

/**
 * Issues portal invitations for several residents at once.
 *
 * It does NOT weaken the mis-link guard, which is the whole reason this is
 * harder than a loop. `issueInvitation` refuses unless the caller passes the
 * recipient's name as the operator confirmed it, because sending one
 * resident's statements to another is the incident §8 names. So each row
 * carries the name the operator READ on the review screen, and the domain
 * re-derives it and compares: if anything changed between the screen and the
 * submission, that row fails and says so rather than being sent to whoever is
 * on the lease now.
 *
 * One bad row does not take the others with it. Rather than a savepoint per
 * row — which the shared `Sql` type does not expose, and which would hide a
 * genuine fault as a per-row note — every row is CHECKED first against the
 * same review the single-invitation screen shows, and only the sound ones are
 * issued. A row that fails the check is reported with its reason and nothing
 * else is affected; an unexpected database error still aborts the run, which
 * is right, because that is not a fact about one resident.
 */
export async function issuePortalInvitations(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  rows: Array<{
    leaseId: string; residentId: string; email: string; confirmedRecipient: string;
  }>,
  options: { expiryDays?: number } = {},
): Promise<{
  issued: IssuedPortalInvitation[];
  failed: Array<{ residentName: string; reason: string }>;
}> {
  await requirePermission(tx, organisationId, 'resident.manage');
  if (rows.length === 0) throw invalid('Choose at least one resident to invite.');
  if (rows.length > 200) {
    throw invalid('Invite at most 200 residents at a time, so a mistake stays small.');
  }

  const issued: IssuedPortalInvitation[] = [];
  const failed: Array<{ residentName: string; reason: string }> = [];
  const sound: Array<typeof rows[number] & { leaseReference: string }> = [];

  for (const row of rows) {
    try {
      const review = await prepareInvitation(tx, organisationId, {
        leaseId: row.leaseId, residentId: row.residentId,
      });
      // The guard that makes this safe to do in bulk: the name the operator
      // READ on the review is compared with the resident on the lease now. If
      // somebody changed the parties while the page was open, this row stops
      // rather than sending one resident's statements to another.
      if (review.residentName !== row.confirmedRecipient) {
        failed.push({
          residentName: row.confirmedRecipient,
          reason: 'The resident on this lease has changed since the list was shown. '
            + 'Open the lease and invite them from there.',
        });
        continue;
      }
      if (review.existingPortalUser) {
        failed.push({
          residentName: row.confirmedRecipient,
          reason: `Already has portal access as ${review.existingPortalUser}.`,
        });
        continue;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email.trim())) {
        failed.push({
          residentName: row.confirmedRecipient,
          reason: 'That email address is not one this product will send a link to.',
        });
        continue;
      }
      sound.push({ ...row, leaseReference: review.leaseReference });
    } catch (error) {
      failed.push({
        residentName: row.confirmedRecipient,
        reason: error instanceof DomainError
          ? error.message
          : 'That resident could not be checked against their lease.',
      });
    }
  }

  for (const row of sound) {
    const result = await issueInvitation(tx, organisationId, actorUserId, {
      leaseId: row.leaseId,
      residentId: row.residentId,
      email: row.email,
      confirmedRecipient: row.confirmedRecipient,
      ...(options.expiryDays ? { expiryDays: options.expiryDays } : {}),
    });
    issued.push({
      residentName: row.confirmedRecipient,
      leaseReference: row.leaseReference,
      email: row.email.trim().toLowerCase(),
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
    });
  }

  return { issued, failed };
}
