import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { forbidden, invalid, notFound, parsed } from './errors';
import { requirePlatformPermission } from './platform';

/**
 * A customer leaving.
 *
 * Closing an account used to be a column. This module makes it a process with
 * three parts, in this order and no other: the account closes with a reason
 * and a date, the customer takes their records while the clock runs, and the
 * records are destroyed once the clock has run out.
 *
 * The two things worth knowing before reading any of it:
 *
 * **Nothing here runs on its own.** The retention date does not destroy
 * anything when it passes; it only stops being a refusal. A product that
 * deletes a landlord's tenancy history on a timer is a product that deletes it
 * the first time somebody fat-fingers a date.
 *
 * **Destruction is the customer's records, not Spike's.** Spike keeps its
 * invoices to them, its own audit of what it did to the account, and the
 * record of the support sessions they authorised. The keep list lives in
 * `app.destroy_organisation_data` with the reasoning beside it.
 */

export interface CustomerClosure {
  organisationId: string;
  closedAt: string;
  closedByName: string | null;
  reason: string;
  retainUntil: string;
  destroyedAt: string | null;
  destroyedByName: string | null;
  destructionReason: string | null;
  rowsDestroyed: number | null;
  objectsRemoved: number | null;
  /** Stored files that would not delete, so somebody can finish the job. */
  objectsLeft: string[];
  /** True once the retention date has passed and destruction is permitted. */
  destructionDue: boolean;
}

const closeSchema = z.object({
  organisationId: z.string().uuid(),
  reason: z.string().trim().min(5).max(500),
  /** Omitted takes the platform default, `offboarding.retention_months`. */
  retainMonths: z.number().int().min(0).max(240).optional(),
});

const destroySchema = z.object({
  organisationId: z.string().uuid(),
  reason: z.string().trim().min(5).max(500),
  /**
   * The customer's slug, typed by the operator. Not security — they already
   * hold the permission — but the one irreversible action in the console
   * should be impossible to take by clicking the wrong row's button.
   */
  confirmSlug: z.string().trim().min(1),
});

/**
 * Closes an account, with a reason and the date its records may be destroyed.
 *
 * This is the only way to reach `closed`: `setAccountStatus` refuses that
 * status now, because a closed account with no retention date is an account
 * nobody can either destroy or honestly tell the customer about.
 *
 * Reopening is still `setAccountStatus`, which removes the closure row — the
 * clock stops because the customer stayed, which is the right outcome and is
 * audited either way.
 */
export async function closeCustomer(
  tx: Sql,
  authUserId: string,
  params: z.input<typeof closeSchema>,
): Promise<{ retainUntil: string }> {
  const input = parsed(closeSchema, params);
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.customers.status');

  const [organisation] = await tx<{ status: string; name: string }[]>`
    select status::text, name from organisations where id = ${input.organisationId}::uuid
  `;
  if (!organisation) throw notFound('Organisation');
  if (organisation.status === 'closed') throw invalid('That account is already closed.');

  const [configured] = await tx<{ months: number }[]>`
    select app.setting_number('offboarding.retention_months') as months
  `;
  const months = input.retainMonths ?? Number(configured?.months ?? 60);

  const [closed] = await tx<{ retain_until: string }[]>`
    insert into organisation_closures (organisation_id, closed_by, reason, retain_until)
    values (
      ${input.organisationId}::uuid, ${operator.authUserId}::uuid, ${input.reason},
      (current_date + make_interval(months => ${months}))::date
    )
    returning retain_until::text
  `;
  const retainUntil = closed?.retain_until ?? '';

  await tx`
    update organisations set status = 'closed', updated_at = now()
    where id = ${input.organisationId}::uuid
  `;

  await recordAudit(tx, {
    organisationId: input.organisationId,
    actorUserId: operator.authUserId,
    action: 'platform.account.closed',
    resourceType: 'organisation',
    resourceId: input.organisationId,
    reason: input.reason,
    before: { status: organisation.status },
    after: { status: 'closed', retainUntil },
  });
  // `platform.account.status_changed` rather than a closure event of its own:
  // OUTBOX_EVENT_TYPES is a closed list precisely because an event no handler
  // is registered for is retried and then dead, and this status did change.
  await emitEvent(tx, {
    organisationId: input.organisationId,
    eventType: 'platform.account.status_changed',
    resourceType: 'organisation',
    resourceId: input.organisationId,
    payload: { from: organisation.status, to: 'closed', retainUntil, retainMonths: months },
  });

  return { retainUntil };
}

