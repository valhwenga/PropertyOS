import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { chargeCategoryLabel, CHARGE_CATEGORY_KEYS } from './charge-categories';
import { addMonths, todayIso } from './dates';
import { DomainError, invalid, notFound } from './errors';
import type { Minor } from './money';
import { requirePermission } from './permissions';

/**
 * What a lease bills every month, and changing it.
 *
 * `charge_schedules` has been effective-dated since the first migration, and
 * its own comment has always said what that is for: "a rent increase closes
 * the old row and opens a new one; the historical amount stays readable."
 * Nothing ever did it. A rent schedule was written once at activation and
 * could not be changed, and a recurring parking bay or levy could only be
 * created by the CSV import.
 *
 * The consequence was a product that billed a figure contradicting the
 * agreement it printed: the lease says the rent escalates on each anniversary,
 * `leases.escalation_percent` records by how much, and the billing run went on
 * raising the original amount for the whole term.
 *
 * Three rules hold everything here together:
 *
 *  1. **A change is a new row, never an edit.** What was billed in March must
 *     still read as what was billed in March a year later, when somebody is
 *     arguing about it.
 *  2. **Nothing already posted is restated.** A charge document is immutable;
 *     changing a schedule changes what the NEXT run raises. Where the period
 *     has already been billed the caller is told so, in those words, rather
 *     than discovering it when the figures do not move.
 *  3. **No escalation applies itself.** The product can see one is due and say
 *     so with the arithmetic; a person decides. Software that raises somebody's
 *     rent on its own is software nobody should run.
 */

export interface ChargeSchedule {
  id: string;
  category: string;
  categoryLabel: string;
  description: string;
  amountMinor: Minor;
  currencyCode: string;
  /** Inclusive start; the day this amount begins to apply. */
  startDate: string;
  /** Inclusive end, or null for the lease's own end. */
  endDate: string | null;
  dueDay: number;
  isActive: boolean;
  /** True where this row covers today. */
  current: boolean;
  /**
   * Where this row sits in time: billing now, waiting to start, or finished.
   *
   * Three states, not two. A change takes effect from a future date, so the
   * row carrying the new amount has not started yet — calling that
   * "historical", as a current/not-current pair must, tells an operator the
   * opposite of what is true.
   */
  state: 'current' | 'scheduled' | 'ended';
  supersedesScheduleId: string | null;
  changeReason: string | null;
  /** Billing runs that have already raised a charge from this row. */
  billedPeriods: number;
}

interface Row {
  id: string; category: string; description: string; amount_minor: string;
  currency_code: string; start_date: string; end_date: string | null; due_day: number;
  is_active: boolean; supersedes_schedule_id: string | null; change_reason: string | null;
  billed_periods: string;
}

function toSchedule(row: Row, today: string): ChargeSchedule {
  return {
    id: row.id,
    category: row.category,
    categoryLabel: chargeCategoryLabel(row.category),
    description: row.description,
    amountMinor: BigInt(row.amount_minor),
    currencyCode: row.currency_code,
    startDate: row.start_date,
    endDate: row.end_date,
    dueDay: row.due_day,
    isActive: row.is_active,
    current: row.is_active && row.start_date <= today
      && (row.end_date === null || row.end_date >= today),
    state: row.start_date > today
      ? 'scheduled'
      : row.is_active && (row.end_date === null || row.end_date >= today)
        ? 'current'
        : 'ended',
    supersedesScheduleId: row.supersedes_schedule_id,
    changeReason: row.change_reason,
    billedPeriods: Number(row.billed_periods),
  };
}

/**
 * Every schedule on a lease, past and present, oldest first.
 *
 * History is included deliberately. "What were we charging in March" is the
 * question a dispute actually starts with, and a list that shows only what is
 * current cannot answer it.
 */
export async function listChargeSchedules(
  tx: Sql, organisationId: string, leaseId: string, today = todayIso(),
): Promise<ChargeSchedule[]> {
  const rows = await tx<Row[]>`
    select cs.id, cs.category, cs.description, cs.amount_minor::text, cs.currency_code,
           lower(cs.effective_period)::text as start_date,
           (upper(cs.effective_period) - 1)::text as end_date,
           cs.due_day, cs.is_active, cs.supersedes_schedule_id, cs.change_reason,
           -- Counted off the LINES, because one document now carries lines
           -- from several schedules and no longer names one (0090). The
           -- question is unchanged: how many periods has this charge billed?
           (select count(distinct cd.period_start) from charge_lines cl
              join charge_documents cd on cd.id = cl.document_id
             where cl.schedule_id = cs.id and cd.status <> 'draft')::text as billed_periods
      from charge_schedules cs
     where cs.organisation_id = ${organisationId}::uuid
       and cs.lease_id = ${leaseId}::uuid
     order by cs.category, lower(cs.effective_period)
  `;
  return rows.map((row) => toSchedule(row, today));
}

