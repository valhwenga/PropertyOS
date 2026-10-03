import type { Sql } from '@propertyos/db';
import { notFound } from './errors';
import type { Minor } from './money';
import { requirePermission } from './permissions';

/**
 * Report definitions.
 *
 * Every figure here is computed from posted records under the caller's own RLS
 * context. A report therefore describes exactly the scope the caller can see,
 * and two people with different property assignments correctly get different
 * totals from the same report.
 *
 * Each report exposes BOTH its aggregate and the rows it was computed from, so
 * a headline number on screen can always be opened and checked. The invariant
 * "the headline equals the sum of its rows" is asserted in
 * `tests/integration/reports.test.ts` rather than assumed.
 */

export interface ReportFilters {
  periodStart?: string;
  periodEnd?: string;
  propertyIds?: string[];
  asAt?: string;
}

export interface ReportMeta {
  name: string;
  generatedAt: string;
  /** Repeated back so an exported file states the filters that produced it. */
  filters: ReportFilters;
  currencyCode: string;
  /** Explicit caveats, carried into exports so a figure is never read bare. */
  qualifications: string[];
}

/* ------------------------------------------------------------------ rent roll */

export interface RentRollRow {
  propertyName: string;
  unitCode: string;
  unitStatus: string;
  leaseReference: string | null;
  leaseStatus: string | null;
  residentName: string | null;
  startDate: string | null;
  endDate: string | null;
  contractedRentMinor: Minor;
  receivableMinor: Minor;
  occupied: boolean;
}

export async function rentRoll(
  tx: Sql,
  organisationId: string,
  filters: ReportFilters = {},
): Promise<{ meta: ReportMeta; rows: RentRollRow[]; totalRentMinor: Minor; totalReceivableMinor: Minor }> {
  await requirePermission(tx, organisationId, 'report.read');
  const asAt = filters.asAt ?? new Date().toISOString().slice(0, 10);

  const rows = await tx<
    { property_name: string; unit_code: string; unit_status: string;
      lease_reference: string | null; lease_status: string | null; resident_name: string | null;
      start_date: string | null; end_date: string | null; rent_minor: string | null;
      receivable_minor: string | null; occupied: boolean; currency_code: string }[]
  >`
    select
      p.name as property_name, u.code as unit_code, u.status::text as unit_status,
      l.reference as lease_reference, l.status::text as lease_status,
      (rp.first_name || ' ' || rp.last_name) as resident_name,
      l.start_date::text, l.end_date::text,
      l.rent_minor::text,
      coalesce(lb.receivable_minor, 0)::text as receivable_minor,
      exists (
        select 1 from occupancy_intervals oi
        where oi.unit_id = u.id and oi.period @> ${asAt}::date
      ) as occupied,
      coalesce(l.currency_code, o.currency_code) as currency_code
    from units u
    join properties p on p.id = u.property_id
    cross join organisations o
    -- The lease in force at the reporting date, not merely the latest one.
    left join lateral (
      select l2.* from leases l2
      where l2.unit_id = u.id
        and l2.status in ('active', 'notice_given', 'expired')
        and l2.start_date <= ${asAt}::date
        and (l2.end_date is null or l2.end_date >= ${asAt}::date)
      order by l2.start_date desc
      limit 1
    ) l on true
    left join lease_parties lp on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
    left join resident_profiles rp on rp.id = lp.resident_id
    left join lease_balances lb on lb.lease_id = l.id
    where u.organisation_id = ${organisationId}::uuid
      and o.id = ${organisationId}::uuid
      and u.status = 'active'
      ${filters.propertyIds?.length ? tx`and u.property_id = any(${filters.propertyIds}::uuid[])` : tx``}
    order by p.name, u.code
  `;

  const mapped: RentRollRow[] = rows.map((r) => ({
    propertyName: r.property_name,
    unitCode: r.unit_code,
    unitStatus: r.unit_status,
    leaseReference: r.lease_reference,
    leaseStatus: r.lease_status,
    residentName: r.resident_name,
    startDate: r.start_date,
    endDate: r.end_date,
    contractedRentMinor: BigInt(r.rent_minor ?? '0'),
    receivableMinor: BigInt(r.receivable_minor ?? '0'),
    occupied: r.occupied,
  }));

  return {
    meta: {
      name: 'Rent roll',
      generatedAt: new Date().toISOString(),
      filters: { ...filters, asAt },
      currencyCode: rows[0]?.currency_code ?? 'ZAR',
      qualifications: [
        'Contracted rent is the lease amount, not the advertised rent.',
        'Receivable is the net unpaid balance across all posted charges, not only rent.',
        'A vacant unit shows no lease and no rent.',
      ],
    },
    rows: mapped,
    totalRentMinor: mapped.reduce((s, r) => s + r.contractedRentMinor, 0n),
    totalReceivableMinor: mapped.reduce((s, r) => s + r.receivableMinor, 0n),
  };
}

