import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { DomainError, parsed } from './errors';
import { requirePermission } from './permissions';

/**
 * Reading the audit trail.
 *
 * Every command writes an entry, in the same transaction as the change it
 * describes, and nothing could read one back. The trail existed for a dispute
 * nobody could open: answering "who changed this, when, and why" needed
 * database access.
 *
 * Three things this module will not do.
 *
 * It does not reconstruct a record from its history. The entries say what
 * changed; they are not a replacement for the record, and a viewer that
 * replayed them would be inventing a second source of truth.
 *
 * It does not unredact. Sensitive values were replaced with `[redacted]` at
 * write time, so an identity number or an account number was never in the
 * trail to begin with. There is deliberately no path here that could reveal
 * one — which is also why reading the trail is safe to give to an
 * administrator at all.
 *
 * It does not show a property-scoped member a filtered trail. An entry carries
 * the resource it touched, not the property that resource belongs to, so there
 * is no honest filter to apply. A quietly incomplete trail is worse than a
 * refusal, because somebody would rely on it.
 */

/** What an entry means to somebody who did not write the code. */
export interface AuditEntry {
  id: string;
  occurredAt: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  correlationId: string | null;
  /** Set when the action was taken during an authorised Spike support session. */
  supportSessionId: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** True when more entries exist beyond this page. */
  hasMore: boolean;
  /** Pass as `before` to read the next page. */
  nextCursor: string | null;
}

export interface AuditFilter {
  /** A prefix, so `deposit.` covers every deposit action. */
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  /** Inclusive, as a date in the organisation's own terms. */
  from?: string;
  /** Inclusive: the whole of this day is included. */
  to?: string;
  limit?: number;
  /** Keyset cursor: the id of the oldest entry already seen. */
  before?: string;
}

const filterSchema = z.object({
  action: z.string().trim().max(80).optional(),
  resourceType: z.string().trim().max(60).optional(),
  resourceId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in the form 2026-03-31.').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in the form 2026-03-31.').optional(),
  limit: z.number().int().min(1).max(200).optional(),
  before: z.string().regex(/^\d+$/).optional(),
});

/**
 * Refuses a property-scoped caller before reading anything.
 *
 * Separate from the permission check because the two say different things, and
 * the difference matters to whoever is reading the refusal: one is "you may
 * not", the other is "this cannot be answered for you honestly".
 */
async function requireOrganisationWideScope(tx: Sql, organisationId: string): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    select app.has_organisation_wide_scope(${organisationId}::uuid) as allowed
  `;
  if (!row?.allowed) {
    throw new DomainError(
      'forbidden',
      'The audit trail covers the whole organisation and cannot be narrowed to your assigned '
        + 'properties: an entry records the resource it changed, not which property that '
        + 'belongs to. Showing you part of it would look complete and not be.',
    );
  }
}

export async function listAuditEvents(
  tx: Sql,
  organisationId: string,
  filter: AuditFilter = {},
): Promise<AuditPage> {
  await requirePermission(tx, organisationId, 'audit.read');
  await requireOrganisationWideScope(tx, organisationId);
  const f = parsed(filterSchema, filter);

  if (f.from && f.to && f.from > f.to) {
    throw new DomainError(
      'validation_failed', 'The start of the range is after its end.',
    );
  }

  const limit = f.limit ?? 50;
  const rows = await tx<
    { id: string; occurred_at: string; action: string; resource_type: string;
      resource_id: string | null; actor_name: string | null; actor_email: string | null;
      actor_role: string | null; reason: string | null;
      before_state: Record<string, unknown> | null;
      after_state: Record<string, unknown> | null;
      correlation_id: string | null; support_session_id: string | null }[]
  >`
    select a.id::text, a.occurred_at::text, a.action, a.resource_type, a.resource_id,
           up.full_name as actor_name, up.email as actor_email, a.actor_role, a.reason,
           a.before_state, a.after_state, a.correlation_id, a.support_session_id
      from audit_events a
      left join user_profiles up on up.auth_user_id = a.actor_user_id
     where a.organisation_id = ${organisationId}::uuid
       ${f.action ? tx`and a.action like ${`${f.action}%`}` : tx``}
       ${f.resourceType ? tx`and a.resource_type = ${f.resourceType}` : tx``}
       ${f.resourceId ? tx`and a.resource_id = ${f.resourceId}::uuid` : tx``}
       ${f.actorUserId ? tx`and a.actor_user_id = ${f.actorUserId}::uuid` : tx``}
       ${f.from ? tx`and a.occurred_at >= ${f.from}::date` : tx``}
       -- The whole of the end day, not up to its midnight.
       ${f.to ? tx`and a.occurred_at < (${f.to}::date + 1)` : tx``}
       ${f.before ? tx`and a.id < ${f.before}::bigint` : tx``}
     order by a.id desc
     limit ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    entries: page.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      actorName: r.actor_name,
      actorEmail: r.actor_email,
      actorRole: r.actor_role,
      reason: r.reason,
      before: r.before_state,
      after: r.after_state,
      correlationId: r.correlation_id,
      supportSessionId: r.support_session_id,
    })),
    hasMore,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * One record's own history, newest first.
 *
 * The question an operator actually arrives with is never "show me the audit
 * trail" — it is "what happened to this lease". This is that, and it takes no
 * cursor because a single record's history is short enough to read.
 */
