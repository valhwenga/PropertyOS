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

/**
 * One document by id, for its own page.
 *
 * Scoped by organisation in the statement as well as by policy, and returns
 * undefined rather than throwing: the caller turns a miss into a 404, so a
 * document in another organisation is indistinguishable from one that does not
 * exist.
 */
export async function loadDocument(tx: Sql, organisationId: string, documentId: string) {
  const [row] = await tx<
    { id: string; title: string; classification: string; visibility: string; scan_status: string;
      scan_detail: string | null; quarantined: boolean; byte_size: string; content_type: string;
      uploaded_at: string; uploader: string | null; lease_id: string | null;
      lease_reference: string | null; property_name: string | null; superseded: boolean }[]
  >`
    select d.id, d.title, d.classification, d.visibility::text, d.scan_status::text,
           d.scan_detail, d.quarantined, d.byte_size::text, d.content_type, d.uploaded_at::text,
           up.full_name as uploader, d.lease_id, l.reference as lease_reference,
           p.name as property_name,
           exists (
             select 1 from documents newer
              where newer.supersedes_document_id = d.id and newer.deleted_at is null
           ) as superseded
    from documents d
    left join user_profiles up on up.auth_user_id = d.uploaded_by
    left join leases l on l.id = d.lease_id
    left join properties p on p.id = d.property_id
    where d.id = ${documentId}::uuid
      and d.organisation_id = ${organisationId}::uuid
      and d.deleted_at is null
  `;
  return row;
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
/**
 * Every unit an operator could log a request against, with its property and the
 * lease in force if there is one.
 *
 * Unlike the lease draft picker this includes OCCUPIED units — in fact those are
 * the ones most requests are about. The lease is carried along so a ticket logged
 * on an occupied unit is linked to the tenancy without the operator having to
 * know the lease reference.
 */
/**
 * One property, its units, and what is happening on each.
 *
 * Both this and `loadResidentDetail` exist because the Portfolio and Residents
 * tables have always linked every row to a detail page that was never built:
 * clicking any property or any resident name produced a 404. The lists show a
 * summary, so a landlord needs somewhere to look when the summary raises a
 * question.
 *
 * Scoped by organisation in the statement as well as by policy, and returns
 * undefined for a miss so the caller renders the same 404 as for a property that
 * does not exist.
 */
export async function loadPropertyDetail(tx: Sql, organisationId: string, propertyId: string) {
  const [property] = await tx<
    { id: string; name: string; code: string; property_type: string; status: string;
      address_line1: string | null; address_line2: string | null; suburb: string | null;
      city: string | null; province: string | null; postal_code: string | null;
      municipal_account_ref: string | null }[]
  >`
    select id, name, code, property_type, status, address_line1, address_line2,
           suburb, city, province, postal_code, municipal_account_ref
      from properties
     where id = ${propertyId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!property) return undefined;

  const units = await tx<
    { id: string; code: string; description: string | null; rentable_type: string;
      bedrooms: number | null; bathrooms: string | null; floor_area_sqm: string | null;
      advertised_rent_minor: string | null; status: string;
      lease_id: string | null; lease_reference: string | null; lease_status: string | null;
      rent_minor: string | null; resident_name: string | null }[]
  >`
    select u.id, u.code, u.description, u.rentable_type, u.bedrooms,
           u.bathrooms::text, u.floor_area_sqm::text, u.advertised_rent_minor::text, u.status,
           l.id as lease_id, l.reference as lease_reference, l.status::text as lease_status,
           l.rent_minor::text,
           trim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')) as resident_name
      from units u
      left join leases l
        on l.unit_id = u.id and l.status in ('active', 'notice_given', 'awaiting_execution')
      left join lease_parties lp
        on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles r on r.id = lp.resident_id
     where u.organisation_id = ${organisationId}::uuid and u.property_id = ${propertyId}::uuid
     order by u.code
     limit 500
  `;

  const tickets = await tx<
    { id: string; reference: string; status: string; urgency: string; category: string;
      unit_code: string | null; created_at: string }[]
  >`
    select t.id, t.reference, t.status::text, coalesce(t.triaged_urgency, t.urgency)::text as urgency,
           t.category::text, u.code as unit_code, t.created_at::text
      from maintenance_tickets t
      left join units u on u.id = t.unit_id
     where t.organisation_id = ${organisationId}::uuid and t.property_id = ${propertyId}::uuid
       and t.status not in ('resolved', 'closed', 'cancelled')
     order by t.created_at desc
     limit 20
  `;

  return { property, units, tickets };
}

/** One resident, their leases, and their portal access. */
export async function loadResidentDetail(tx: Sql, organisationId: string, residentId: string) {
  const [resident] = await tx<
    { id: string; first_name: string; last_name: string; email: string | null;
      phone: string | null; status: string; communication_preference: string;
      identity_number_last4: string | null; date_of_birth: string | null;
      notes: string | null; created_at: string }[]
  >`
    select id, first_name, last_name, email::text, phone, status::text,
           communication_preference, identity_number_last4, date_of_birth::text,
           notes, created_at::text
      from resident_profiles
     where id = ${residentId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!resident) return undefined;

  const leases = await tx<
    { id: string; reference: string; status: string; role: string; unit_label: string;
      start_date: string; end_date: string | null; rent_minor: string }[]
  >`
    select l.id, l.reference, l.status::text, lp.role::text,
           p.name || ' / ' || u.code as unit_label,
           l.start_date::text, l.end_date::text, l.rent_minor::text
      from lease_parties lp
      join leases l on l.id = lp.lease_id
      join units u on u.id = l.unit_id
      join properties p on p.id = u.property_id
     where lp.organisation_id = ${organisationId}::uuid
       and lp.resident_id = ${residentId}::uuid
       and lp.removed_on is null
     order by l.start_date desc
     limit 100
  `;

  const portal = await tx<
    { lease_reference: string; status: string; invited_email: string;
      invited_at: string; accepted_at: string | null; expires_at: string }[]
  >`
    select l.reference as lease_reference, pl.status::text, pl.invited_email::text,
           pl.invited_at::text, pl.accepted_at::text, pl.expires_at::text
      from portal_links pl
      join leases l on l.id = pl.lease_id
     where pl.organisation_id = ${organisationId}::uuid
       and pl.resident_id = ${residentId}::uuid
     order by pl.invited_at desc
     limit 20
  `;

  return { resident, leases, portal };
}

export async function loadTicketUnitChoices(tx: Sql, organisationId: string) {
  return tx<
    { unit_id: string; property_id: string; label: string;
      lease_id: string | null; resident_id: string | null; resident_name: string | null }[]
  >`
    select u.id as unit_id, u.property_id,
           p.name || ' / ' || u.code as label,
           l.id as lease_id,
           lp.resident_id,
           trim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')) as resident_name
      from units u
      join properties p on p.id = u.property_id
      left join leases l
        on l.unit_id = u.id and l.status in ('active', 'notice_given', 'awaiting_execution')
      left join lease_parties lp
        on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles r on r.id = lp.resident_id
     where u.organisation_id = ${organisationId}::uuid
       and u.status = 'active'
     order by p.name, u.code
     limit 500
  `;
}

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

/**
 * One receipt and everything an operator needs to apply it.
 *
 * The blueprint's reconciliation layout (§15) is bank lines on one side and
 * candidate charges on the other, so this returns the receipt, what is left on
 * it, the open charges on its lease in the order the allocation policy would
 * take them, and the allocations already made — including reversed ones, which
 * stay visible because a reversal is part of the history rather than a deletion.
 */
export async function loadReceiptForAllocation(
  tx: Sql, organisationId: string, receiptId: string,
) {
  const [receipt] = await tx<
    { id: string; receipt_number: string; received_on: string; amount_minor: string;
      unapplied_minor: string; allocated_minor: string; in_suspense: boolean;
      currency_code: string; status: string; method: string; payer_reference: string | null;
      fee_minor: string; notes: string | null;
      lease_id: string | null; lease_reference: string | null;
      resident_name: string | null; unit_label: string | null }[]
  >`
    select r.id, r.receipt_number, r.received_on::text, r.amount_minor::text,
           r.currency_code, r.status::text, r.method, r.payer_reference,
           r.fee_minor::text, r.notes, r.in_suspense, r.lease_id,
           coalesce(rb.unapplied_minor, 0)::text as unapplied_minor,
           coalesce(rb.allocated_minor, 0)::text as allocated_minor,
           l.reference as lease_reference,
           nullif(trim(coalesce(rp.first_name, '') || ' ' || coalesce(rp.last_name, '')), '')
             as resident_name,
           case when p.name is null then null else p.name || ' / ' || u.code end as unit_label
      from receipts r
      left join receipt_balances rb on rb.receipt_id = r.id
      left join leases l on l.id = r.lease_id
      left join properties p on p.id = l.property_id
      left join units u on u.id = l.unit_id
      left join lease_parties lp
        on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
     where r.id = ${receiptId}::uuid and r.organisation_id = ${organisationId}::uuid
  `;
  if (!receipt) return undefined;

  // Ordered exactly as `suggestAllocation` would take them, so the suggestion
  // and the list an operator reads cannot disagree about what "oldest" means.
  const openCharges = receipt.lease_id
    ? await tx<
        { charge_line_id: string; description: string; category: string; due_date: string;
          amount_minor: string; allocated_minor: string; outstanding_minor: string }[]
      >`
        select charge_line_id, description, category, due_date::text,
               amount_minor::text, allocated_minor::text, outstanding_minor::text
          from charge_line_balances
         where organisation_id = ${organisationId}::uuid
           and lease_id = ${receipt.lease_id}::uuid
           and outstanding_minor > 0
         order by due_date asc, charge_line_id asc
      `
    : [];

  const allocations = await tx<
    { id: string; amount_minor: string; allocated_on: string; applied_policy: string;
      reversed_on: string | null; reversal_reason: string | null;
      description: string; due_date: string; category: string }[]
  >`
    select pa.id, pa.amount_minor::text, pa.allocated_on::text, pa.applied_policy,
           pa.reversed_on::text, pa.reversal_reason,
           cl.description, cl.due_date::text, cl.category
      from payment_allocations pa
      join charge_lines cl on cl.id = pa.charge_line_id
     where pa.receipt_id = ${receiptId}::uuid and pa.organisation_id = ${organisationId}::uuid
     order by pa.allocated_at desc
  `;

  return { receipt, openCharges, allocations };
}

/** Leases a suspense receipt could belong to, newest activity first. */
export async function loadLeaseChoices(tx: Sql, organisationId: string) {
  return tx<
    { id: string; reference: string; label: string; outstanding_minor: string }[]
  >`
    select l.id, l.reference,
           p.name || ' / ' || u.code || ' — ' ||
             coalesce(nullif(trim(coalesce(rp.first_name, '') || ' ' || coalesce(rp.last_name, '')), ''),
                      'no resident on file') as label,
           coalesce((
             select sum(b.outstanding_minor) from charge_line_balances b
              where b.lease_id = l.id and b.outstanding_minor > 0
           ), 0)::text as outstanding_minor
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_parties lp
        on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
     where l.organisation_id = ${organisationId}::uuid
       and l.status in ('active', 'notice_given', 'expired')
     order by p.name, u.code
     limit 500
  `;
}

/**
 * Billing runs for an organisation, newest first.
 *
 * A run is the record that a period was billed: who prepared it, who posted it
 * and what it raised. §15 asks for a downloadable batch summary, which is this
 * plus its documents.
 */
export async function loadBillingRuns(tx: Sql, organisationId: string, limit = 24) {
  return tx<
    { id: string; period_start: string; period_end: string; status: string;
      totals_minor: string; line_count: number; exception_count: number;
      preview_version: number; created_at: string; posted_at: string | null;
      created_by_name: string | null; posted_by_name: string | null }[]
  >`
    select r.id, r.period_start::text, r.period_end::text, r.status::text,
           r.totals_minor::text, r.line_count, r.exception_count, r.preview_version,
           r.created_at::text, r.posted_at::text,
           creator.full_name as created_by_name,
           poster.full_name as posted_by_name
      from billing_runs r
      left join user_profiles creator on creator.auth_user_id = r.created_by
      left join user_profiles poster on poster.auth_user_id = r.posted_by
     where r.organisation_id = ${organisationId}::uuid
     order by r.period_start desc, r.created_at desc
     limit ${limit}
  `;
}

/** One run, with the charge documents it actually raised. */
export async function loadBillingRun(tx: Sql, organisationId: string, runId: string) {
  const [run] = await loadBillingRuns(tx, organisationId, 500).then((rows) =>
    rows.filter((r) => r.id === runId),
  );
  if (!run) return undefined;

  const documents = await tx<
    { id: string; document_number: string; lease_reference: string; unit_label: string;
      resident_name: string | null; total_minor: string; issue_date: string; due_date: string;
      currency_code: string }[]
  >`
    select cd.id, cd.document_number, cd.total_minor::text, cd.currency_code,
           cd.issue_date::text, cd.due_date::text,
           l.reference as lease_reference,
           p.name || ' / ' || u.code as unit_label,
           nullif(trim(coalesce(rp.first_name, '') || ' ' || coalesce(rp.last_name, '')), '')
             as resident_name
      from charge_documents cd
      join leases l on l.id = cd.lease_id
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_parties lp
        on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
     where cd.billing_run_id = ${runId}::uuid and cd.organisation_id = ${organisationId}::uuid
     order by p.name, u.code, cd.document_number
  `;

  return { run, documents };
}
