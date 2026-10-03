import 'server-only';
import type { Sql } from '@propertyos/db';

/**
 * Read models for the operator experience.
 *
 * Every figure here is derived from posted records under the caller's own RLS
 * context. Nothing is cached, estimated or substituted: if a viewer's scope
 * covers two of five properties, these numbers describe those two properties.
 */

export interface DashboardMetrics {
  periodStart: string;
  periodEnd: string;
  rentBilledMinor: string;
  rentCollectedMinor: string;
  receivableMinor: string;
  arrearsMinor: string;
  occupiedUnits: number;
  rentableUnits: number;
  expiringLeases: number;
  unmatchedReceipts: number;
  suspenseMinor: string;
  unverifiedEvidence: number;
  maintenanceNeedingAttention: number;
  pendingApprovals: number;
  /** Set when the organisation has no financial activity yet. */
  hasActivity: boolean;
}

export async function loadDashboard(
  tx: Sql,
  organisationId: string,
  periodStart: string,
): Promise<DashboardMetrics> {
  const [y, m] = periodStart.split('-').map(Number) as [number, number];
  const periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  const [row] = await tx<
    {
      rent_billed: string; rent_collected: string; receivable: string; arrears: string;
      occupied_units: string; rentable_units: string; expiring_leases: string;
      unmatched_receipts: string; suspense: string; unverified_evidence: string;
      maintenance_attention: string; pending_approvals: string; has_activity: boolean;
    }[]
  >`
    select
      -- Rent billed: posted rent charges less rent credits, in the period.
      coalesce((
        select sum(cl.amount_minor) from charge_lines cl
        join charge_documents cd on cd.id = cl.document_id
        where cl.organisation_id = ${organisationId}::uuid
          and cd.status = 'posted' and cl.category = 'rent'
          and cd.issue_date between ${periodStart}::date and ${periodEnd}::date
      ), 0)::text as rent_billed,

      -- Collected: allocations APPLIED to charges issued in this period.
      coalesce((
        select sum(pa.amount_minor) from payment_allocations pa
        join charge_lines cl on cl.id = pa.charge_line_id
        join charge_documents cd on cd.id = cl.document_id
        where pa.organisation_id = ${organisationId}::uuid
          and pa.reversed_at is null
          and cd.issue_date between ${periodStart}::date and ${periodEnd}::date
      ), 0)::text as rent_collected,

      coalesce((
        select sum(b.outstanding_minor) from charge_line_balances b
        where b.organisation_id = ${organisationId}::uuid and b.outstanding_minor > 0
      ), 0)::text as receivable,

      -- Arrears: outstanding with a due date already past.
      coalesce((
        select sum(b.outstanding_minor) from charge_line_balances b
        where b.organisation_id = ${organisationId}::uuid
          and b.outstanding_minor > 0 and b.due_date < current_date
      ), 0)::text as arrears,

      (select count(*) from occupancy_intervals oi
       where oi.organisation_id = ${organisationId}::uuid
         and oi.period @> current_date)::text as occupied_units,

      (select count(*) from units u
       where u.organisation_id = ${organisationId}::uuid and u.status = 'active')::text as rentable_units,

      (select count(*) from leases l
       where l.organisation_id = ${organisationId}::uuid
         and l.status in ('active', 'notice_given')
         and l.end_date between current_date and current_date + interval '90 days')::text as expiring_leases,

      (select count(*) from bank_transactions bt
       where bt.organisation_id = ${organisationId}::uuid
         and bt.match_status in ('unmatched', 'needs_review') and bt.amount_minor > 0)::text as unmatched_receipts,

      coalesce((
        select sum(rb.unapplied_minor) from receipt_balances rb
        where rb.organisation_id = ${organisationId}::uuid and rb.in_suspense
      ), 0)::text as suspense,

      (select count(*) from payment_evidence pe
       where pe.organisation_id = ${organisationId}::uuid
         and pe.status in ('submitted', 'under_review'))::text as unverified_evidence,

      (select count(*) from maintenance_tickets t
       where t.organisation_id = ${organisationId}::uuid
         and t.status in ('submitted', 'triaged', 'awaiting_approval'))::text as maintenance_attention,

      ((select count(*) from maintenance_quotes q
        where q.organisation_id = ${organisationId}::uuid and q.status = 'submitted')
       + (select count(*) from deposit_events de
          where de.organisation_id = ${organisationId}::uuid
            and de.event_type in ('deduction', 'refund') and de.approved_at is null)
       + (select count(*) from expenses e
          where e.organisation_id = ${organisationId}::uuid and e.status = 'draft')
       + (select count(*) from billing_runs br
          where br.organisation_id = ${organisationId}::uuid and br.status = 'validated')
      )::text as pending_approvals,

      exists (select 1 from journals j where j.organisation_id = ${organisationId}::uuid) as has_activity
  `;

  return {
    periodStart,
    periodEnd,
    rentBilledMinor: row!.rent_billed,
    rentCollectedMinor: row!.rent_collected,
    receivableMinor: row!.receivable,
    arrearsMinor: row!.arrears,
    occupiedUnits: Number(row!.occupied_units),
    rentableUnits: Number(row!.rentable_units),
    expiringLeases: Number(row!.expiring_leases),
    unmatchedReceipts: Number(row!.unmatched_receipts),
    suspenseMinor: row!.suspense,
    unverifiedEvidence: Number(row!.unverified_evidence),
    maintenanceNeedingAttention: Number(row!.maintenance_attention),
    pendingApprovals: Number(row!.pending_approvals),
    hasActivity: row!.has_activity,
  };
}

