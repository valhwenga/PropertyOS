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
