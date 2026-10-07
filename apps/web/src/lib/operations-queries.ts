import 'server-only';
import type { Sql } from '@propertyos/db';

export async function loadTickets(
  tx: Sql,
  organisationId: string,
  filter: 'open' | 'all',
) {
  const openStates = ['submitted', 'triaged', 'awaiting_approval', 'assigned', 'in_progress', 'awaiting_confirmation'];
  return tx<
    { id: string; reference: string; status: string; urgency: string; triaged_urgency: string | null;
      category: string; description: string; created_at: string; unit_label: string;
      resident_name: string | null; comment_count: string }[]
  >`
    select t.id, t.reference, t.status::text, t.urgency, t.triaged_urgency, t.category,
           t.description, t.created_at::text,
           p.name || coalesce(' / ' || u.code, '') as unit_label,
           (rp.first_name || ' ' || rp.last_name) as resident_name,
           (select count(*)::text from maintenance_comments c where c.ticket_id = t.id) as comment_count
    from maintenance_tickets t
    join properties p on p.id = t.property_id
    left join units u on u.id = t.unit_id
    left join resident_profiles rp on rp.id = t.reported_by_resident
    where t.organisation_id = ${organisationId}::uuid
      ${filter === 'open' ? tx`and t.status::text = any(${openStates})` : tx``}
    order by
      -- The manager's assessment drives the queue where one exists; otherwise
      -- the resident's reported urgency does.
      case coalesce(t.triaged_urgency, t.urgency)
        when 'emergency' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
      t.created_at desc
  `;
}

export async function loadTicketDetail(tx: Sql, organisationId: string, ticketId: string) {
  const [ticket] = await tx<
    { id: string; reference: string; status: string; urgency: string; triaged_urgency: string | null;
      category: string; location: string | null; description: string; access_notes: string | null;
      created_at: string; unit_label: string; resident_name: string | null;
      on_hold_reason: string | null; lease_id: string | null }[]
  >`
    select t.id, t.reference, t.status::text, t.urgency, t.triaged_urgency, t.category,
           t.location, t.description, t.access_notes, t.created_at::text, t.on_hold_reason, t.lease_id,
           p.name || coalesce(' / ' || u.code, '') as unit_label,
           (rp.first_name || ' ' || rp.last_name) as resident_name
    from maintenance_tickets t
    join properties p on p.id = t.property_id
    left join units u on u.id = t.unit_id
    left join resident_profiles rp on rp.id = t.reported_by_resident
    where t.id = ${ticketId}::uuid and t.organisation_id = ${organisationId}::uuid
  `;
  if (!ticket) return null;

  const [events, comments, quotes, workOrders] = await Promise.all([
    tx<{ from_status: string | null; to_status: string; occurred_at: string; note: string | null; actor: string | null }[]>`
      select e.from_status::text, e.to_status::text, e.occurred_at::text, e.note,
             up.full_name as actor
      from maintenance_ticket_events e
      left join user_profiles up on up.auth_user_id = e.actor_user_id
      where e.ticket_id = ${ticketId}::uuid
      order by e.occurred_at, e.id
    `,
    tx<{ id: string; audience: string; body: string; created_at: string; author: string | null }[]>`
      select c.id, c.audience::text, c.body, c.created_at::text, up.full_name as author
      from maintenance_comments c
      left join user_profiles up on up.auth_user_id = c.author_user_id
      where c.ticket_id = ${ticketId}::uuid
      order by c.created_at
    `,
    tx<{ id: string; amount_minor: string; currency_code: string; status: string; vendor_name: string }[]>`
      select q.id, q.amount_minor::text, q.currency_code, q.status, v.name as vendor_name
      from maintenance_quotes q
      join vendors v on v.id = q.vendor_id
      where q.ticket_id = ${ticketId}::uuid
      order by q.created_at
    `,
    tx<{ id: string; scope: string; status: string; spending_ceiling_minor: string | null;
         currency_code: string; vendor_name: string | null; expense_id: string | null;
         expense_status: string | null; expense_amount_minor: string | null }[]>`
      select w.id, w.scope, w.status, w.spending_ceiling_minor::text, w.currency_code,
             v.name as vendor_name,
             e.id as expense_id, e.status as expense_status, e.amount_minor::text as expense_amount_minor
      from work_orders w
      left join vendors v on v.id = w.vendor_id
      left join expenses e on e.work_order_id = w.id
      where w.ticket_id = ${ticketId}::uuid
      order by w.created_at
    `,
  ]);

  return { ticket, events, comments, quotes, workOrders };
}

