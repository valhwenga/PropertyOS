import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import { nextDocumentNumber } from './numbering';
import { requirePermission, requirePropertyScope } from './permissions';

export const draftLeaseSchema = z.object({
  unitId: z.string().uuid(),
  startDate: z.string().date(),
  endDate: z.string().date().optional(),
  rentMinor: z.bigint().nonnegative(),
  billingDay: z.number().int().min(1).max(31).default(1),
  depositRequiredMinor: z.bigint().nonnegative().default(0n),
  prorationMethod: z.enum(['actual_days', 'none']).default('actual_days'),
  escalationPercent: z.number().min(0).max(100).optional(),
  escalationMonthInterval: z.number().int().min(1).max(60).optional(),
  noticeDays: z.number().int().min(0).max(365).optional(),
  parties: z
    .array(
      z.object({
        residentId: z.string().uuid(),
        role: z.enum(['primary_resident', 'co_lessee', 'guarantor', 'occupant']),
        canViewFinancials: z.boolean().default(false),
      }),
    )
    .min(1),
});

/**
 * Creates a DRAFT lease.
 *
 * A draft has no billing effect and deliberately does not reserve the unit, so
 * two operators may both draft against one unit; only one of them will be able
 * to activate.
 */
export async function draftLease(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof draftLeaseSchema>,
): Promise<{ leaseId: string; reference: string }> {
  const l = draftLeaseSchema.parse(input);
  await requirePermission(tx, organisationId, 'lease.create');

  const [unit] = await tx<{ id: string; property_id: string }[]>`
    select id, property_id from units
    where id = ${l.unitId}::uuid and organisation_id = ${organisationId}::uuid and status = 'active'
  `;
  if (!unit) throw notFound('Unit');
  await requirePropertyScope(tx, organisationId, unit.property_id);

  const primaries = l.parties.filter((p) => p.role === 'primary_resident');
  if (primaries.length !== 1) {
    throw invalid('A lease needs exactly one primary resident.');
  }

  const [org] = await tx<{ currency_code: string }[]>`
    select currency_code from organisations where id = ${organisationId}::uuid
  `;
  if (!org) throw notFound('Organisation');

  const reference = await nextDocumentNumber(tx, organisationId, 'LSE');

  try {
    const [lease] = await tx<{ id: string }[]>`
      insert into leases (
        organisation_id, property_id, unit_id, reference, status,
        start_date, end_date, rent_minor, currency_code, billing_day,
        proration_method, deposit_required_minor, escalation_percent,
        escalation_month_interval, notice_days
      ) values (
        ${organisationId}, ${unit.property_id}, ${l.unitId}, ${reference}, 'draft',
        ${l.startDate}, ${l.endDate ?? null}, ${l.rentMinor.toString()},
        ${org.currency_code}, ${l.billingDay}, ${l.prorationMethod},
        ${l.depositRequiredMinor.toString()}, ${l.escalationPercent ?? null},
        ${l.escalationMonthInterval ?? null}, ${l.noticeDays ?? null}
      )
      returning id
    `;
    if (!lease) throw new DomainError('internal', 'Lease insert returned no row.');

    await tx`
      insert into lease_parties ${tx(
        l.parties.map((p) => ({
          organisation_id: organisationId,
          lease_id: lease.id,
          resident_id: p.residentId,
          role: p.role,
          // Guarantors and household occupants do not receive financial
          // visibility automatically; it must be granted explicitly.
          can_view_financials:
            p.role === 'primary_resident' ? true : p.canViewFinancials,
          joined_on: l.startDate,
        })),
      )}
    `;

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'lease.drafted', resourceType: 'lease', resourceId: lease.id,
      after: { reference, unitId: l.unitId, startDate: l.startDate, rentMinor: l.rentMinor.toString() },
    });
    return { leaseId: lease.id, reference };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

export interface ActivateLeaseInput {
  leaseId: string;
  /** Compare-and-swap guard: a stale edit is rejected rather than overwriting. */
  expectedVersion: number;
  activationDate: string;
  executedDocumentId?: string;
  /** Required when no executed contract is attached; recorded on the lease. */
  executionExceptionReason?: string;
  /** Creates the rent schedule that recurring billing will use. */
  createRentSchedule?: boolean;
  /** Records physical occupancy from the activation date. */
  recordOccupancy?: boolean;
}