/* -------------------------------------------------------------- arrears ageing */

export interface ArrearsAgeingRow {
  leaseId: string;
  leaseReference: string;
  residentName: string | null;
  unitLabel: string;
  notYetDueMinor: Minor;
  days1to30Minor: Minor;
  days31to60Minor: Minor;
  days61to90Minor: Minor;
  daysOver90Minor: Minor;
  totalMinor: Minor;
  disputed: boolean;
}

export async function arrearsAgeing(
  tx: Sql,
  organisationId: string,
  filters: ReportFilters = {},
): Promise<{ meta: ReportMeta; rows: ArrearsAgeingRow[]; totals: Record<string, Minor> }> {
  await requirePermission(tx, organisationId, 'report.read');

  const rows = await tx<
    { lease_id: string; reference: string; resident_name: string | null; unit_label: string;
      not_yet_due: string; d1_30: string; d31_60: string; d61_90: string; over_90: string;
      total: string; disputed: boolean; currency_code: string }[]
  >`
    select
      a.lease_id, l.reference, l.currency_code,
      (rp.first_name || ' ' || rp.last_name) as resident_name,
      p.name || ' / ' || u.code as unit_label,
      coalesce(a.not_yet_due_minor, 0)::text as not_yet_due,
      coalesce(a.days_1_30_minor, 0)::text as d1_30,
      coalesce(a.days_31_60_minor, 0)::text as d31_60,
      coalesce(a.days_61_90_minor, 0)::text as d61_90,
      coalesce(a.days_over_90_minor, 0)::text as over_90,
      coalesce(a.total_outstanding_minor, 0)::text as total,
      l.dispute_flag as disputed
    from arrears_ageing a
    join leases l on l.id = a.lease_id
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    left join lease_parties lp on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
    left join resident_profiles rp on rp.id = lp.resident_id
    where a.organisation_id = ${organisationId}::uuid
      ${filters.propertyIds?.length ? tx`and l.property_id = any(${filters.propertyIds}::uuid[])` : tx``}
    order by coalesce(a.days_over_90_minor, 0) desc, a.total_outstanding_minor desc
  `;

  const mapped: ArrearsAgeingRow[] = rows.map((r) => ({
    leaseId: r.lease_id,
    leaseReference: r.reference,
    residentName: r.resident_name,
    unitLabel: r.unit_label,
    notYetDueMinor: BigInt(r.not_yet_due),
    days1to30Minor: BigInt(r.d1_30),
    days31to60Minor: BigInt(r.d31_60),
    days61to90Minor: BigInt(r.d61_90),
    daysOver90Minor: BigInt(r.over_90),
    totalMinor: BigInt(r.total),
    disputed: r.disputed,
  }));

  const sum = (pick: (r: ArrearsAgeingRow) => Minor) => mapped.reduce((s, r) => s + pick(r), 0n);

  return {
    meta: {
      name: 'Arrears ageing',
      generatedAt: new Date().toISOString(),
      filters,
      currencyCode: rows[0]?.currency_code ?? 'ZAR',
      qualifications: [
        'Buckets are driven by the charge due date, not the invoice creation date.',
        'A partial payment leaves the remainder in its original due-date bucket.',
        'Allocation order affects ageing; the applied policy is recorded on every allocation.',
        'Disputed amounts are flagged, not removed.',
      ],
    },
    rows: mapped,
    totals: {
      notYetDueMinor: sum((r) => r.notYetDueMinor),
      days1to30Minor: sum((r) => r.days1to30Minor),
      days31to60Minor: sum((r) => r.days31to60Minor),
      days61to90Minor: sum((r) => r.days61to90Minor),
      daysOver90Minor: sum((r) => r.daysOver90Minor),
      totalMinor: sum((r) => r.totalMinor),
    },
  };
}

/* ---------------------------------------------------------- collection report */