/** How long a closure keeps records by default, for the form to show. */
export async function retentionMonthsDefault(tx: Sql): Promise<number> {
  const [row] = await tx<{ months: number }[]>`
    select app.setting_number('offboarding.retention_months') as months
  `;
  return Number(row?.months ?? 60);
}

/**
 * The closure, for whoever is allowed to read it.
 *
 * Both sides call this. An operator sees it on the customer's page; the
 * customer sees it on the page they are sent to instead of their console,
 * because a date Spike can see and they cannot is not notice of anything.
 */
export async function customerClosure(
  tx: Sql,
  organisationId: string,
): Promise<CustomerClosure | null> {
  const [row] = await tx<{
    organisation_id: string;
    closed_at: string;
    closed_by_name: string | null;
    reason: string;
    retain_until: string;
    destroyed_at: string | null;
    destroyed_by_name: string | null;
    destruction_reason: string | null;
    rows_destroyed: number | null;
    objects_removed: number | null;
    objects_left: string[] | null;
    due: boolean;
  }[]>`
    select c.organisation_id::text, c.closed_at::text, closer.full_name as closed_by_name,
           c.reason, c.retain_until::text, c.destroyed_at::text,
           destroyer.full_name as destroyed_by_name, c.destruction_reason, c.rows_destroyed,
           c.objects_removed, c.objects_left,
           c.retain_until <= current_date as due
    from organisation_closures c
    left join user_profiles closer on closer.auth_user_id = c.closed_by
    left join user_profiles destroyer on destroyer.auth_user_id = c.destroyed_by
    where c.organisation_id = ${organisationId}::uuid
  `;
  if (!row) return null;
  return {
    organisationId: row.organisation_id,
    closedAt: row.closed_at,
    closedByName: row.closed_by_name,
    reason: row.reason,
    retainUntil: row.retain_until,
    destroyedAt: row.destroyed_at,
    destroyedByName: row.destroyed_by_name,
    destructionReason: row.destruction_reason,
    rowsDestroyed: row.rows_destroyed,
    objectsRemoved: row.objects_removed,
    objectsLeft: row.objects_left ?? [],
    destructionDue: row.due,
  };
}

/** Closed accounts and where each one is in its retention period. */
export async function listClosures(
  tx: Sql,
  authUserId: string,
): Promise<Array<CustomerClosure & { name: string; slug: string }>> {
  await requirePlatformPermission(tx, authUserId, 'platform.customers.read');
  const rows = await tx<{
    organisation_id: string; name: string; slug: string; closed_at: string;
    closed_by_name: string | null; reason: string; retain_until: string;
    destroyed_at: string | null; destroyed_by_name: string | null;
    destruction_reason: string | null; rows_destroyed: number | null;
    objects_removed: number | null; objects_left: string[] | null; due: boolean;
  }[]>`
    select c.organisation_id::text, o.name, o.slug, c.closed_at::text,
           closer.full_name as closed_by_name, c.reason, c.retain_until::text,
           c.destroyed_at::text, destroyer.full_name as destroyed_by_name,
           c.destruction_reason, c.rows_destroyed, c.objects_removed, c.objects_left,
           c.retain_until <= current_date as due
    from organisation_closures c
    join organisations o on o.id = c.organisation_id
    left join user_profiles closer on closer.auth_user_id = c.closed_by
    left join user_profiles destroyer on destroyer.auth_user_id = c.destroyed_by
    order by c.destroyed_at nulls first, c.retain_until
  `;
  return rows.map((row) => ({
    organisationId: row.organisation_id,
    name: row.name,
    slug: row.slug,
    closedAt: row.closed_at,
    closedByName: row.closed_by_name,
    reason: row.reason,
    retainUntil: row.retain_until,
    destroyedAt: row.destroyed_at,
    destroyedByName: row.destroyed_by_name,
    destructionReason: row.destruction_reason,
    rowsDestroyed: row.rows_destroyed,
    objectsRemoved: row.objects_removed,
    objectsLeft: row.objects_left ?? [],
    destructionDue: row.due,
  }));
}