/**
 * Activates a lease.
 *
 * This is the atomic step that turns a draft into a contract that reserves a
 * unit. The unit conflict check is NOT a read-then-write in application code:
 * the exclusion constraint on (unit_id, reserved_period) decides, so two
 * concurrent activations cannot both succeed.
 */
export async function activateLease(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: ActivateLeaseInput,
): Promise<{ leaseId: string; status: string }> {
  await requirePermission(tx, organisationId, 'lease.activate');

  const [lease] = await tx<
    {
      id: string; property_id: string; unit_id: string; status: string; version: number;
      start_date: string; end_date: string | null; rent_minor: string; currency_code: string;
      billing_day: number; proration_method: string; reference: string;
    }[]
  >`
    select id, property_id, unit_id, status, version, start_date, end_date,
           rent_minor, currency_code, billing_day, proration_method, reference
    from leases
    where id = ${input.leaseId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!lease) throw notFound('Lease');
  await requirePropertyScope(tx, organisationId, lease.property_id);

  if (lease.version !== input.expectedVersion) {
    throw new DomainError(
      'stale_version',
      'This lease was changed by someone else. Reload and review before activating.',
    );
  }
  if (lease.status !== 'draft' && lease.status !== 'awaiting_execution') {
    throw new DomainError('conflict', `A lease in state "${lease.status}" cannot be activated.`);
  }
  if (!input.executedDocumentId && !input.executionExceptionReason?.trim()) {
    throw invalid(
      'Activation requires either an attached executed contract or a recorded exception reason.',
    );
  }

  try {
    const [updated] = await tx<{ id: string; status: string }[]>`
      update leases set
        status = 'active',
        activated_at = ${input.activationDate}::date,
        activated_by = ${actorUserId},
        executed_document_id = ${input.executedDocumentId ?? null},
        execution_exception_reason = ${input.executionExceptionReason ?? null},
        executed_at = ${input.executedDocumentId ? tx`now()` : null},
        version = version + 1,
        updated_at = now()
      where id = ${input.leaseId}::uuid and organisation_id = ${organisationId}::uuid
        and version = ${input.expectedVersion}
      returning id, status
    `;
    if (!updated) throw new DomainError('stale_version', 'The lease changed during activation. Please retry.');

    if (input.createRentSchedule !== false) {
      await tx`
        insert into charge_schedules (
          organisation_id, lease_id, category, description, amount_minor,
          currency_code, effective_period, due_day, created_by
        ) values (
          ${organisationId}, ${lease.id}, 'rent', 'Monthly rent',
          ${lease.rent_minor}, ${lease.currency_code},
          daterange(${lease.start_date}::date, ${lease.end_date}::date, '[]'),
          ${lease.billing_day}, ${actorUserId}
        )
      `;
    }

    if (input.recordOccupancy !== false) {
      await tx`
        insert into occupancy_intervals (
          organisation_id, unit_id, lease_id, period, move_in_at
        ) values (
          ${organisationId}, ${lease.unit_id}, ${lease.id},
          daterange(${input.activationDate}::date, ${lease.end_date}::date, '[]'),
          ${input.activationDate}::date
        )
      `;
    }

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'lease.activated', resourceType: 'lease', resourceId: lease.id,
      reason: input.executionExceptionReason ?? null,
      before: { status: lease.status },
      after: { status: 'active', activationDate: input.activationDate },
    });
    await emitEvent(tx, {
      organisationId,
      eventType: 'lease.activated',
      resourceType: 'lease',
      resourceId: lease.id,
      payload: { unitId: lease.unit_id, startDate: lease.start_date },
    });

    return { leaseId: updated.id, status: updated.status };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Renews a lease by creating a linked successor.
 * The original rent schedule and charge history are untouched.
 */
export async function renewLease(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { leaseId: string; newStartDate: string; newEndDate?: string; newRentMinor: bigint },
): Promise<{ leaseId: string; reference: string }> {
  await requirePermission(tx, organisationId, 'lease.activate');
  const [original] = await tx<
    { id: string; unit_id: string; property_id: string; currency_code: string; billing_day: number;
      proration_method: string; deposit_required_minor: string; notice_days: number | null }[]
  >`
    select id, unit_id, property_id, currency_code, billing_day, proration_method,
           deposit_required_minor, notice_days
    from leases where id = ${params.leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!original) throw notFound('Lease');
  await requirePropertyScope(tx, organisationId, original.property_id);

  const reference = await nextDocumentNumber(tx, organisationId, 'LSE');
  try {
    const [created] = await tx<{ id: string }[]>`
      insert into leases (
        organisation_id, property_id, unit_id, reference, status, start_date, end_date,
        rent_minor, currency_code, billing_day, proration_method,
        deposit_required_minor, notice_days, supersedes_lease_id
      ) values (
        ${organisationId}, ${original.property_id}, ${original.unit_id}, ${reference}, 'draft',
        ${params.newStartDate}, ${params.newEndDate ?? null}, ${params.newRentMinor.toString()},
        ${original.currency_code}, ${original.billing_day}, ${original.proration_method},
        ${original.deposit_required_minor}, ${original.notice_days}, ${original.id}
      )
      returning id
    `;
    if (!created) throw new DomainError('internal', 'Renewal insert returned no row.');
    // Carry the parties forward.
    await tx`
      insert into lease_parties (organisation_id, lease_id, resident_id, role, can_view_financials, joined_on)
      select organisation_id, ${created.id}, resident_id, role, can_view_financials, ${params.newStartDate}::date
      from lease_parties
      where lease_id = ${original.id}::uuid and removed_on is null
    `;
    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'lease.renewed', resourceType: 'lease', resourceId: created.id,
      after: { supersedes: original.id, reference, rentMinor: params.newRentMinor.toString() },
    });
    return { leaseId: created.id, reference };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Expires a lease without touching its arrears.
 * "Closing a lease does not erase arrears" and the occupant may remain as a
 * recorded holdover.
 */