export interface CollectionRow {
  leaseReference: string;
  residentName: string | null;
  unitLabel: string;
  billedMinor: Minor;
  collectedMinor: Minor;
  outstandingMinor: Minor;
}

export async function collectionReport(
  tx: Sql,
  organisationId: string,
  filters: ReportFilters & { periodStart: string; periodEnd: string },
): Promise<{
  meta: ReportMeta; rows: CollectionRow[];
  totalBilledMinor: Minor; totalCollectedMinor: Minor; collectionRatePercent: number | null;
}> {
  await requirePermission(tx, organisationId, 'report.read');

  const rows = await tx<
    { reference: string; resident_name: string | null; unit_label: string;
      billed: string; collected: string; currency_code: string }[]
  >`
    select l.reference, l.currency_code,
      (rp.first_name || ' ' || rp.last_name) as resident_name,
      p.name || ' / ' || u.code as unit_label,
      coalesce(sum(cl.amount_minor), 0)::text as billed,
      coalesce(sum((
        select coalesce(sum(pa.amount_minor), 0) from payment_allocations pa
        where pa.charge_line_id = cl.id and pa.reversed_at is null
      )), 0)::text as collected
    from charge_lines cl
    join charge_documents cd on cd.id = cl.document_id
    join leases l on l.id = cl.lease_id
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    left join lease_parties lp on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
    left join resident_profiles rp on rp.id = lp.resident_id
    where cl.organisation_id = ${organisationId}::uuid
      and cd.status = 'posted'
      and cd.issue_date between ${filters.periodStart}::date and ${filters.periodEnd}::date
      ${filters.propertyIds?.length ? tx`and l.property_id = any(${filters.propertyIds}::uuid[])` : tx``}
    group by l.reference, l.currency_code, rp.first_name, rp.last_name, p.name, u.code
    order by p.name, u.code
  `;

  const mapped: CollectionRow[] = rows.map((r) => ({
    leaseReference: r.reference,
    residentName: r.resident_name,
    unitLabel: r.unit_label,
    billedMinor: BigInt(r.billed),
    collectedMinor: BigInt(r.collected),
    outstandingMinor: BigInt(r.billed) - BigInt(r.collected),
  }));

  const billed = mapped.reduce((s, r) => s + r.billedMinor, 0n);
  const collected = mapped.reduce((s, r) => s + r.collectedMinor, 0n);

  return {
    meta: {
      name: 'Collection report',
      generatedAt: new Date().toISOString(),
      filters,
      currencyCode: rows[0]?.currency_code ?? 'ZAR',
      qualifications: [
        'Collected means receipts ALLOCATED to charges issued in this period.',
        'A receipt held as unapplied credit is not counted as collected.',
        'Payments against prior-period arrears are excluded; see the arrears ageing report.',
      ],
    },
    rows: mapped,
    totalBilledMinor: billed,
    totalCollectedMinor: collected,
    collectionRatePercent: billed === 0n ? null : Number((collected * 10000n) / billed) / 100,
  };
}

/* -------------------------------------------------------------- deposit register */

