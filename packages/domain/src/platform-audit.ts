import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { parsed } from './errors';
import { requirePlatformPermission } from './platform';

/**
 * What Spike has done.
 *
 * One question, asked of the whole platform rather than one customer at a
 * time: which operator did what, to whose account, when, why, and whether it
 * happened inside the customer's own records under a session they approved.
 *
 * The set is defined narrowly and on purpose. A row qualifies if it is a
 * `platform.%` action — Spike acting on an account: provisioning, plans,
 * suspensions, operators, invoices — or if it carries a support session id,
 * which 0074's trigger stamps on anything done under a session. Both are
 * Spike's own conduct. A landlord's staff changing their own lease is neither,
 * and this never returns it, even where a live session would technically let
 * the caller read it: a review tool that quietly becomes a window into
 * customer data is the thing the whole support-session design exists to
 * prevent.
 *
 * See docs/decisions/0023-reviewing-spikes-own-conduct.md.
 */

export interface PlatformAuditRow {
  id: string;
  at: string;
  action: string;
  actorName: string | null;
  /** The customer this happened to, where there is one. Platform-level actions have none. */
  organisationName: string | null;
  organisationSlug: string | null;
  reason: string | null;
  resourceType: string;
  resourceId: string | null;
  /** Set when this was done inside the customer's records under a session. */
  supportSessionId: string | null;
  /** What that session was allowed to change. Empty on a read-only session. */
  supportScopes: string[];
  /** Who at the customer approved the session, which is what makes it legitimate. */
  approvedByName: string | null;
}

export const platformAuditFilterSchema = z.object({
  /** 'support' is the one reviewers ask for: changes inside customer records. */
  kind: z.enum(['all', 'platform', 'support']).default('all'),
  operatorUserId: z.string().uuid().optional(),
  organisationId: z.string().uuid().optional(),
  /** Matched as a prefix, so `platform.operator` finds every operator action. */
  action: z.string().trim().max(80).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type PlatformAuditFilter = z.input<typeof platformAuditFilterSchema>;

export async function platformAuditTrail(
  tx: Sql,
  authUserId: string,
  filter: PlatformAuditFilter = {},
): Promise<{ rows: PlatformAuditRow[]; total: number; capped: boolean }> {
  await requirePlatformPermission(tx, authUserId, 'platform.audit.read');
  const f = parsed(platformAuditFilterSchema, filter);

  // The review set, stated once and used by both queries below, so the count
  // under the table can never describe a different set from the table.
  const reviewable = f.kind === 'platform'
    ? tx`ae.action like 'platform.%'`
    : f.kind === 'support'
      ? tx`ae.support_session_id is not null`
      : tx`(ae.action like 'platform.%' or ae.support_session_id is not null)`;

  const conditions = [
    reviewable,
    f.operatorUserId ? tx`ae.actor_user_id = ${f.operatorUserId}::uuid` : tx`true`,
    f.organisationId ? tx`ae.organisation_id = ${f.organisationId}::uuid` : tx`true`,
    f.action ? tx`ae.action like ${`${f.action}%`}` : tx`true`,
    f.from ? tx`ae.occurred_at >= ${f.from}::date` : tx`true`,
    // Inclusive of the whole closing day: a reviewer asking for "to the 7th"
    // means the end of the 7th, and a half-open range silently drops it.
    f.to ? tx`ae.occurred_at < (${f.to}::date + 1)` : tx`true`,
  ];
  const where = conditions.reduce((acc, c) => tx`${acc} and ${c}`);

  const rows = await tx<Array<{
    id: string; occurred_at: string; action: string; actor_name: string | null;
    organisation_name: string | null; organisation_slug: string | null;
    reason: string | null; resource_type: string; resource_id: string | null;
    support_session_id: string | null; support_scopes: string[] | null;
    approved_by_name: string | null;
  }>>`
    select ae.id, ae.occurred_at::text, ae.action, ae.reason,
           ae.resource_type, ae.resource_id::text, ae.support_session_id::text,
           actor.full_name as actor_name,
           o.name as organisation_name, o.slug as organisation_slug,
           s.scopes as support_scopes,
           approver.full_name as approved_by_name
      from audit_events ae
      left join user_profiles actor on actor.auth_user_id = ae.actor_user_id
      left join organisations o on o.id = ae.organisation_id
      left join support_sessions s on s.id = ae.support_session_id
      left join user_profiles approver on approver.auth_user_id = s.authorised_by
     where ${where}
     order by ae.occurred_at desc
     limit ${f.limit}
  `;

  const [counted] = await tx<{ n: string }[]>`
    select count(*)::text as n from audit_events ae where ${where}
  `;
  const total = Number(counted?.n ?? 0);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      at: r.occurred_at,
      action: r.action,
      actorName: r.actor_name,
      organisationName: r.organisation_name,
      organisationSlug: r.organisation_slug,
      reason: r.reason,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      supportSessionId: r.support_session_id,
      supportScopes: r.support_scopes ?? [],
      approvedByName: r.approved_by_name,
    })),
    total,
    // Said rather than implied: a reviewer looking at a truncated list needs
    // to know it is truncated before they conclude anything from it.
    capped: total > rows.length,
  };
}

