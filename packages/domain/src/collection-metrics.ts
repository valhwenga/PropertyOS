import type { Sql } from '@propertyos/db';
import type { Minor } from './money';

/**
 * Collection measurement — one definition, used everywhere.
 *
 * This module exists because the dashboard and the collection report answered
 * the same question differently. The dashboard divided allocations against ALL
 * charges by RENT billed alone, so a resident paying their water bill pushed
 * "rent collected" above rent billed; on the demo organisation that read 93.75%
 * where the truth was 80.21%. The report filtered neither side, so the two
 * screens disagreed about the same month. Nothing caught it, because the
 * guarding fixture happened to contain only rent.
 *
 * So there is now exactly one place where "billed" and "collected" are defined,
 * and both screens read it. The arithmetic below is deliberately explicit about
 * four things the blueprint requires be stated rather than assumed:
 *
 *  - WHICH PERIOD a charge belongs to. A document declares the period it bills
 *    for; a credit note does not, so it inherits the period of the document it
 *    corrects. Otherwise a June rent credited in July would reduce July's
 *    billed figure and overstate June's collection rate forever.
 *
 *  - THE CUT-OFF. Every figure is "as at" an instant. Allocations made after it
 *    are not counted, and an allocation reversed after it still counted then.
 *    A report run twice for the same closed period returns the same number.
 *
 *  - CREDITS AND REVERSALS. Billed is net of credits because credit lines are
 *    stored negative. Collected ignores reversed allocations as at the cut-off.
 *
 *  - CASH RECEIVED is not COLLECTION. Money banked during a month pays whatever
 *    it was allocated to, which is frequently last month's arrears. The two are
 *    reported side by side and never summed into one "collected" figure.
 *
 * Opening balance, arrears and ageing are deliberately NOT here: they are
 * balance-sheet measures as at a date, not period measures, and live with the
 * statement and arrears views that already derive them from dated rows.
 */

export interface CollectionMeasure {
  /** Posted charges less credits for this period, in the categories in scope. */
  billedMinor: Minor;
  /** Allocations against those very charges, net of reversals, as at the cut-off. */
  collectedMinor: Minor;
  /** Billed less collected. Negative means the period was overpaid. */
  outstandingMinor: Minor;
  /** Collected over billed, to two decimals. Null when nothing was billed. */
  ratePercent: number | null;
}

export interface CollectionTotals {
  periodStart: string;
  periodEnd: string;
  /** The business date every figure is stated as at. */
  asOf: string;
  currencyCode: string;
  /** Rent only. This is the headline landlords mean by "collection". */
  rent: CollectionMeasure;
  /** Rent plus utilities, recoveries and every other billed category. */
  total: CollectionMeasure;
  /**
   * Confirmed receipts banked during the period, whatever they paid for, and
   * including money still sitting in suspense. Cash flow, not collection.
   */
  receiptsBankedMinor: Minor;
  /** Of the allocations MADE in this period, how much went to earlier periods. */
  priorPeriodCollectedMinor: Minor;
  /** Confirmed money not yet applied to any charge, as at the cut-off. */
  unappliedCreditMinor: Minor;
}

export interface CollectionLeaseRow {
  leaseId: string;
  leaseReference: string;
  residentName: string | null;
  unitLabel: string;
  currencyCode: string;
  rent: CollectionMeasure;
  total: CollectionMeasure;
}

export interface CollectionScope {
  periodStart: string;
  periodEnd: string;
  /**
   * Business-date cut-off. This is the date work was posted UNDER, not the
   * instant a row was written: an operator who captures January's receipts on
   * 3 February is describing January.
   *
   * Defaults to the later of the period end and today, which reads as "what has
   * been collected against this period so far". Pass an explicit date to
   * reproduce a closed period: the same cut-off always gives the same answer.
   */
  asOf?: string;
  propertyIds?: string[];
}

/** Categories counted as rent. Deposits are a liability and never appear here. */
export const RENT_CATEGORIES: string[] = ['rent'];

/**
 * Collected over billed as a percentage with two decimals, computed in integers
 * so a half-cent never moves the headline.
 *
 * Truncated, not rounded: 76.875% reads as 76.87%, never 76.88%. A collection
 * rate is a claim about money received, and the error should fall on the side
 * of claiming less. Null when nothing was billed — a rate against zero is
 * undefined, and both 0% and 100% would be lies about an empty month.
 */
export function collectionRatePercent(billed: Minor, collected: Minor): number | null {
  if (billed === 0n) return null;
  return Number((collected * 10000n) / billed) / 100;
}

function measure(billed: Minor, collected: Minor): CollectionMeasure {
  return {
    billedMinor: billed,
    collectedMinor: collected,
    outstandingMinor: billed - collected,
    ratePercent: collectionRatePercent(billed, collected),
  };
}