export async function depositRegister(
  tx: Sql,
  organisationId: string,
): Promise<{
  meta: ReportMeta;
  rows: Array<{
    leaseReference: string; residentName: string | null; unitLabel: string;
    holder: string; requiredMinor: Minor; heldMinor: Minor;
    interestCreditedMinor: Minor; deductionsMinor: Minor; refundedMinor: Minor; status: string;
  }>;
  totalHeldMinor: Minor;
}> {
  await requirePermission(tx, organisationId, 'deposit.read');

  const rows = await tx<
    { reference: string; resident_name: string | null; unit_label: string; holder: string;
      required_minor: string; held: string; interest: string; deductions: string;
      refunded: string; status: string; currency_code: string }[]
  >`
    select l.reference, da.holder, da.required_minor::text, da.status, da.currency_code,
      (rp.first_name || ' ' || rp.last_name) as resident_name,
      p.name || ' / ' || u.code as unit_label,
      coalesce((select sum(de.amount_minor) from deposit_events de
                where de.deposit_account_id = da.id), 0)::text as held,
      coalesce((select sum(de.amount_minor) from deposit_events de
                where de.deposit_account_id = da.id and de.event_type = 'interest_credited'), 0)::text as interest,
      coalesce((select sum(-de.amount_minor) from deposit_events de
                where de.deposit_account_id = da.id and de.event_type = 'deduction'), 0)::text as deductions,
      coalesce((select sum(-de.amount_minor) from deposit_events de
                where de.deposit_account_id = da.id and de.event_type = 'refund'), 0)::text as refunded
    from deposit_accounts da
    join leases l on l.id = da.lease_id
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    left join lease_parties lp on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
    left join resident_profiles rp on rp.id = lp.resident_id
    where da.organisation_id = ${organisationId}::uuid
    order by p.name, u.code
  `;

  const mapped = rows.map((r) => ({
    leaseReference: r.reference,
    residentName: r.resident_name,
    unitLabel: r.unit_label,
    holder: r.holder,
    requiredMinor: BigInt(r.required_minor),
    heldMinor: BigInt(r.held),
    interestCreditedMinor: BigInt(r.interest),
    deductionsMinor: BigInt(r.deductions),
    refundedMinor: BigInt(r.refunded),
    status: r.status,
  }));

  return {
    meta: {
      name: 'Deposit register',
      generatedAt: new Date().toISOString(),
      filters: {},
      currencyCode: rows[0]?.currency_code ?? 'ZAR',
      qualifications: [
        'Deposits are a liability to the resident and are NOT rental income.',
        'A deposit does not reduce the rent receivable until an approved, lawful transfer is posted.',
        'Interest is only shown where it was recorded from actual evidence or an agreed reviewed calculation. No interest is ever accrued automatically.',
        'The holder column records who physically holds the money.',
      ],
    },
    rows: mapped,
    totalHeldMinor: mapped.reduce((s, r) => s + r.heldMinor, 0n),
  };
}

/* ------------------------------------------------------------- expense report */

export async function expenseReport(
  tx: Sql,
  organisationId: string,
  filters: ReportFilters & { periodStart: string; periodEnd: string },
): Promise<{
  meta: ReportMeta;
  rows: Array<{
    propertyName: string | null; category: string; costClass: string; description: string;
    vendorName: string | null; expenseDate: string; amountMinor: Minor; status: string;
  }>;
  totalOperatingMinor: Minor; totalCapitalMinor: Minor; totalMinor: Minor;
}> {
  await requirePermission(tx, organisationId, 'report.read');

  const rows = await tx<
    { property_name: string | null; category: string; cost_class: string; description: string;
      vendor_name: string | null; expense_date: string; amount_minor: string; status: string;
      currency_code: string }[]
  >`
    select p.name as property_name, e.category, e.cost_class, e.description,
           v.name as vendor_name, e.expense_date::text, e.amount_minor::text,
           e.status, e.currency_code
    from expenses e
    left join properties p on p.id = e.property_id
    left join vendors v on v.id = e.vendor_id
    where e.organisation_id = ${organisationId}::uuid
      and e.status <> 'void'
      and e.expense_date between ${filters.periodStart}::date and ${filters.periodEnd}::date
      ${filters.propertyIds?.length ? tx`and e.property_id = any(${filters.propertyIds}::uuid[])` : tx``}
    order by e.expense_date desc
  `;

  const mapped = rows.map((r) => ({
    propertyName: r.property_name,
    category: r.category,
    costClass: r.cost_class,
    description: r.description,
    vendorName: r.vendor_name,
    expenseDate: r.expense_date,
    amountMinor: BigInt(r.amount_minor),
    status: r.status,
  }));

  return {
    meta: {
      name: 'Expense report',
      generatedAt: new Date().toISOString(),
      filters,
      currencyCode: rows[0]?.currency_code ?? 'ZAR',
      qualifications: [
        'Operating, capital, financing and owner drawings are reported separately. Only operating costs belong in net operating income.',
        'Draft expenses are included and marked; they have not been approved.',
        'A supplier invoice is recorded once even when it is attached to both a maintenance ticket and an expense.',
      ],
    },
    rows: mapped,
    totalOperatingMinor: mapped.filter((r) => r.costClass === 'operating').reduce((s, r) => s + r.amountMinor, 0n),
    totalCapitalMinor: mapped.filter((r) => r.costClass === 'capital').reduce((s, r) => s + r.amountMinor, 0n),
    totalMinor: mapped.reduce((s, r) => s + r.amountMinor, 0n),
  };
}

/* ------------------------------------------------------------- lease expiry */