/**
 * The choices the filters offer, drawn from what is actually there.
 *
 * Built from the reviewable rows themselves rather than from the full
 * operator and customer lists, so the dropdowns cannot offer a combination
 * that returns nothing, and so a reviewer sees at a glance which colleagues
 * and which accounts appear at all.
 */
export async function platformAuditChoices(
  tx: Sql,
  authUserId: string,
): Promise<{
  operators: Array<{ authUserId: string; fullName: string; actions: number }>;
  customers: Array<{ organisationId: string; name: string; actions: number }>;
  actions: Array<{ action: string; actions: number }>;
}> {
  await requirePlatformPermission(tx, authUserId, 'platform.audit.read');

  const reviewable = tx`
    (ae.action like 'platform.%' or ae.support_session_id is not null)
  `;

  const operators = await tx<Array<{ id: string; full_name: string; n: string }>>`
    select ae.actor_user_id as id, p.full_name, count(*)::text as n
      from audit_events ae
      join user_profiles p on p.auth_user_id = ae.actor_user_id
     where ${reviewable} and ae.actor_user_id is not null
     group by ae.actor_user_id, p.full_name
     order by count(*) desc
     limit 100
  `;
  const customers = await tx<Array<{ id: string; name: string; n: string }>>`
    select ae.organisation_id as id, o.name, count(*)::text as n
      from audit_events ae
      join organisations o on o.id = ae.organisation_id
     where ${reviewable}
     group by ae.organisation_id, o.name
     order by count(*) desc
     limit 200
  `;
  const actions = await tx<Array<{ action: string; n: string }>>`
    select ae.action, count(*)::text as n
      from audit_events ae
     where ${reviewable}
     group by ae.action
     order by ae.action
     limit 200
  `;

  return {
    operators: operators.map((o) => ({
      authUserId: o.id, fullName: o.full_name, actions: Number(o.n),
    })),
    customers: customers.map((c) => ({
      organisationId: c.id, name: c.name, actions: Number(c.n),
    })),
    actions: actions.map((a) => ({ action: a.action, actions: Number(a.n) })),
  };
}

/**
 * The shape of the last thirty days, for the top of the screen.
 *
 * Deliberately three numbers and not a chart: what a reviewer opens this page
 * to find out is whether anybody has been inside customer records lately, and
 * how many of those visits the customer had actually authorised to change
 * something.
 */
export async function platformAuditSummary(
  tx: Sql,
  authUserId: string,
): Promise<{
  platformActions: number;
  actionsUnderSessions: number;
  sessionsUsed: number;
  customersTouched: number;
}> {
  await requirePlatformPermission(tx, authUserId, 'platform.audit.read');

  const [row] = await tx<Array<{
    platform_actions: string; under_sessions: string; sessions_used: string;
    customers_touched: string;
  }>>`
    select
      count(*) filter (where ae.action like 'platform.%')::text as platform_actions,
      count(*) filter (where ae.support_session_id is not null)::text as under_sessions,
      count(distinct ae.support_session_id)::text as sessions_used,
      count(distinct ae.organisation_id) filter (
        where ae.support_session_id is not null
      )::text as customers_touched
      from audit_events ae
     where (ae.action like 'platform.%' or ae.support_session_id is not null)
       and ae.occurred_at >= now() - interval '30 days'
  `;
  return {
    platformActions: Number(row?.platform_actions ?? 0),
    actionsUnderSessions: Number(row?.under_sessions ?? 0),
    sessionsUsed: Number(row?.sessions_used ?? 0),
    customersTouched: Number(row?.customers_touched ?? 0),
  };
}