export interface ArrearsRow {
  leaseId: string; leaseReference: string; residentName: string;
  unitLabel: string; outstandingMinor: string; oldestDueDate: string; currencyCode: string;
}

export async function loadArrears(tx: Sql, organisationId: string, limit = 50): Promise<ArrearsRow[]> {
  const rows = await tx<
    { lease_id: string; reference: string; resident_name: string; unit_label: string;
      outstanding: string; oldest_due: string; currency_code: string }[]
  >`
    select
      l.id as lease_id, l.reference, l.currency_code,
      coalesce(rp.first_name || ' ' || rp.last_name, '—') as resident_name,
      p.name || ' / ' || u.code as unit_label,
      sum(b.outstanding_minor)::text as outstanding,
      min(b.due_date)::text as oldest_due
    from charge_line_balances b
    join leases l on l.id = b.lease_id
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    left join lease_parties lp on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
    left join resident_profiles rp on rp.id = lp.resident_id
    where b.organisation_id = ${organisationId}::uuid
      and b.outstanding_minor > 0
      and b.due_date < current_date
    group by l.id, l.reference, l.currency_code, rp.first_name, rp.last_name, p.name, u.code
    order by min(b.due_date) asc
    limit ${limit}
  `;
  return rows.map((r) => ({
    leaseId: r.lease_id, leaseReference: r.reference, residentName: r.resident_name,
    unitLabel: r.unit_label, outstandingMinor: r.outstanding,
    oldestDueDate: r.oldest_due, currencyCode: r.currency_code,
  }));
}

export async function loadProperties(tx: Sql, organisationId: string) {
  return tx<
    { id: string; name: string; code: string; property_type: string; city: string;
      unit_count: string; occupied_count: string }[]
  >`
    select p.id, p.name, p.code, p.property_type::text, p.city,
      (select count(*) from units u where u.property_id = p.id and u.status = 'active')::text as unit_count,
      (select count(*) from units u
        join occupancy_intervals oi on oi.unit_id = u.id and oi.period @> current_date
        where u.property_id = p.id)::text as occupied_count
    from properties p
    where p.organisation_id = ${organisationId}::uuid and p.status = 'active'
    order by p.name
  `;
}

export async function loadLeases(tx: Sql, organisationId: string) {
  return tx<
    { id: string; reference: string; status: string; start_date: string; end_date: string | null;
      rent_minor: string; currency_code: string; unit_label: string; resident_name: string;
      receivable_minor: string }[]
  >`
    select l.id, l.reference, l.status::text, l.start_date::text, l.end_date::text,
           l.rent_minor::text, l.currency_code,
           p.name || ' / ' || u.code as unit_label,
           coalesce(rp.first_name || ' ' || rp.last_name, '—') as resident_name,
           coalesce(lb.receivable_minor, 0)::text as receivable_minor
    from leases l
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    left join lease_parties lp on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
    left join resident_profiles rp on rp.id = lp.resident_id
    left join lease_balances lb on lb.lease_id = l.id
    where l.organisation_id = ${organisationId}::uuid
    order by l.status, l.start_date desc
  `;
}

export async function loadResidents(tx: Sql, organisationId: string) {
  return tx<
    { id: string; first_name: string; last_name: string; email: string | null;
      phone: string | null; status: string; identity_number_last4: string | null;
      lease_count: string; has_portal: boolean }[]
  >`
    select r.id, r.first_name, r.last_name, r.email, r.phone, r.status::text,
           r.identity_number_last4,
           (select count(*) from lease_parties lp where lp.resident_id = r.id)::text as lease_count,
           exists (
             select 1 from portal_links pl
             where pl.resident_id = r.id and pl.status = 'active'
           ) as has_portal
    from resident_profiles r
    where r.organisation_id = ${organisationId}::uuid and r.status <> 'archived'
    order by r.last_name, r.first_name
  `;
}
