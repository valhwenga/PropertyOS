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
      property_name: string | null }[]
  >`
    select d.id, d.title, d.classification, d.visibility::text, d.scan_status::text,
           d.scan_detail, d.quarantined, d.byte_size::text, d.content_type, d.uploaded_at::text,
           up.full_name as uploader, l.reference as lease_reference, p.name as property_name
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