/**
 * Destroys a closed customer's records.
 *
 * Irreversible, and the only thing in this product that is. The refusals are
 * in `app.destroy_organisation_data` as well as here, because that function is
 * executable by the application role and a guard that only exists in
 * TypeScript guards only the callers who went through TypeScript.
 *
 * The audit entry is written after the purge on purpose: the purge deletes the
 * customer's own audit rows, and an entry written before it would be deleting
 * itself. `platform.%` entries survive, which is what this one is.
 *
 * It returns the **storage keys** of the customer's documents. Rows are not the
 * whole of a customer's data: a lease agreement, an inspection photograph and
 * an identity document are objects in a bucket, and `documents.storage_key` is
 * the only record of where each one is. Deleting that row without removing the
 * object leaves the file in place with nothing left to find it by, which is
 * worse than not destroying anything.
 *
 * The keys come from `app.destroy_organisation_data` rather than from a query
 * here, and that is not a detail. `documents` is keyed on membership, an
 * operator is a member of nothing, and this function runs under the operator's
 * own context — so reading the table here returns no rows and every file would
 * be left in the bucket. The first version of this did exactly that and the
 * test suite did not catch it, because the test harness lifts row-level
 * filtering for platform operators and production does not.
 *
 * The caller removes the objects once this transaction has committed — object
 * storage has no rollback, so it cannot be done inside it — and records the
 * outcome through `recordDestroyedObjects`.
 */
export interface DestroyedObject { key: string }

export async function destroyCustomerData(
  tx: Sql,
  authUserId: string,
  params: z.input<typeof destroySchema>,
): Promise<{ rowsDestroyed: number; objects: DestroyedObject[] }> {
  const input = parsed(destroySchema, params);
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.customers.destroy');

  const [organisation] = await tx<{ slug: string; status: string; name: string }[]>`
    select slug, status::text, name from organisations where id = ${input.organisationId}::uuid
  `;
  if (!organisation) throw notFound('Organisation');
  if (organisation.status !== 'closed') {
    throw invalid('Only a closed account can have its records destroyed.');
  }
  if (input.confirmSlug !== organisation.slug) {
    throw invalid(
      `To destroy these records, type the account's identifier exactly: ${organisation.slug}.`,
    );
  }

  const closure = await customerClosure(tx, input.organisationId);
  if (!closure) throw invalid('That account has no closure record, so nothing can be destroyed.');
  if (closure.destroyedAt) {
    throw invalid(`Those records were destroyed on ${closure.destroyedAt.slice(0, 10)}.`);
  }
  if (!closure.destructionDue) {
    throw invalid(
      `Those records are retained until ${closure.retainUntil}. `
      + 'Shorten the retention period if the customer has asked for them sooner.',
    );
  }

  const [purge] = await tx<{ rows_destroyed: number; storage_keys: string[] }[]>`
    select rows_destroyed, storage_keys
    from app.destroy_organisation_data(${input.organisationId}::uuid)
  `;
  const destroyed = Number(purge?.rows_destroyed ?? 0);
  const keys = purge?.storage_keys ?? [];

  await tx`
    update organisation_closures
       set destroyed_at = now(), destroyed_by = ${operator.authUserId}::uuid,
           destruction_reason = ${input.reason}, rows_destroyed = ${destroyed}
     where organisation_id = ${input.organisationId}::uuid
  `;

  await recordAudit(tx, {
    organisationId: input.organisationId,
    actorUserId: operator.authUserId,
    action: 'platform.account.data_destroyed',
    resourceType: 'organisation',
    resourceId: input.organisationId,
    reason: input.reason,
    before: { status: 'closed', retainUntil: closure.retainUntil },
    after: { rowsDestroyed: Number(destroyed) },
  });

  // No event: the outbox rows for this organisation were just deleted, and a
  // notification about a customer who no longer has anybody to notify is a job
  // that exists only to fail.

  return { rowsDestroyed: destroyed, objects: keys.map((key) => ({ key })) };
}