export async function expireLease(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { leaseId: string; holdover: boolean },
): Promise<void> {
  await requirePermission(tx, organisationId, 'lease.close');
  const [lease] = await tx<{ id: string; property_id: string; unit_id: string; end_date: string | null }[]>`
    select id, property_id, unit_id, end_date from leases
    where id = ${params.leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!lease) throw notFound('Lease');
  await requirePropertyScope(tx, organisationId, lease.property_id);

  await tx`
    update leases set status = 'expired', version = version + 1, updated_at = now()
    where id = ${params.leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (params.holdover) {
    await tx`
      update occupancy_intervals set is_holdover = true
      where lease_id = ${params.leaseId}::uuid and organisation_id = ${organisationId}::uuid
        and move_out_at is null
    `;
  }
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'lease.expired', resourceType: 'lease', resourceId: params.leaseId,
    after: { holdover: params.holdover },
  });
}

/* ---------------------------------------------------------------- *
 * Ending and extending a lease.
 *
 * Both record WHY, in the same transaction as the change. A lease is a
 * contract: "it ended in March" is not an answer anyone can act on a year
 * later, and the reason is usually the thing in dispute.
 * ---------------------------------------------------------------- */

export interface LeaseLifecycleEvent {
  id: string;
  kind: 'terminated' | 'extended';
  reason: string;
  effectiveDate: string;
  previousEndDate: string | null;
  previousStatus: string;
  recordedAt: string;
  recordedBy: string | null;
}

/** The lease's own history of being ended or extended, oldest last. */
export async function listLeaseLifecycleEvents(
  tx: Sql,
  organisationId: string,
  leaseId: string,
): Promise<LeaseLifecycleEvent[]> {
  const rows = await tx<
    { id: string; kind: 'terminated' | 'extended'; reason: string; effective_date: string;
      previous_end_date: string | null; previous_status: string; recorded_at: string;
      recorded_by: string | null }[]
  >`
    select e.id, e.kind::text as kind, e.reason, e.effective_date::text,
           e.previous_end_date::text, e.previous_status, e.recorded_at::text,
           up.full_name as recorded_by
      from lease_lifecycle_events e
      left join user_profiles up on up.auth_user_id = e.recorded_by
     where e.lease_id = ${leaseId}::uuid and e.organisation_id = ${organisationId}::uuid
     order by e.recorded_at desc
  `;
  return rows.map((r) => ({
    id: r.id, kind: r.kind, reason: r.reason,
    effectiveDate: r.effective_date, previousEndDate: r.previous_end_date,
    previousStatus: r.previous_status, recordedAt: r.recorded_at, recordedBy: r.recorded_by,
  }));
}