export async function loadDocuments(tx: Sql, organisationId: string) {
  return tx<
    { id: string; title: string; classification: string; visibility: string; scan_status: string;
      scan_detail: string | null; quarantined: boolean; byte_size: string; content_type: string;
      uploaded_at: string; uploader: string | null; lease_reference: string | null;
      property_name: string | null; superseded: boolean }[]
  >`
    select d.id, d.title, d.classification, d.visibility::text, d.scan_status::text,
           d.scan_detail, d.quarantined, d.byte_size::text, d.content_type, d.uploaded_at::text,
           up.full_name as uploader, l.reference as lease_reference, p.name as property_name,
           -- Whether something later replaced this one, so a re-issued document
           -- reads as history rather than as a duplicate of the current version.
           exists (
             select 1 from documents newer
              where newer.supersedes_document_id = d.id and newer.deleted_at is null
           ) as superseded
    from documents d
    left join user_profiles up on up.auth_user_id = d.uploaded_by
    left join leases l on l.id = d.lease_id
    left join properties p on p.id = d.property_id
    where d.organisation_id = ${organisationId}::uuid and d.deleted_at is null
    order by d.uploaded_at desc
    limit 200
  `;
}

export async function loadInspections(tx: Sql, organisationId: string) {
  return tx<
    { id: string; inspection_type: string; status: string; performed_on: string | null;
      scheduled_for: string | null; unit_label: string; template_name: string;
      template_version: number; response: string | null; item_count: string }[]
  >`
    select i.id, i.inspection_type, i.status, i.performed_on::text, i.scheduled_for::text,
           p.name || ' / ' || u.code as unit_label,
           t.name as template_name, i.template_version,
           (select a.response from inspection_acknowledgements a
            where a.inspection_id = i.id limit 1) as response,
           (select count(*)::text from inspection_items it where it.inspection_id = i.id) as item_count
    from inspections i
    join properties p on p.id = i.property_id
    join units u on u.id = i.unit_id
    join inspection_templates t on t.id = i.template_id
    where i.organisation_id = ${organisationId}::uuid
    order by coalesce(i.performed_on, i.scheduled_for) desc nulls last, i.created_at desc
  `;
}

export async function loadPendingApprovals(tx: Sql, organisationId: string) {
  const [quotes, deposits, expenses, runs] = await Promise.all([
    tx<{ id: string; ticket_reference: string; vendor_name: string; amount_minor: string; currency_code: string }[]>`
      select q.id, t.reference as ticket_reference, v.name as vendor_name,
             q.amount_minor::text, q.currency_code
      from maintenance_quotes q
      join maintenance_tickets t on t.id = q.ticket_id
      join vendors v on v.id = q.vendor_id
      where q.organisation_id = ${organisationId}::uuid and q.status = 'submitted'
      order by q.created_at
    `,
    tx<{ id: string; event_type: string; amount_minor: string; currency_code: string; description: string }[]>`
      select de.id, de.event_type::text, de.amount_minor::text, de.currency_code, de.description
      from deposit_events de
      where de.organisation_id = ${organisationId}::uuid
        and de.event_type in ('deduction', 'refund') and de.approved_at is null
      order by de.created_at
    `,
    tx<{ id: string; description: string; amount_minor: string; currency_code: string;
         property_name: string | null; invoice_reference: string | null }[]>`
      select e.id, e.description, e.amount_minor::text, e.currency_code,
             p.name as property_name, e.invoice_reference
      from expenses e
      left join properties p on p.id = e.property_id
      where e.organisation_id = ${organisationId}::uuid and e.status = 'draft'
      order by e.created_at
    `,
    tx<{ id: string; period_start: string; totals_minor: string; line_count: number }[]>`
      select id, period_start::text, totals_minor::text, line_count
      from billing_runs
      where organisation_id = ${organisationId}::uuid and status = 'validated'
      order by period_start
    `,
  ]);
  return { quotes, deposits, expenses, runs };
}

