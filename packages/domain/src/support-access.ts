import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound, parsed } from './errors';
import { requirePermission } from './permissions';

/**
 * The customer's half of Spike support access.
 *
 * `platform.ts` is Spike asking. This is the customer deciding, and the two are
 * deliberately separate modules: the permission that governs everything here is
 * the customer's own `support.access.manage`, and nothing in this file consults
 * whether the caller is a Spike operator — an operator holds no customer
 * permission, so every function here refuses them by the ordinary route.
 *
 * Since migration 0065 a session the customer has not approved reaches nothing
 * at all. That makes these functions the access control rather than a record of
 * it, which is why each one fails loudly when row-level security refuses it
 * instead of reporting a decision that did not happen.
 */

export interface SupportSessionRow {
  id: string;
  operatorName: string;
  reason: string;
  grantedAt: string;
  expiresAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
  readOnly: boolean;
  authorisedByName: string | null;
  approvedViaGrant: boolean;
  actionsRecorded: number;
  /** Asked for, not answered: it exists, it is visible, and it reaches nothing. */
  waiting: boolean;
  /** Approved, unexpired and not revoked: Spike can read the records now. */
  live: boolean;
  /**
   * What this session may change, if anything. Empty is read-only, which is
   * what every session was before scopes existed.
   */
  scopes: string[];
}

export interface SupportScopeRow {
  key: string;
  name: string;
  description: string;
}

/**
 * The scopes a customer can choose from, with the words they will read.
 *
 * Reference data rather than a constant in the application: the same rows
 * decide what a scope ALLOWS, through `support_scope_permissions`, so a screen
 * cannot drift from what the database will actually permit.
 */
export async function supportScopes(tx: Sql): Promise<SupportScopeRow[]> {
  const rows = await tx<{ key: string; name: string; description: string }[]>`
    select key, name, description from support_scopes order by sort, key
  `;
  return rows;
}

/** The access log a CUSTOMER sees: who at Spike looked at their data, and why. */
export async function supportAccessHistory(
  tx: Sql,
  organisationId: string,
): Promise<SupportSessionRow[]> {
  const rows = await tx<
    { id: string; operator_name: string; reason: string; granted_at: string; expires_at: string;
      approved_at: string | null; revoked_at: string | null; read_only: boolean;
      authorised_by_name: string | null; approved_via_grant_id: string | null;
      actions_recorded: string; scopes: string[] }[]
  >`
    select s.id, s.reason, s.granted_at::text, s.expires_at::text,
           s.approved_at::text, s.revoked_at::text, s.read_only, s.scopes,
           s.approved_via_grant_id::text,
           op.full_name as operator_name,
           auth_by.full_name as authorised_by_name,
           (select count(*) from audit_events ae where ae.support_session_id = s.id)::text as actions_recorded
    from support_sessions s
    join user_profiles op on op.auth_user_id = s.operator_user_id
    left join user_profiles auth_by on auth_by.auth_user_id = s.authorised_by
    where s.organisation_id = ${organisationId}::uuid
    order by s.granted_at desc
  `;
  const now = Date.now();
  return rows.map((r) => {
    const unexpired = new Date(r.expires_at).getTime() > now;
    return {
      id: r.id,
      operatorName: r.operator_name,
      reason: r.reason,
      grantedAt: r.granted_at,
      expiresAt: r.expires_at,
      approvedAt: r.approved_at,
      revokedAt: r.revoked_at,
      readOnly: r.read_only,
      authorisedByName: r.authorised_by_name,
      approvedViaGrant: r.approved_via_grant_id !== null,
      actionsRecorded: Number(r.actions_recorded),
      waiting: r.approved_at === null && r.revoked_at === null && unexpired,
      live: r.approved_at !== null && r.revoked_at === null && unexpired,
      scopes: r.scopes,
    };
  });
}

export interface SupportAccessGrantRow {
  id: string;
  authorisedByName: string | null;
  reason: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  live: boolean;
  sessionsOpened: number;
  /** Empty means look and change nothing, which is the default. */
  scopes: string[];
}