const lifecycleReasonSchema = z.string().trim().min(3).max(2000);

/**
 * Ends a lease, with the reason recorded.
 *
 * Deliberately does NOT touch money. Charges already posted stay posted and a
 * balance still owing stays owing — ending the agreement is not forgiveness of
 * the debt, and a system that quietly wrote off arrears when a tenant left
 * would be worse than useless. Deposits are handled on their own register.
 */
export async function terminateLease(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { leaseId: string; reason: string; effectiveDate: string },
): Promise<{ leaseId: string; status: string; effectiveDate: string }> {
  await requirePermission(tx, organisationId, 'lease.activate');
  const reason = lifecycleReasonSchema.parse(input.reason);
  const effectiveDate = z.string().date().parse(input.effectiveDate);

  const [lease] = await tx<
    { id: string; status: string; end_date: string | null; start_date: string }[]
  >`
    select id, status::text, end_date::text, start_date::text
      from leases
     where id = ${input.leaseId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!lease) throw notFound('Lease');
  if (lease.status === 'closed' || lease.status === 'cancelled') {
    throw invalid('That lease has already ended.');
  }
  if (effectiveDate < lease.start_date) {
    throw invalid('A lease cannot end before it started.');
  }

  await tx`
    insert into lease_lifecycle_events (
      organisation_id, lease_id, kind, reason, effective_date,
      previous_end_date, previous_status, recorded_by
    ) values (
      ${organisationId}, ${input.leaseId}, 'terminated', ${reason}, ${effectiveDate},
      ${lease.end_date}, ${lease.status}, ${actorUserId}
    )
  `;

  await tx`
    update leases
       set status = 'closed', end_date = ${effectiveDate},
           closed_at = now(), cancellation_reason = ${reason}, updated_at = now()
     where id = ${input.leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'lease.terminated', resourceType: 'lease', resourceId: input.leaseId,
    before: { status: lease.status, endDate: lease.end_date },
    after: { status: 'closed', endDate: effectiveDate },
    reason,
  });

  return { leaseId: input.leaseId, status: 'closed', effectiveDate };
}

/**
 * Extends a lease to a later end date, with the reason recorded.
 *
 * Only forwards. Pulling an end date earlier is ending the lease sooner, which
 * is a termination and has different consequences for notice and for the
 * deposit — so it goes through that command and says so, rather than being
 * disguised as an extension.
 */
export async function extendLease(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { leaseId: string; newEndDate: string; reason: string },
): Promise<{ leaseId: string; endDate: string }> {
  await requirePermission(tx, organisationId, 'lease.activate');
  const reason = lifecycleReasonSchema.parse(input.reason);
  const newEndDate = z.string().date().parse(input.newEndDate);

  const [lease] = await tx<
    { id: string; status: string; end_date: string | null; start_date: string }[]
  >`
    select id, status::text, end_date::text, start_date::text
      from leases
     where id = ${input.leaseId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!lease) throw notFound('Lease');
  if (lease.status === 'closed' || lease.status === 'cancelled') {
    throw invalid('That lease has ended. Extending it would rewrite history; start a new lease.');
  }
  if (newEndDate <= lease.start_date) {
    throw invalid('The new end date must be after the lease started.');
  }
  if (lease.end_date && newEndDate <= lease.end_date) {
    throw invalid(
      'An extension must move the end date later. To end the lease sooner, end it and say why.',
    );
  }

  await tx`
    insert into lease_lifecycle_events (
      organisation_id, lease_id, kind, reason, effective_date,
      previous_end_date, previous_status, recorded_by
    ) values (
      ${organisationId}, ${input.leaseId}, 'extended', ${reason}, ${newEndDate},
      ${lease.end_date}, ${lease.status}, ${actorUserId}
    )
  `;

  await tx`
    update leases set end_date = ${newEndDate}, updated_at = now()
     where id = ${input.leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'lease.extended', resourceType: 'lease', resourceId: input.leaseId,
    before: { endDate: lease.end_date }, after: { endDate: newEndDate }, reason,
  });

  return { leaseId: input.leaseId, endDate: newEndDate };
}
