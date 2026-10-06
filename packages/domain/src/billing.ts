import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { postCharge } from './charges';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import type { Minor } from './money';
import { prorate, sumMinor } from './money';
import { requirePermission } from './permissions';

export const billingPeriodSchema = z.object({
  /** First day of the billing month. */
  periodStart: z.string().date(),
  propertyIds: z.array(z.string().uuid()).optional(),
});

export interface BillingPreviewLine {
  leaseId: string;
  leaseReference: string;
  unitLabel: string;
  scheduleId: string;
  category: string;
  description: string;
  fullAmountMinor: Minor;
  amountMinor: Minor;
  prorated: boolean;
  prorationNumerator: number;
  prorationDenominator: number;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  dueDate: string;
  /** Already billed for this schedule and period; the line will be skipped. */
  alreadyBilled: boolean;
}

export interface BillingException {
  severity: 'blocking' | 'warning';
  leaseId: string | null;
  leaseReference: string | null;
  code: string;
  message: string;
}

export interface BillingPreview {
  periodStart: string;
  periodEnd: string;
  currencyCode: string;
  lines: BillingPreviewLine[];
  exceptions: BillingException[];
  totalMinor: Minor;
  billableLineCount: number;
  skippedLineCount: number;
}

function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function daysBetweenInclusive(a: string, b: string): number {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

/**
 * Resolves the due date for a billing month.
 *
 * A due day beyond the month's length resolves to the last day under the
 * schedule's recorded overflow policy. February and leap years are covered by
 * `tests/unit/billing-dates.test.ts`.
 */
export function resolveDueDate(periodStart: string, dueDay: number): string {
  const [y, m] = periodStart.split('-').map(Number) as [number, number];
  const last = lastDayOfMonth(y, m);
  const day = Math.min(dueDay, last);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Builds a billing preview for a period.
 *
 * Nothing is posted here. The preview shows what WOULD be charged, which leases
 * were skipped and why, and every proration calculation with its numerator and
 * denominator so an operator can check the arithmetic before approving.
 */
export async function previewBillingRun(
  tx: Sql,
  organisationId: string,
  params: z.input<typeof billingPeriodSchema>,
): Promise<BillingPreview> {
  await requirePermission(tx, organisationId, 'billing.preview');
  const p = billingPeriodSchema.parse(params);

  const [y, m] = p.periodStart.split('-').map(Number) as [number, number];
  if (Number(p.periodStart.slice(8, 10)) !== 1) {
    throw invalid('A billing period starts on the first day of the month.');
  }
  const daysInMonth = lastDayOfMonth(y, m);
  const periodEnd = `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  const [book] = await tx<{ id: string; currency_code: string }[]>`
    select id, currency_code from financial_books
    where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw notFound('Financial book');

  const rows = await tx<
    {
      schedule_id: string; lease_id: string; lease_reference: string; lease_status: string;
      property_id: string; property_name: string; unit_code: string;
      category: string; description: string; amount_minor: string; currency_code: string;
      due_day: number; prorate_first: boolean; prorate_last: boolean;
      overlap_start: string | null; overlap_end: string | null;
      lease_start: string; lease_end: string | null;
      already_billed: boolean;
    }[]
  >`
    select
      cs.id as schedule_id,
      l.id as lease_id, l.reference as lease_reference, l.status::text as lease_status,
      l.property_id, pr.name as property_name, u.code as unit_code,
      cs.category, cs.description, cs.amount_minor::text, cs.currency_code,
      cs.due_day, cs.prorate_first_period as prorate_first, cs.prorate_last_period as prorate_last,
      lower(
        cs.effective_period
        * daterange(${p.periodStart}::date, ${periodEnd}::date, '[]')
        * daterange(l.start_date, l.end_date, '[]')
      )::text as overlap_start,
      (upper(
        cs.effective_period
        * daterange(${p.periodStart}::date, ${periodEnd}::date, '[]')
        * daterange(l.start_date, l.end_date, '[]')
      ) - 1)::text as overlap_end,
      l.start_date::text as lease_start, l.end_date::text as lease_end,
      exists (
        select 1 from charge_documents cd
        where cd.schedule_id = cs.id
          and cd.period_start = ${p.periodStart}::date
          and cd.status <> 'draft'
      ) as already_billed
    from charge_schedules cs
    join leases l on l.id = cs.lease_id
    join properties pr on pr.id = l.property_id
    join units u on u.id = l.unit_id
    where cs.organisation_id = ${organisationId}::uuid
      and cs.is_active
      and l.status in ('active', 'notice_given')
      and cs.effective_period && daterange(${p.periodStart}::date, ${periodEnd}::date, '[]')
      and daterange(l.start_date, l.end_date, '[]') && daterange(${p.periodStart}::date, ${periodEnd}::date, '[]')
      ${p.propertyIds?.length ? tx`and l.property_id = any(${p.propertyIds}::uuid[])` : tx``}
    order by pr.name, u.code, cs.category
  `;

  const lines: BillingPreviewLine[] = [];
  const exceptions: BillingException[] = [];

  for (const row of rows) {
    if (row.currency_code !== book.currency_code) {
      exceptions.push({
        severity: 'blocking',
        leaseId: row.lease_id,
        leaseReference: row.lease_reference,
        code: 'currency_mismatch',
        message: `Schedule currency ${row.currency_code} does not match the book currency ${book.currency_code}.`,
      });
      continue;
    }
    if (!row.overlap_start || !row.overlap_end) continue;

    const covered = daysBetweenInclusive(row.overlap_start, row.overlap_end);
    const isPartial = covered < daysInMonth;
    const startsThisMonth = row.lease_start >= p.periodStart && row.lease_start <= periodEnd;
    const endsThisMonth = row.lease_end !== null && row.lease_end >= p.periodStart && row.lease_end <= periodEnd;
    const shouldProrate =
      isPartial && ((startsThisMonth && row.prorate_first) || (endsThisMonth && row.prorate_last));

    const full = BigInt(row.amount_minor);
    const amount = shouldProrate ? prorate(full, covered, daysInMonth) : full;

    if (row.already_billed) {
      exceptions.push({
        severity: 'warning',
        leaseId: row.lease_id,
        leaseReference: row.lease_reference,
        code: 'already_billed',
        message: `${row.description} for this period is already posted and will be skipped.`,
      });
    }
    if (isPartial && !shouldProrate) {
      exceptions.push({
        severity: 'warning',
        leaseId: row.lease_id,
        leaseReference: row.lease_reference,
        code: 'partial_period_not_prorated',
        message:
          `${row.description} covers ${covered} of ${daysInMonth} days but the schedule ` +
          `does not prorate this period; the full amount will be charged.`,
      });
    }

    lines.push({
      leaseId: row.lease_id,
      leaseReference: row.lease_reference,
      unitLabel: `${row.property_name} / ${row.unit_code}`,
      scheduleId: row.schedule_id,
      category: row.category,
      description: row.description,
      fullAmountMinor: full,
      amountMinor: amount,
      prorated: shouldProrate,
      prorationNumerator: covered,
      prorationDenominator: daysInMonth,
      servicePeriodStart: row.overlap_start,
      servicePeriodEnd: row.overlap_end,
      dueDate: resolveDueDate(p.periodStart, row.due_day),
      alreadyBilled: row.already_billed,
    });
  }

  // Active leases with no rent schedule at all are a blocking exception: silently
  // billing nothing is worse than refusing to run.
  const missing = await tx<{ id: string; reference: string }[]>`
    select l.id, l.reference from leases l
    where l.organisation_id = ${organisationId}::uuid
      and l.status = 'active'
      and daterange(l.start_date, l.end_date, '[]') && daterange(${p.periodStart}::date, ${periodEnd}::date, '[]')
      and not exists (
        select 1 from charge_schedules cs
        where cs.lease_id = l.id and cs.is_active and cs.category = 'rent'
      )
  `;
  for (const lease of missing) {
    exceptions.push({
      severity: 'blocking',
      leaseId: lease.id,
      leaseReference: lease.reference,
      code: 'missing_rent_schedule',
      message: 'This active lease has no rent schedule, so no rent would be billed.',
    });
  }

  const billable = lines.filter((l) => !l.alreadyBilled);
  return {
    periodStart: p.periodStart,
    periodEnd,
    currencyCode: book.currency_code,
    lines,
    exceptions,
    totalMinor: sumMinor(billable.map((l) => l.amountMinor)),
    billableLineCount: billable.length,
    skippedLineCount: lines.length - billable.length,
  };
}

/** Persists a preview so that posting can quote the exact version it approved. */
export async function saveBillingPreview(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  preview: BillingPreview,
): Promise<{ runId: string; previewVersion: number }> {
  await requirePermission(tx, organisationId, 'billing.preview');
  const [book] = await tx<{ id: string }[]>`
    select id from financial_books where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw notFound('Financial book');

  const blocking = preview.exceptions.filter((e) => e.severity === 'blocking');
  const [run] = await tx<{ id: string; preview_version: number }[]>`
    insert into billing_runs (
      organisation_id, book_id, period_start, period_end, status,
      totals_minor, line_count, exception_count, created_by
    ) values (
      ${organisationId}, ${book.id}, ${preview.periodStart}, ${preview.periodEnd},
      ${blocking.length > 0 ? 'preview' : 'validated'},
      ${preview.totalMinor.toString()}, ${preview.billableLineCount},
      ${preview.exceptions.length}, ${actorUserId}
    )
    returning id, preview_version
  `;
  if (!run) throw new DomainError('internal', 'Billing run insert returned no row.');
  return { runId: run.id, previewVersion: run.preview_version };
}

/**
 * Posts an approved billing run.
 *
 * Safe to retry. Duplicate protection is enforced by the unique index on
 * (schedule_id, period_start, document_type) for non-draft documents, so a
 * worker that crashes mid-run and retries produces exactly one charge per
 * schedule and period — never two — and the second attempt reports the
 * already-posted lines as skipped rather than failing the whole run.
 */
export async function postBillingRun(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: {
    runId: string;
    previewVersion: number;
    idempotencyKey: string;
    issueDate: string;
    correlationId?: string;
  },
): Promise<{ postedCount: number; skippedCount: number; totalMinor: Minor; documentIds: string[] }> {
  await requirePermission(tx, organisationId, 'billing.post');

  const [run] = await tx<
    { id: string; period_start: string; period_end: string; status: string; preview_version: number }[]
  >`
    select id, period_start::text, period_end::text, status, preview_version
    from billing_runs
    where id = ${params.runId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!run) throw notFound('Billing run');
  if (run.status === 'posted') {
    // Idempotent replay: report what the original run produced.
    const docs = await tx<{ id: string; total_minor: string }[]>`
      select id, total_minor::text from charge_documents
      where billing_run_id = ${params.runId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    return {
      postedCount: 0,
      skippedCount: docs.length,
      totalMinor: sumMinor(docs.map((d) => BigInt(d.total_minor))),
      documentIds: docs.map((d) => d.id),
    };
  }
  if (run.preview_version !== params.previewVersion) {
    throw new DomainError(
      'stale_version',
      'The billing preview changed since it was reviewed. Re-run the preview and approve the current figures.',
    );
  }
  if (run.status !== 'validated') {
    throw new DomainError(
      'conflict',
      'This run has unresolved blocking exceptions and cannot be posted. Resolve them and preview again.',
    );
  }

  // Recompute from live data rather than trusting a stored projection.
  const preview = await previewBillingRun(tx, organisationId, { periodStart: run.period_start });
  if (preview.exceptions.some((e) => e.severity === 'blocking')) {
    throw new DomainError('conflict', 'Blocking exceptions appeared since the preview. Review and preview again.');
  }

  await tx`update billing_runs set status = 'posting' where id = ${params.runId}::uuid`;

  const byLease = new Map<string, BillingPreviewLine[]>();
  for (const line of preview.lines) {
    if (line.alreadyBilled) continue;
    const list = byLease.get(line.leaseId) ?? [];
    list.push(line);
    byLease.set(line.leaseId, list);
  }

  const documentIds: string[] = [];
  let posted = 0;
  let skipped = preview.skippedLineCount;
  let total = 0n;

  try {
    for (const [leaseId, leaseLines] of byLease) {
      // One document per lease per schedule, so the duplicate key applies per line.
      for (const line of leaseLines) {
        try {
          const result = await postCharge(tx, organisationId, actorUserId, {
            leaseId,
            documentType: line.category === 'rent' ? 'rent_invoice' : 'utility_invoice',
            issueDate: params.issueDate,
            dueDate: line.dueDate,
            periodStart: preview.periodStart,
            periodEnd: preview.periodEnd,
            scheduleId: line.scheduleId,
            billingRunId: params.runId,
            correlationId: params.correlationId,
            lines: [
              {
                category: line.category === 'rent' ? 'rent' : 'other',
                description: line.prorated
                  ? `${line.description} (${line.prorationNumerator}/${line.prorationDenominator} days)`
                  : line.description,
                amountMinor: line.amountMinor,
                dueDate: line.dueDate,
                servicePeriodStart: line.servicePeriodStart,
                servicePeriodEnd: line.servicePeriodEnd,
                prorated: line.prorated,
                prorationNumerator: line.prorationNumerator,
                prorationDenominator: line.prorationDenominator,
                fullPeriodAmountMinor: line.fullAmountMinor,
              },
            ],
          });
          documentIds.push(result.documentId);
          total += result.totalMinor;
          posted += 1;
        } catch (error) {
          // The duplicate key is the safety net doing its job, not a failure.
          if (error instanceof DomainError && error.code === 'duplicate') {
            skipped += 1;
            continue;
          }
          throw error;
        }
      }
    }

    await tx`
      update billing_runs set
        status = 'posted', posted_at = now(), posted_by = ${actorUserId},
        idempotency_key = ${params.idempotencyKey},
        totals_minor = ${total.toString()}, line_count = ${posted}
      where id = ${params.runId}::uuid
    `;

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'billing_run.posted', resourceType: 'billing_run', resourceId: params.runId,
      correlationId: params.correlationId ?? null,
      after: { posted, skipped, totalMinor: total.toString(), period: run.period_start },
    });
    await emitEvent(tx, {
      organisationId,
      eventType: 'billing_run.posted',
      resourceType: 'billing_run',
      resourceId: params.runId,
      payload: { posted, skipped, totalMinor: total.toString() },
      correlationId: params.correlationId ?? null,
    });

    return { postedCount: posted, skippedCount: skipped, totalMinor: total, documentIds };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}