/** Windows the customer has opened, newest first. */
export async function supportAccessGrants(
  tx: Sql,
  organisationId: string,
): Promise<SupportAccessGrantRow[]> {
  const rows = await tx<
    { id: string; authorised_by_name: string | null; reason: string; granted_at: string;
      expires_at: string; revoked_at: string | null; sessions_opened: string;
      scopes: string[] }[]
  >`
    select g.id, g.reason, g.granted_at::text, g.expires_at::text, g.revoked_at::text,
           g.scopes,
           by.full_name as authorised_by_name,
           (select count(*) from support_sessions s
             where s.approved_via_grant_id = g.id)::text as sessions_opened
      from support_access_grants g
      left join user_profiles by on by.auth_user_id = g.authorised_by
     where g.organisation_id = ${organisationId}::uuid
     order by g.granted_at desc
     limit 50
  `;
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    authorisedByName: r.authorised_by_name,
    reason: r.reason,
    grantedAt: r.granted_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    live: r.revoked_at === null && new Date(r.expires_at).getTime() > now,
    sessionsOpened: Number(r.sessions_opened),
    scopes: r.scopes,
  }));
}

/**
 * Approves one session the customer was asked about.
 *
 * Checked, not assumed: the UPDATE's own policy is
 * `support.access.manage`, and a policy that refuses makes the statement affect
 * no rows rather than raise. Without reading `returning`, somebody without the
 * permission would be told they had let support in, and support would still be
 * locked out — a confusion that would be blamed on the product for days.
 */
export async function approveSupportSession(
  tx: Sql,
  authUserId: string,
  params: {
    supportSessionId: string;
    /**
     * What this session may do, chosen HERE and nowhere else.
     *
     * The operator's request is a sentence in `reason`, not an entitlement:
     * the person approving reads it and decides. The database agrees — the
     * approval guard from 0066 lets `scopes` move only in this same
     * transition, and never afterwards.
     */
    scopes?: string[];
  },
): Promise<void> {
  const [session] = await tx<
    { id: string; organisation_id: string; approved_at: string | null;
      revoked_at: string | null; expired: boolean }[]
  >`
    select id, organisation_id, approved_at::text, revoked_at::text,
           (expires_at <= now()) as expired
      from support_sessions where id = ${params.supportSessionId}::uuid
  `;
  if (!session) throw notFound('Support session');
  if (session.revoked_at) throw invalid('That support session has already been ended.');
  if (session.expired) {
    throw invalid('That request has expired. Spike support will have to ask again.');
  }
  if (session.approved_at) return;   // Approving twice is not an error.

  // Two different refusals, and both have to read as refusals rather than as
  // faults. A member without `support.access.manage` is stopped by the row's
  // own UPDATE policy, which affects no rows — hence `returning`. A Spike
  // operator is stopped by the trigger from migration 0066, which raises
  // `insufficient_privilege`; mapped here so it arrives as a forbidden rather
  // than as an unexpected database error with the reason swallowed.
  let approved: { id: string }[];
  try {
    const scopes = params.scopes ?? [];
    approved = await tx<{ id: string }[]>`
      update support_sessions
         set approved_at = now(), authorised_by = ${authUserId}::uuid,
             scopes = ${scopes}, read_only = ${scopes.length === 0}
       where id = ${params.supportSessionId}::uuid
         and approved_at is null
         and revoked_at is null
      returning id
    `;
  } catch (error) {
    throw fromDatabaseError(error);
  }
  if (approved.length === 0) {
    throw new DomainError(
      'forbidden',
      'You cannot approve Spike support access for this organisation. An administrator can.',
    );
  }

  await recordAudit(tx, {
    organisationId: session.organisation_id,
    actorUserId: authUserId,
    action: 'support.session.approved',
    resourceType: 'support_session',
    resourceId: session.id,
    supportSessionId: session.id,
    after: { approvedBy: authUserId, scopes: params.scopes ?? [] },
  });
  await emitEvent(tx, {
    organisationId: session.organisation_id,
    eventType: 'support.session.approved',
    resourceType: 'support_session',
    resourceId: session.id,
    payload: { approvedBy: authUserId },
  });
}

export const grantSupportAccessSchema = z.object({
  hours: z.coerce.number().int().min(1).max(72),
  reason: z.string().trim().min(5, 'Say what this is for, so the record means something.').max(500),
  /**
   * What Spike may DO in this window, beyond reading. Empty is the default and
   * the old behaviour: look, change nothing.
   */
  scopes: z.array(z.string().trim().min(2).max(40)).max(8).default([]),
});