export async function auditHistoryFor(
  tx: Sql,
  organisationId: string,
  resource: { resourceType: string; resourceId: string },
  limit = 100,
): Promise<AuditEntry[]> {
  const page = await listAuditEvents(tx, organisationId, {
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    limit,
  });
  return page.entries;
}

/**
 * The actions and resource types the trail actually contains, for filters.
 *
 * Read from the data rather than a hard-coded list: every module adds its own
 * action names, and a list maintained by hand would drift and offer filters
 * that match nothing.
 */
export async function auditFacets(
  tx: Sql,
  organisationId: string,
): Promise<{
  actions: { action: string; count: number }[];
  resourceTypes: { resourceType: string; count: number }[];
  actors: { userId: string; name: string | null; count: number }[];
}> {
  await requirePermission(tx, organisationId, 'audit.read');
  await requireOrganisationWideScope(tx, organisationId);

  const [actions, resourceTypes, actors] = await Promise.all([
    tx<{ action: string; total: string }[]>`
      select action, count(*)::text as total from audit_events
       where organisation_id = ${organisationId}::uuid
       group by action order by action
       limit 300
    `,
    tx<{ resource_type: string; total: string }[]>`
      select resource_type, count(*)::text as total from audit_events
       where organisation_id = ${organisationId}::uuid
       group by resource_type order by resource_type
       limit 100
    `,
    tx<{ actor_user_id: string; full_name: string | null; total: string }[]>`
      select a.actor_user_id::text, up.full_name, count(*)::text as total
        from audit_events a
        left join user_profiles up on up.auth_user_id = a.actor_user_id
       where a.organisation_id = ${organisationId}::uuid
         and a.actor_user_id is not null
       group by a.actor_user_id, up.full_name
       order by up.full_name nulls last
       limit 100
    `,
  ]);

  return {
    actions: actions.map((a) => ({ action: a.action, count: Number(a.total) })),
    resourceTypes: resourceTypes.map((r) => ({
      resourceType: r.resource_type, count: Number(r.total),
    })),
    actors: actors.map((a) => ({
      userId: a.actor_user_id, name: a.full_name, count: Number(a.total),
    })),
  };
}

/**
 * What a change looks like side by side.
 *
 * Computed here rather than in a component, because "which fields changed" is
 * the one question every reader has and answering it differently in two places
 * is how two screens come to disagree about the same entry.
 */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
  /** A value the trail never held: it was replaced before it was written. */
  redacted: boolean;
}

export function changedFields(entry: AuditEntry): FieldChange[] {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  return keys
    .map((field) => {
      const from = (before as Record<string, unknown>)[field];
      const to = (after as Record<string, unknown>)[field];
      return {
        field,
        from,
        to,
        redacted: from === '[redacted]' || to === '[redacted]',
      };
    })
    // An entry that recorded only an "after" is a creation, and every field of
    // it is worth showing. One that recorded both is a change, and the fields
    // that are the same on both sides are noise.
    .filter((change) => (entry.before === null ? true : !sameValue(change.from, change.to)));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