/**
 * The period-and-cut-off predicates, written once.
 *
 * `cd` is charge_documents, `orig` the document a correction corrects, `cl`
 * charge_lines and `pa` payment_allocations. Every caller joins the same way so
 * no screen can quietly adopt a different rule.
 */
function periodOf(tx: Sql) {
  return tx`coalesce(cd.period_start, orig.period_start, cd.issue_date)`;
}

/**
 * The cut-off, defaulted once so every screen states the same date.
 *
 * The overview and the collection report used to default differently — today
 * and period end — so the same month could legitimately show two answers.
 */
export function defaultCutOff(periodEnd: string, today = new Date().toISOString().slice(0, 10)): string {
  return today > periodEnd ? today : periodEnd;
}

export const COLLECTION_QUALIFICATIONS = [
  'Billed is posted charges less credits for the period, net of corrections.',
  'A credit note counts against the period of the charge it corrects, not the month it was issued.',
  'Collected is money ALLOCATED to those charges, not money received during the period.',
  'A receipt held as unapplied credit or in suspense is not collected until it is allocated.',
  'Dates are business posting dates, not the clock time a record was captured.',
  'Allocations reversed on or before the cut-off are excluded; later reversals are not.',
  'Deposits are a liability and are excluded from both measures.',
];

/**
 * Organisation-wide collection, under the caller's own RLS scope.
 *
 * No permission check here: this is a read model, and the caller decides which
 * permission its screen requires. Row access is already the database's job.
 */
export async function collectionTotals(
  tx: Sql,
  organisationId: string,
  scope: CollectionScope,
): Promise<CollectionTotals> {
  const asOf = scope.asOf ?? defaultCutOff(scope.periodEnd);
  const period = periodOf(tx);
  const properties = scope.propertyIds?.length
    ? tx`and cl.lease_id in (select id from leases where property_id = any(${scope.propertyIds}::uuid[]))`
    : tx``;

  const [row] = await tx<{
    rent_billed: string; rent_collected: string;
    total_billed: string; total_collected: string;
    receipts_banked: string; prior_period_collected: string; unapplied: string;
    currency_code: string | null;
  }[]>`
    with scoped as (
      select cl.id, cl.category, cl.amount_minor, cl.currency_code,
             ${period} as billing_period
      from charge_lines cl
      join charge_documents cd on cd.id = cl.document_id
      left join charge_documents orig on orig.id = cd.corrects_document_id
      where cl.organisation_id = ${organisationId}::uuid
        and cd.status = 'posted'
        and cd.issue_date <= ${asOf}::date
        ${properties}
    ),
    in_period as (
      select * from scoped
      where billing_period between ${scope.periodStart}::date and ${scope.periodEnd}::date
    ),
    applied as (
      select pa.charge_line_id, sum(pa.amount_minor) as allocated_minor
      from payment_allocations pa
      where pa.organisation_id = ${organisationId}::uuid
        and pa.allocated_on <= ${asOf}::date
        and (pa.reversed_on is null or pa.reversed_on > ${asOf}::date)
      group by pa.charge_line_id
    )
    select
      coalesce(sum(p.amount_minor) filter (
        where p.category = any(${RENT_CATEGORIES}::text[])
      ), 0)::text as rent_billed,

      coalesce(sum(a.allocated_minor) filter (
        where p.category = any(${RENT_CATEGORIES}::text[])
      ), 0)::text as rent_collected,

      coalesce(sum(p.amount_minor), 0)::text as total_billed,
      coalesce(sum(a.allocated_minor), 0)::text as total_collected,

      (select min(p2.currency_code) from in_period p2) as currency_code,

      -- Cash banked during the period, whatever it paid for. Suspense included:
      -- the money is in the account even though its owner is not yet known.
      (select coalesce(sum(r.amount_minor), 0) from receipts r
        where r.organisation_id = ${organisationId}::uuid
          and r.status = 'confirmed'
          and r.received_on <= ${asOf}::date
          and r.received_on between ${scope.periodStart}::date and ${scope.periodEnd}::date
      )::text as receipts_banked,

      -- Allocations MADE this period against charges billed for an earlier one.
      -- This is what "they paid, but it cleared arrears" looks like as a number.
      (select coalesce(sum(pa.amount_minor), 0)
        from payment_allocations pa
        join scoped s on s.id = pa.charge_line_id
        where pa.organisation_id = ${organisationId}::uuid
          and pa.allocated_on between ${scope.periodStart}::date and ${scope.periodEnd}::date
          and pa.allocated_on <= ${asOf}::date
          and (pa.reversed_on is null or pa.reversed_on > ${asOf}::date)
          and s.billing_period < ${scope.periodStart}::date
      )::text as prior_period_collected,

      -- Unapplied credit as at the cut-off, computed the same way as every
      -- other figure here rather than read from the live balance view: a
      -- closed period's unapplied credit must not change next week.
      (select coalesce(sum(r.amount_minor), 0) - coalesce((
          select sum(pa.amount_minor) from payment_allocations pa
          join receipts r2 on r2.id = pa.receipt_id
          where pa.organisation_id = ${organisationId}::uuid
            and r2.status = 'confirmed' and r2.received_on <= ${asOf}::date
            and pa.allocated_on <= ${asOf}::date
            and (pa.reversed_on is null or pa.reversed_on > ${asOf}::date)
        ), 0)
        from receipts r
        where r.organisation_id = ${organisationId}::uuid
          and r.status = 'confirmed' and r.received_on <= ${asOf}::date
      )::text as unapplied

    from in_period p
    left join applied a on a.charge_line_id = p.id
  `;

  const rentBilled = BigInt(row?.rent_billed ?? '0');
  const totalBilled = BigInt(row?.total_billed ?? '0');

  return {
    periodStart: scope.periodStart,
    periodEnd: scope.periodEnd,
    asOf,
    currencyCode: row?.currency_code ?? 'ZAR',
    rent: measure(rentBilled, BigInt(row?.rent_collected ?? '0')),
    total: measure(totalBilled, BigInt(row?.total_collected ?? '0')),
    receiptsBankedMinor: BigInt(row?.receipts_banked ?? '0'),
    priorPeriodCollectedMinor: BigInt(row?.prior_period_collected ?? '0'),
    unappliedCreditMinor: BigInt(row?.unapplied ?? '0'),
  };
}