export async function leaseExpiryReport(
  tx: Sql,
  organisationId: string,
  params: { withinDays: number },
): Promise<{
  meta: ReportMeta;
  rows: Array<{
    leaseId: string; leaseReference: string; residentName: string | null; unitLabel: string;
    endDate: string; daysRemaining: number; status: string; stillOccupied: boolean;
    receivableMinor: Minor;
  }>;
}> {
  await requirePermission(tx, organisationId, 'report.read');

  const rows = await tx<
    { id: string; reference: string; resident_name: string | null; unit_label: string;
      end_date: string; days_remaining: number; status: string; still_occupied: boolean;
      receivable_minor: string; currency_code: string }[]
  >`
    select l.id, l.reference, l.status::text, l.end_date::text, l.currency_code,
      (l.end_date - current_date) as days_remaining,
      (rp.first_name || ' ' || rp.last_name) as resident_name,
      p.name || ' / ' || u.code as unit_label,
      exists (
        select 1 from occupancy_intervals oi
        where oi.lease_id = l.id and oi.move_out_at is null
      ) as still_occupied,
      coalesce(lb.receivable_minor, 0)::text as receivable_minor
    from leases l
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    left join lease_parties lp on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
    left join resident_profiles rp on rp.id = lp.resident_id
    left join lease_balances lb on lb.lease_id = l.id
    where l.organisation_id = ${organisationId}::uuid
      and l.status in ('active', 'notice_given', 'expired')
      and l.end_date is not null
      and l.end_date <= current_date + (${params.withinDays} || ' days')::interval
    order by l.end_date
  `;

  return {
    meta: {
      name: 'Lease expiry',
      generatedAt: new Date().toISOString(),
      filters: {},
      currencyCode: rows[0]?.currency_code ?? 'ZAR',
      qualifications: [
        'Physical occupation is tracked separately from lease status.',
        'An expired lease can still carry arrears and a holdover occupant; both are shown.',
      ],
    },
    rows: rows.map((r) => ({
      leaseId: r.id,
      leaseReference: r.reference,
      residentName: r.resident_name,
      unitLabel: r.unit_label,
      endDate: r.end_date,
      daysRemaining: r.days_remaining,
      status: r.status,
      stillOccupied: r.still_occupied,
      receivableMinor: BigInt(r.receivable_minor),
    })),
  };
}

/* --------------------------------------------------------------- journal lines */

export async function journalLinesExport(
  tx: Sql,
  organisationId: string,
  filters: { periodStart: string; periodEnd: string },
): Promise<{
  meta: ReportMeta;
  rows: Array<{
    postingDate: string; journalId: string; source: string; description: string;
    accountCode: string; accountName: string; debitMinor: Minor; creditMinor: Minor;
    leaseReference: string | null; propertyName: string | null;
  }>;
  totalDebitMinor: Minor; totalCreditMinor: Minor; balanced: boolean;
}> {
  await requirePermission(tx, organisationId, 'report.read');

  const rows = await tx<
    { posting_date: string; journal_id: string; source: string; description: string;
      account_code: string; account_name: string; debit_minor: string; credit_minor: string;
      lease_reference: string | null; property_name: string | null; currency_code: string }[]
  >`
    select j.posting_date::text, j.id as journal_id, j.source::text, j.description,
           a.code as account_code, a.name as account_name,
           jl.debit_minor::text, jl.credit_minor::text, j.currency_code,
           l.reference as lease_reference, p.name as property_name
    from journal_lines jl
    join journals j on j.id = jl.journal_id
    join accounts a on a.id = jl.account_id
    left join leases l on l.id = jl.lease_id
    left join properties p on p.id = jl.property_id
    where jl.organisation_id = ${organisationId}::uuid
      and j.posting_date between ${filters.periodStart}::date and ${filters.periodEnd}::date
    order by j.posting_date, j.id, jl.line_number
  `;

  const mapped = rows.map((r) => ({
    postingDate: r.posting_date,
    journalId: r.journal_id,
    source: r.source,
    description: r.description,
    accountCode: r.account_code,
    accountName: r.account_name,
    debitMinor: BigInt(r.debit_minor),
    creditMinor: BigInt(r.credit_minor),
    leaseReference: r.lease_reference,
    propertyName: r.property_name,
  }));

  const debit = mapped.reduce((s, r) => s + r.debitMinor, 0n);
  const credit = mapped.reduce((s, r) => s + r.creditMinor, 0n);

  return {
    meta: {
      name: 'Journal lines',
      generatedAt: new Date().toISOString(),
      filters,
      currencyCode: rows[0]?.currency_code ?? 'ZAR',
      qualifications: [
        'This is the complete double-entry detail for the period, for an accountant to reconcile.',
        'Posted journals are immutable; corrections appear as separate linked reversal journals.',
      ],
    },
    rows: mapped,
    totalDebitMinor: debit,
    totalCreditMinor: credit,
    // A period extract only balances if no journal straddles the boundary, which
    // cannot happen: a journal posts on a single date.
    balanced: debit === credit,
  };
}