/* ------------------------------------------------------------- adding one */

const addSchedule = z.object({
  leaseId: z.string().uuid(),
  category: z.enum(CHARGE_CATEGORY_KEYS as [string, ...string[]]),
  description: z.string().trim().min(1).max(300),
  amountMinor: z.bigint().nonnegative(),
  startDate: z.string().date(),
  endDate: z.string().date().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
});

/**
 * Adds a recurring charge to a lease.
 *
 * It runs from a date, so starting a parking bay in the middle of a term does
 * not quietly backdate three months of charges the tenant never agreed to.
 * The end defaults to the lease's own end: a recurring charge that outlives
 * its lease is a charge against nobody.
 */
export async function addChargeSchedule(
  tx: Sql, organisationId: string, actorUserId: string,
  input: z.input<typeof addSchedule>,
): Promise<{ scheduleId: string }> {
  await requirePermission(tx, organisationId, 'lease.activate');
  const data = addSchedule.parse(input);

  const [lease] = await tx<
    { id: string; currency_code: string; start_date: string; end_date: string;
      billing_day: number; status: string }[]
  >`
    select id, currency_code, start_date::text, end_date::text, billing_day, status
      from leases
     where id = ${data.leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!lease) throw notFound('Lease');
  if (lease.status === 'closed' || lease.status === 'cancelled') {
    throw new DomainError('conflict', 'This lease is closed. Nothing more can be billed on it.');
  }

  const end = data.endDate ?? lease.end_date;
  if (data.startDate < lease.start_date) {
    throw invalid(`This lease starts on ${lease.start_date}; a charge cannot run before it.`);
  }
  if (end > lease.end_date) {
    throw invalid(`This lease ends on ${lease.end_date}; a charge cannot run past it.`);
  }
  if (end < data.startDate) throw invalid('The end date is before the start date.');

  const [created] = await tx<{ id: string }[]>`
    insert into charge_schedules (
      organisation_id, lease_id, category, description, amount_minor, currency_code,
      effective_period, due_day, created_by
    ) values (
      ${organisationId}, ${data.leaseId}, ${data.category}, ${data.description},
      ${data.amountMinor.toString()}, ${lease.currency_code},
      daterange(${data.startDate}::date, ${end}::date, '[]'),
      ${data.dueDay ?? lease.billing_day}, ${actorUserId}
    )
    returning id
  `.catch((error: unknown) => {
    // The exclusion constraint: one active schedule per lease and category per
    // period. Hitting it means a charge of this kind already covers those
    // dates, which is a thing to say rather than a constraint name to leak.
    if (String(error).includes('charge_schedules_lease_id_category_effective_period_excl')) {
      throw new DomainError('conflict',
        `This lease already has a ${chargeCategoryLabel(data.category).toLowerCase()} charge `
        + 'covering those dates. Change that one instead of adding a second.');
    }
    throw error;
  });
  if (!created) throw new DomainError('internal', 'Charge schedule insert returned no row.');

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'charge_schedule.added', resourceType: 'lease', resourceId: data.leaseId,
    after: {
      scheduleId: created.id, category: data.category, description: data.description,
      amountMinor: data.amountMinor.toString(), startDate: data.startDate, endDate: end,
    },
  });
  return { scheduleId: created.id };
}

/* ----------------------------------------------------------- changing one */

const changeSchedule = z.object({
  scheduleId: z.string().uuid(),
  amountMinor: z.bigint().nonnegative(),
  effectiveFrom: z.string().date(),
  reason: z.string().trim().min(3).max(300),
});

export interface ScheduleChange {
  /** The row that now carries the new amount. */
  scheduleId: string;
  previousAmountMinor: Minor;
  amountMinor: Minor;
  effectiveFrom: string;
  /**
   * True where a run has already billed the period the change starts in.
   *
   * The posted documents are NOT restated — they cannot be, and should not be.
   * The caller says so to the operator instead, who can issue a credit note if
   * the month genuinely needs correcting.
   */
  periodAlreadyBilled: boolean;
}

/**
 * Changes what a schedule bills, from a date.
 *
 * The old row keeps its history and stops the day before; a new row carries
 * the new amount for the remainder and points back at the one it replaced. A
 * rent increase is therefore readable as the two amounts it actually was,
 * rather than as one amount that mysteriously differs from last year's
 * invoices.
 */
export async function changeChargeScheduleAmount(
  tx: Sql, organisationId: string, actorUserId: string,
  input: z.input<typeof changeSchedule>,
): Promise<ScheduleChange> {
  await requirePermission(tx, organisationId, 'lease.activate');
  const data = changeSchedule.parse(input);

  const [existing] = await tx<
    { id: string; lease_id: string; category: string; description: string;
      amount_minor: string; currency_code: string; due_day: number;
      start_date: string; end_date: string; is_active: boolean }[]
  >`
    select id, lease_id, category, description, amount_minor::text, currency_code, due_day,
           lower(effective_period)::text as start_date,
           (upper(effective_period) - 1)::text as end_date,
           is_active
      from charge_schedules
     where id = ${data.scheduleId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!existing) throw notFound('Charge schedule');
  if (!existing.is_active) {
    throw new DomainError('conflict', 'This charge has been stopped. Add a new one instead.');
  }

  const previous = BigInt(existing.amount_minor);
  if (previous === data.amountMinor) {
    throw invalid('That is the amount already being billed.');
  }
  if (data.effectiveFrom <= existing.start_date) {
    throw invalid(
      `This amount has applied since ${existing.start_date}. A change takes effect AFTER `
      + 'that, so that what was billed before stays readable as it was billed.',
    );
  }
  if (data.effectiveFrom > existing.end_date) {
    throw invalid(`This charge ends on ${existing.end_date}; a change after that bills nobody.`);
  }

  // Whether the month this starts in has already been raised. The documents
  // stand; the operator is told rather than left to notice.
  const [{ billed }] = await tx<{ billed: boolean }[]>`
    select exists (
      select 1 from charge_lines cl
       join charge_documents cd on cd.id = cl.document_id
       where cl.schedule_id = ${existing.id}::uuid
         and cd.status <> 'draft'
         and cd.period_start <= ${data.effectiveFrom}::date
         and (cd.period_end is null or cd.period_end >= ${data.effectiveFrom}::date)
    ) as billed
  ` as unknown as [{ billed: boolean }];

  // Close the old row first: the exclusion constraint refuses two active rows
  // of one category over the same days, which is exactly the protection that
  // makes this safe to do in one transaction.
  const dayBefore = tx`(${data.effectiveFrom}::date - 1)`;
  await tx`
    update charge_schedules
       set effective_period = daterange(lower(effective_period), ${dayBefore}, '[]')
     where id = ${existing.id}::uuid and organisation_id = ${organisationId}::uuid
  `;

  const [created] = await tx<{ id: string }[]>`
    insert into charge_schedules (
      organisation_id, lease_id, category, description, amount_minor, currency_code,
      effective_period, due_day, supersedes_schedule_id, change_reason, created_by
    ) values (
      ${organisationId}, ${existing.lease_id}, ${existing.category}, ${existing.description},
      ${data.amountMinor.toString()}, ${existing.currency_code},
      daterange(${data.effectiveFrom}::date, ${existing.end_date}::date, '[]'),
      ${existing.due_day}, ${existing.id}, ${data.reason}, ${actorUserId}
    )
    returning id
  `;
  if (!created) throw new DomainError('internal', 'Charge schedule insert returned no row.');

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'charge_schedule.amount_changed', resourceType: 'lease',
    resourceId: existing.lease_id,
    before: { scheduleId: existing.id, amountMinor: existing.amount_minor },
    after: {
      scheduleId: created.id, amountMinor: data.amountMinor.toString(),
      effectiveFrom: data.effectiveFrom, reason: data.reason,
    },
  });

  return {
    scheduleId: created.id,
    previousAmountMinor: previous,
    amountMinor: data.amountMinor,
    effectiveFrom: data.effectiveFrom,
    periodAlreadyBilled: billed,
  };
}