/**
 * The reconciliation worklist: money received that is not yet tied to a charge,
 * and resident claims that are not yet verified.
 *
 * Both are read straight from posted records under the caller's own RLS
 * context. Nothing here matches a bank feed — no bank import or automatic
 * matching exists yet, and the page says so rather than implying otherwise.
 */
export async function loadReconciliation(tx: Sql, organisationId: string) {
  const unmatched = await tx<
    { receipt_id: string; receipt_number: string; received_on: string; lease_reference: string | null;
      amount_minor: string; unapplied_minor: string; in_suspense: boolean; currency_code: string }[]
  >`
    select rb.receipt_id, rb.receipt_number, rb.received_on::text, rb.currency_code,
           rb.amount_minor::text, rb.unapplied_minor::text, rb.in_suspense,
           l.reference as lease_reference
    from receipt_balances rb
    left join leases l on l.id = rb.lease_id
    where rb.organisation_id = ${organisationId}::uuid and rb.unapplied_minor > 0
    order by rb.received_on desc, rb.receipt_number desc
    limit 200
  `;

  const evidence = await tx<
    { id: string; submitted_at: string; claimed_amount_minor: string; claimed_paid_at: string | null;
      reference: string | null; status: string; lease_reference: string | null;
      resident_name: string | null; document_id: string | null }[]
  >`
    select pe.id, pe.submitted_at::text, pe.claimed_amount_minor::text,
           pe.claimed_paid_at::text, pe.reference, pe.status::text, pe.document_id,
           l.reference as lease_reference,
           nullif(trim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')), '') as resident_name
    from payment_evidence pe
    left join leases l on l.id = pe.lease_id
    left join lease_parties lp
      on lp.lease_id = pe.lease_id and lp.role = 'primary_resident'
    left join resident_profiles r on r.id = lp.resident_id
    where pe.organisation_id = ${organisationId}::uuid
      and pe.status in ('submitted', 'under_review')
    order by pe.submitted_at desc
    limit 200
  `;

  return { unmatched, evidence };
}

/**
 * The choices a new lease needs: somewhere to put it, and someone to sign it.
 *
 * Units already carrying an active or holdover lease are excluded, because
 * drafting a second lease against an occupied unit is almost always a mistake.
 * A draft does not reserve a unit, so activation is still the check that
 * matters — this just keeps the obvious error out of the list.
 */
export async function loadLeaseDraftChoices(tx: Sql, organisationId: string) {
  const units = await tx<
    { unit_id: string; label: string; advertised_rent_minor: string | null }[]
  >`
    select u.id as unit_id,
           p.name || ' / ' || u.code as label,
           u.advertised_rent_minor::text
    from units u
    join properties p on p.id = u.property_id
    where u.organisation_id = ${organisationId}::uuid
      and u.status = 'active'
      -- The statuses that mean the unit is spoken for. 'notice_given' counts:
      -- the lease is still in force until it ends.
      and not exists (
        select 1 from leases l
        where l.unit_id = u.id
          and l.status in ('active', 'awaiting_execution', 'notice_given')
      )
    order by p.name, u.code
    limit 500
  `;

  const residents = await tx<{ resident_id: string; name: string }[]>`
    select r.id as resident_id,
           trim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')) as name
    from resident_profiles r
    where r.organisation_id = ${organisationId}::uuid
    order by r.last_name, r.first_name
    limit 500
  `;

  return { units, residents };
}