/**
 * The same measures, per lease, so a headline can be opened and checked.
 *
 * `collectionTotals` and this function share their period, cut-off and reversal
 * rules by construction — the integration suite asserts the rows sum to the
 * totals, which is the only way to keep that true.
 */
export async function collectionByLease(
  tx: Sql,
  organisationId: string,
  scope: CollectionScope,
): Promise<CollectionLeaseRow[]> {
  const asOf = scope.asOf ?? defaultCutOff(scope.periodEnd);
  const period = periodOf(tx);
  const properties = scope.propertyIds?.length
    ? tx`and l.property_id = any(${scope.propertyIds}::uuid[])`
    : tx``;

  const rows = await tx<{
    lease_id: string; reference: string; resident_name: string | null;
    unit_label: string; currency_code: string;
    rent_billed: string; rent_collected: string;
    total_billed: string; total_collected: string;
  }[]>`
    with applied as (
      select pa.charge_line_id, sum(pa.amount_minor) as allocated_minor
      from payment_allocations pa
      where pa.organisation_id = ${organisationId}::uuid
        and pa.allocated_on <= ${asOf}::date
        and (pa.reversed_on is null or pa.reversed_on > ${asOf}::date)
      group by pa.charge_line_id
    )
    select l.id as lease_id, l.reference, l.currency_code,
      (rp.first_name || ' ' || rp.last_name) as resident_name,
      p.name || ' / ' || u.code as unit_label,
      coalesce(sum(cl.amount_minor) filter (where cl.category = any(${RENT_CATEGORIES}::text[])), 0)::text as rent_billed,
      coalesce(sum(a.allocated_minor) filter (where cl.category = any(${RENT_CATEGORIES}::text[])), 0)::text as rent_collected,
      coalesce(sum(cl.amount_minor), 0)::text as total_billed,
      coalesce(sum(a.allocated_minor), 0)::text as total_collected
    from charge_lines cl
    join charge_documents cd on cd.id = cl.document_id
    left join charge_documents orig on orig.id = cd.corrects_document_id
    left join applied a on a.charge_line_id = cl.id
    join leases l on l.id = cl.lease_id
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    left join lease_parties lp
      on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
    left join resident_profiles rp on rp.id = lp.resident_id
    where cl.organisation_id = ${organisationId}::uuid
      and cd.status = 'posted'
      and cd.issue_date <= ${asOf}::date
      and ${period} between ${scope.periodStart}::date and ${scope.periodEnd}::date
      ${properties}
    group by l.id, l.reference, l.currency_code, rp.first_name, rp.last_name, p.name, u.code
    order by p.name, u.code
  `;

  return rows.map((r) => ({
    leaseId: r.lease_id,
    leaseReference: r.reference,
    residentName: r.resident_name,
    unitLabel: r.unit_label,
    currencyCode: r.currency_code,
    rent: measure(BigInt(r.rent_billed), BigInt(r.rent_collected)),
    total: measure(BigInt(r.total_billed), BigInt(r.total_collected)),
  }));
}