/**
 * Opens a window during which Spike may let itself in.
 *
 * The case this exists for: a customer is about to raise a ticket and would
 * rather support could look now than be asked for an approval they are sitting
 * waiting to give. It is bounded in hours, attributed to the person who opened
 * it, and revocable in one action — and a session opened inside it records
 * which window admitted it, so the trail still answers "who let them in".
 */
export async function grantSupportAccess(
  tx: Sql,
  organisationId: string,
  authUserId: string,
  input: z.input<typeof grantSupportAccessSchema>,
): Promise<{ grantId: string; expiresAt: Date }> {
  await requirePermission(tx, organisationId, 'support.access.manage');
  const g = parsed(grantSupportAccessSchema, input);

  const expiresAt = new Date(Date.now() + g.hours * 3_600_000);
  const [row] = await tx<{ id: string }[]>`
    insert into support_access_grants (
      organisation_id, authorised_by, reason, expires_at, scopes
    )
    values (
      ${organisationId}, ${authUserId}, ${g.reason}, ${expiresAt.toISOString()}, ${g.scopes}
    )
    returning id
  `;
  if (!row) throw new DomainError('internal', 'Support access grant insert returned no row.');

  await recordAudit(tx, {
    organisationId,
    actorUserId: authUserId,
    action: 'support.access.window_opened',
    resourceType: 'support_access_grant',
    resourceId: row.id,
    reason: g.reason,
    after: { expiresAt: expiresAt.toISOString(), hours: g.hours, scopes: g.scopes },
  });
  return { grantId: row.id, expiresAt };
}

/**
 * Closes a window early.
 *
 * It does NOT end sessions already approved under it. Those are separate
 * records with their own expiry and their own revoke, and silently ending them
 * here would mean the customer could not tell, from the window alone, what
 * access they had just taken away.
 */
export async function revokeSupportAccessGrant(
  tx: Sql,
  authUserId: string,
  params: { grantId: string },
): Promise<{ sessionsStillLive: number }> {
  const [grant] = await tx<{ id: string; organisation_id: string; revoked_at: string | null }[]>`
    select id, organisation_id, revoked_at::text from support_access_grants
    where id = ${params.grantId}::uuid
  `;
  if (!grant) throw notFound('Support access window');
  if (grant.revoked_at) return { sessionsStillLive: 0 };

  const closed = await tx<{ id: string }[]>`
    update support_access_grants
       set revoked_at = now(), revoked_by = ${authUserId}::uuid
     where id = ${params.grantId}::uuid and revoked_at is null
    returning id
  `;
  if (closed.length === 0) {
    throw new DomainError(
      'forbidden',
      'You cannot close this support access window. An administrator can.',
    );
  }

  const [live] = await tx<{ n: string }[]>`
    select count(*)::text as n from support_sessions
     where approved_via_grant_id = ${params.grantId}::uuid
       and revoked_at is null and expires_at > now()
  `;

  await recordAudit(tx, {
    organisationId: grant.organisation_id,
    actorUserId: authUserId,
    action: 'support.access.window_closed',
    resourceType: 'support_access_grant',
    resourceId: grant.id,
    after: { sessionsStillLive: Number(live?.n ?? 0) },
  });
  return { sessionsStillLive: Number(live?.n ?? 0) };
}

/** Everything the customer's support-access screen shows, in one read. */
export async function supportAccessState(
  tx: Sql,
  organisationId: string,
): Promise<{
  sessions: SupportSessionRow[];
  grants: SupportAccessGrantRow[];
  waiting: SupportSessionRow[];
  live: SupportSessionRow[];
  openWindow: SupportAccessGrantRow | null;
}> {
  const [sessions, grants] = await Promise.all([
    supportAccessHistory(tx, organisationId),
    supportAccessGrants(tx, organisationId),
  ]);
  return {
    sessions,
    grants,
    waiting: sessions.filter((s) => s.waiting),
    live: sessions.filter((s) => s.live),
    openWindow: grants.find((g) => g.live) ?? null,
  };
}