/* ------------------------------------------------------------------- occupancy */

export async function occupancyReport(
  tx: Sql,
  organisationId: string,
  params: { periodStart: string; periodEnd: string },
): Promise<{
  meta: ReportMeta;
  occupiedUnitDays: number;
  availableUnitDays: number;
  outOfServiceUnitDays: number;
  physicalOccupancyPercent: number | null;
}> {
  await requirePermission(tx, organisationId, 'report.read');

  const [row] = await tx<
    { occupied_days: string; available_days: string; out_of_service_days: string }[]
  >`
    with period as (
      select ${params.periodStart}::date as s, ${params.periodEnd}::date as e
    ),
    unit_days as (
      select u.id,
        (select e from period) - (select s from period) + 1 as total_days
      from units u
      where u.organisation_id = ${organisationId}::uuid and u.status = 'active'
    ),
    occupied as (
      select coalesce(sum(
        greatest(0,
          least(upper(oi.period) - 1, (select e from period))
          - greatest(lower(oi.period), (select s from period)) + 1)
      ), 0) as days
      from occupancy_intervals oi
      join units u on u.id = oi.unit_id
      where oi.organisation_id = ${organisationId}::uuid and u.status = 'active'
        and oi.period && daterange((select s from period), (select e from period), '[]')
    ),
    out_of_service as (
      select coalesce(sum(
        greatest(0,
          least(upper(ua.period) - 1, (select e from period))
          - greatest(lower(ua.period), (select s from period)) + 1)
      ), 0) as days
      from unit_availability ua
      join units u on u.id = ua.unit_id
      where ua.organisation_id = ${organisationId}::uuid and u.status = 'active'
        and ua.period && daterange((select s from period), (select e from period), '[]')
    )
    select
      (select days from occupied)::text as occupied_days,
      coalesce((select sum(total_days) from unit_days), 0)::text as available_days,
      (select days from out_of_service)::text as out_of_service_days
  `;

  const occupied = Number(row?.occupied_days ?? 0);
  const gross = Number(row?.available_days ?? 0);
  const outOfService = Number(row?.out_of_service_days ?? 0);
  // Out-of-service days are removed from the DENOMINATOR, so a unit withdrawn
  // for renovation does not look like a letting failure.
  const available = Math.max(0, gross - outOfService);

  return {
    meta: {
      name: 'Occupancy',
      generatedAt: new Date().toISOString(),
      filters: { periodStart: params.periodStart, periodEnd: params.periodEnd },
      currencyCode: 'ZAR',
      qualifications: [
        'Physical occupancy is occupied rentable unit days divided by available rentable unit days.',
        'Days a unit was recorded out of service are excluded from the denominator, so a renovation does not read as a letting failure.',
        'This measures physical occupation, not commercial availability or lease status.',
      ],
    },
    occupiedUnitDays: occupied,
    availableUnitDays: available,
    outOfServiceUnitDays: outOfService,
    physicalOccupancyPercent: available === 0 ? null : Math.round((occupied / available) * 10000) / 100,
  };
}

/** Converts any report to CSV, carrying its filters and qualifications. */
export function toCsv(
  meta: ReportMeta,
  columns: Array<{ key: string; label: string }>,
  rows: Array<Record<string, unknown>>,
): string {
  const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines: string[] = [
    [meta.name].map(escape).join(','),
    ['Generated at', meta.generatedAt].map(escape).join(','),
    ['Currency', meta.currencyCode].map(escape).join(','),
    ['Filters', JSON.stringify(meta.filters)].map(escape).join(','),
    '',
  ];
  // The caveats travel WITH the data, so a figure is never read bare in a
  // spreadsheet divorced from its definition.
  for (const q of meta.qualifications) lines.push(['Note', q].map(escape).join(','));
  lines.push('');
  lines.push(columns.map((c) => escape(c.label)).join(','));
  for (const row of rows) lines.push(columns.map((c) => escape(row[c.key])).join(','));
  return lines.join('\r\n');
}