/**
 * What became of the files, written down after the objects were dealt with.
 *
 * Separate from `destroyCustomerData` because object storage has no rollback:
 * the rows have to be gone before anything is removed from a bucket, or a
 * failure halfway leaves rows pointing at files that are not there. The keys
 * that would not delete are kept so that somebody can finish it — a file left
 * behind with its key written down is a job; a file left behind with its key
 * deleted is personal information nobody can ever find again.
 */
export async function recordDestroyedObjects(
  tx: Sql,
  authUserId: string,
  params: { organisationId: string; removed: number; left: string[] },
): Promise<void> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.customers.destroy');

  const written = await tx<{ organisation_id: string }[]>`
    update organisation_closures
       set objects_removed = ${params.removed},
           objects_left = ${params.left.length > 0 ? params.left : null}
     where organisation_id = ${params.organisationId}::uuid
       and destroyed_at is not null
    returning organisation_id::text
  `;
  if (written.length === 0) {
    throw invalid('There is no destroyed closure to record files against.');
  }

  if (params.left.length > 0) {
    await recordAudit(tx, {
      organisationId: params.organisationId,
      actorUserId: operator.authUserId,
      action: 'platform.account.objects_left',
      resourceType: 'organisation',
      resourceId: params.organisationId,
      reason: `${params.left.length} stored file(s) could not be removed and are still in the bucket.`,
      before: null,
      after: { removed: params.removed, left: params.left.length },
    });
  }
}

/**
 * Shortens or extends how long a closed customer's records are kept.
 *
 * The case that needs it is a customer asking for their data to be removed
 * now: the default is five years, their request is today, and the alternative
 * would be an operator editing a date in the database.
 *
 * It takes `platform.customers.destroy` rather than the permission that closed
 * the account. Setting the clock while closing is one decision; moving it
 * afterwards decides when the records may be destroyed, so it belongs to the
 * same hand that may destroy them. Support can close an account and cannot
 * bring its destruction forward.
 */
export async function setRetention(
  tx: Sql,
  authUserId: string,
  params: { organisationId: string; retainUntil: string; reason: string },
): Promise<void> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.customers.destroy');
  if (params.reason.trim().length < 5) {
    throw invalid('Moving a retention date requires a reason.');
  }

  const closure = await customerClosure(tx, params.organisationId);
  if (!closure) throw notFound('Closure');
  if (closure.destroyedAt) throw invalid('Those records have already been destroyed.');

  // Row Level Security refuses an UPDATE by returning no rows rather than by
  // raising, so the returning clause is the check: without it a caller the
  // policy turned away would be told it worked.
  const moved = await tx<{ organisation_id: string }[]>`
    update organisation_closures set retain_until = ${params.retainUntil}::date
    where organisation_id = ${params.organisationId}::uuid
    returning organisation_id::text
  `;
  if (moved.length === 0) throw forbidden('That retention date could not be changed.');

  await recordAudit(tx, {
    organisationId: params.organisationId,
    actorUserId: operator.authUserId,
    action: 'platform.account.retention_changed',
    resourceType: 'organisation',
    resourceId: params.organisationId,
    reason: params.reason,
    before: { retainUntil: closure.retainUntil },
    after: { retainUntil: params.retainUntil },
  });
}