/* ------------------------------------------------------------ stopping one */

/**
 * Stops a recurring charge from a date.
 *
 * The row is not deleted and the charges it already raised are untouched: it
 * stops covering days, and the billing run stops seeing it. Stopping rent
 * needs a lease to be ended rather than a schedule to be switched off, so that
 * is refused here with the reason.
 */
export async function stopChargeSchedule(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { scheduleId: string; lastDay: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'lease.activate');
  const reason = input.reason.trim();
  if (reason.length < 3) throw invalid('Say why this charge is stopping.');

  const [existing] = await tx<
    { id: string; lease_id: string; category: string; start_date: string;
      end_date: string }[]
  >`
    select id, lease_id, category, lower(effective_period)::text as start_date,
           (upper(effective_period) - 1)::text as end_date
      from charge_schedules
     where id = ${input.scheduleId}::uuid and organisation_id = ${organisationId}::uuid
       and is_active
     for update
  `;
  if (!existing) throw notFound('Charge schedule');
  if (existing.category === 'rent') {
    throw new DomainError('conflict',
      'Rent is what the lease is for. End or terminate the lease rather than switching its '
      + 'rent off and leaving it active.');
  }
  if (input.lastDay < existing.start_date) {
    throw invalid(`This charge started on ${existing.start_date}.`);
  }

  await tx`
    update charge_schedules
       set effective_period = daterange(lower(effective_period), ${input.lastDay}::date, '[]'),
           is_active = ${input.lastDay >= todayIso() ? true : false},
           change_reason = ${reason}
     where id = ${existing.id}::uuid and organisation_id = ${organisationId}::uuid
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'charge_schedule.stopped', resourceType: 'lease', resourceId: existing.lease_id,
    before: { scheduleId: existing.id, endDate: existing.end_date },
    after: { scheduleId: existing.id, endDate: input.lastDay, reason },
  });
}

/* ------------------------------------------------------------- escalation */

export interface EscalationDue {
  leaseId: string;
  leaseReference: string;
  unitLabel: string;
  residentName: string | null;
  scheduleId: string;
  currentAmountMinor: Minor;
  /** What the lease's own terms produce, rounded to the minor unit. */
  proposedAmountMinor: Minor;
  escalationPercent: number;
  /**
   * How often the lease agreed to escalate, in months.
   *
   * Reported because "on each anniversary" is only true at twelve. A lease
   * that escalates every six months would be described wrongly by a screen
   * that assumed the interval, which is the sort of error a tenant notices
   * before the landlord does.
   */
  intervalMonths: number;
  /** The date the agreement's terms make the increase effective. */
  dueOn: string;
  currencyCode: string;
}

/**
 * Leases whose agreed escalation has fallen due and has not been applied.
 *
 * Read entirely from what was agreed: the percentage and interval on the
 * lease, the date it was activated, and the amount the current schedule is
 * still billing. A lease with no escalation recorded produces nothing — a
 * blank escalation authorises no increase, which is what the agreement this
 * product generates says in those words.
 *
 * It PROPOSES; it does not apply. The arithmetic is shown so the person
 * approving it can check it, and the increase happens when they say so.
 */
export async function escalationsDue(
  tx: Sql, organisationId: string, options: { leaseId?: string; today?: string } = {},
): Promise<EscalationDue[]> {
  const today = options.today ?? todayIso();

  const rows = await tx<
    { lease_id: string; reference: string; unit_label: string; resident_name: string | null;
      schedule_id: string; amount_minor: string; currency_code: string;
      escalation_percent: string; escalation_month_interval: number | null;
      start_date: string; schedule_start: string }[]
  >`
    select l.id as lease_id, l.reference, p.name || ' / ' || u.code as unit_label,
           (rp.first_name || ' ' || rp.last_name) as resident_name,
           cs.id as schedule_id, cs.amount_minor::text, cs.currency_code,
           l.escalation_percent::text, l.escalation_month_interval,
           l.start_date::text as start_date,
           lower(cs.effective_period)::text as schedule_start
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      join charge_schedules cs on cs.lease_id = l.id and cs.category = 'rent'
        and cs.is_active and cs.effective_period @> ${today}::date
      left join lease_parties lp on lp.lease_id = l.id
        and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
     where l.organisation_id = ${organisationId}::uuid
       and l.status in ('active', 'notice_given')
       and l.escalation_percent is not null and l.escalation_percent > 0
       ${options.leaseId ? tx`and l.id = ${options.leaseId}::uuid` : tx``}
  `;

  const due: EscalationDue[] = [];
  for (const row of rows) {
    const interval = row.escalation_month_interval ?? 12;
    const percent = Number(row.escalation_percent);

    // Every anniversary the agreement has reached, up to today. The LAST one
    // is the increase that is owed; earlier ones are already inside the
    // current amount when the schedule was changed at the time.
    let anniversary = addMonths(row.start_date, interval);
    let latest: string | null = null;
    while (anniversary <= today) {
      latest = anniversary;
      anniversary = addMonths(anniversary, interval);
    }
    if (!latest) continue;
    // Already applied: the current amount started on or after the date the
    // increase was due.
    if (row.schedule_start >= latest) continue;

    const current = BigInt(row.amount_minor);
    // Rounded half-up on the minor unit, which is what a landlord's own
    // calculator does and what the agreement implies.
    const proposed = (current * BigInt(Math.round((100 + percent) * 1000)) + 50_000n)
      / 100_000n;

    due.push({
      leaseId: row.lease_id,
      leaseReference: row.reference,
      unitLabel: row.unit_label,
      residentName: row.resident_name,
      scheduleId: row.schedule_id,
      currentAmountMinor: current,
      proposedAmountMinor: proposed,
      escalationPercent: percent,
      intervalMonths: interval,
      dueOn: latest,
      currencyCode: row.currency_code,
    });
  }
  return due;
}
