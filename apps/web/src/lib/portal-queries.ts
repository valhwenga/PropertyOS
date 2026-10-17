import 'server-only';
import type { Sql } from '@propertyos/db';

/**
 * Read models for the resident portal.
 *
 * Every one of these is scoped by the resident's own portal link, in the
 * statement as well as by policy. The portal is the one surface where the
 * person looking at it is not a member of the organisation, so nothing here
 * may rely on membership to narrow a result.
 */

/**
 * The tenancies this person actually holds a portal link to.
 *
 * The lease ids come from the viewer, which resolves them from `portal_links`.
 * The earlier version selected every lease RLS would allow, which is the
 * resident's own while they are only a resident — and the whole organisation's
 * for somebody who is also a member of staff. A landlord who rents a flat from
 * their own agency would have opened the portal and seen the portfolio.
 */
export async function loadTenancies(tx: Sql, leaseIds: string[]) {
  if (leaseIds.length === 0) return [];
  return tx<
    { id: string; reference: string; unit_label: string; currency_code: string;
      receivable_minor: string; status: string; end_date: string | null }[]
  >`
    select l.id, l.reference, l.currency_code, l.status::text, l.end_date::text,
           p.name || ' / ' || u.code as unit_label,
           coalesce(lb.receivable_minor, 0)::text as receivable_minor
    from leases l
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    left join lease_balances lb on lb.lease_id = l.id
    where l.id = any(${leaseIds}::uuid[])
    order by l.start_date desc
  `;
}

/**
 * The tenancy itself, with the time zone its dates are read in.
 *
 * The time zone matters for one small, resident-facing reason: "when did you
 * pay?" defaults to today, and the server's today is UTC. Between midnight and
 * 02:00 in Johannesburg that is yesterday, so a resident recording a payment
 * late at night was offered the wrong date — and the field, which refuses a
 * future date, then refused the right one.
 */
export async function loadTenancy(tx: Sql, leaseId: string) {
  const [row] = await tx<
    { reference: string; unit_label: string; status: string; start_date: string;
      end_date: string | null; notice_days: number | null; rent_minor: string;
      currency_code: string; time_zone: string; renewal_option_months: number | null;
      renewal_notice_months: number | null }[]
  >`
    select l.reference, l.status::text, l.start_date::text, l.end_date::text,
           l.notice_days, l.rent_minor::text, l.currency_code,
           o.time_zone,
           t.renewal_option_months, t.renewal_notice_months,
           p.name || ' / ' || u.code as unit_label
    from leases l
    join organisations o on o.id = l.organisation_id
    join properties p on p.id = l.property_id
    join units u on u.id = l.unit_id
    left join lease_agreement_terms t on t.lease_id = l.id
    where l.id = ${leaseId}::uuid
  `;
  return row ?? null;
}

/**
 * Where to pay, if the landlord has verified an account.
 *
 * Returns nothing rather than something uncertain. An unverified account is
 * not an authority to pay into, and a portal that prints bank details it
 * cannot vouch for is a redirection-fraud delivery mechanism.
 */
export async function loadPaymentDetails(tx: Sql, leaseId: string) {
  const [row] = await tx<
    { bank_name: string; account_holder: string; account_number_last4: string;
      branch_code: string | null; verified_at: string; verification_method: string | null;
      payment_reference: string }[]
  >`select * from app.resident_payment_details(${leaseId}::uuid)`;
  return row ?? null;
}

/**
 * Who to contact, from the particulars the lease agreement is generated from.
 *
 * The portal says "tell your landlord" in half a dozen places and never said
 * how. Nothing here is new to the resident — it is all on the lease they
 * signed — but at the moment they need it, the lease is in a drawer.
 */
export async function loadLandlordContact(tx: Sql, leaseId: string) {
  const [row] = await tx<
    { trading_name: string; phone: string | null; email: string | null;
      agent_name: string | null; agent_contact: string | null }[]
  >`select * from app.resident_landlord_contact(${leaseId}::uuid)`;
  return row ?? null;
}

/**
 * The requests this resident has logged, newest first.
 *
 * A resident could report a problem and then never see it again: there was no
 * screen that showed what had happened to it. The latest resident-visible
 * comment comes with it, because "we have ordered the part" is the answer to
 * the question they would otherwise phone about.
 */
export async function loadResidentRequests(tx: Sql, leaseId: string) {
  return tx<
    { id: string; reference: string; status: string; category: string; urgency: string;
      description: string; created_at: string; last_update: string | null;
      last_update_at: string | null }[]
  >`
    select t.id, t.reference, t.status::text, t.category,
           coalesce(t.triaged_urgency, t.urgency) as urgency,
           t.description, t.created_at::text,
           c.body as last_update, c.created_at::text as last_update_at
    from maintenance_tickets t
    left join lateral (
      select body, created_at
      from maintenance_comments mc
      where mc.ticket_id = t.id and mc.audience = 'resident_visible'
      order by mc.created_at desc
      limit 1
    ) c on true
    where t.lease_id = ${leaseId}::uuid
    order by t.created_at desc
    limit 20
  `;
}

/** Documents the landlord has shared with this resident. */
export async function loadSharedDocuments(tx: Sql, leaseId: string) {
  return tx<{ id: string; title: string; classification: string; uploaded_at: string }[]>`
    select id, title, classification, uploaded_at::text
    from documents
    where lease_id = ${leaseId}::uuid and visibility = 'resident_shared'
      and quarantined = false and deleted_at is null
    order by uploaded_at desc
  `;
}

/**
 * What is owed, split the way a resident reads it.
 *
 * One figure called "due now" that includes a rent invoice raised this morning
 * is not due now; it is simply unpaid. The three measures are kept apart:
 *
 *   outstanding — every unpaid posted charge, whatever its due date;
 *   overdue     — the part of it already past its due date;
 *   upcoming    — the part not yet due, with the date it falls due.
 *
 * Summed from the same `charge_line_balances` view the operator's arrears and
 * receivable figures come from, so the portal cannot disagree with the console.
 */
export async function loadBalanceSplit(tx: Sql, leaseId: string) {
  const [row] = await tx<
    { outstanding: string; overdue: string; upcoming: string;
      oldest_due: string | null; next_due: string | null; as_at: string }[]
  >`
    select
      coalesce(sum(outstanding_minor), 0)::text as outstanding,
      coalesce(sum(outstanding_minor) filter (where due_date < current_date), 0)::text as overdue,
      coalesce(sum(outstanding_minor) filter (where due_date >= current_date), 0)::text as upcoming,
      min(due_date) filter (where due_date < current_date)::text as oldest_due,
      min(due_date) filter (where due_date >= current_date)::text as next_due,
      now()::text as as_at
    from charge_line_balances
    where lease_id = ${leaseId}::uuid and outstanding_minor > 0
  `;
  return {
    outstandingMinor: BigInt(row?.outstanding ?? '0'),
    overdueMinor: BigInt(row?.overdue ?? '0'),
    upcomingMinor: BigInt(row?.upcoming ?? '0'),
    oldestDueDate: row?.oldest_due ?? null,
    nextDueDate: row?.next_due ?? null,
    asAt: row?.as_at ?? new Date().toISOString(),
  };
}

/**
 * Every piece of payment evidence this resident has submitted.
 *
 * Including the decided ones, because "what happened to the proof I sent in
 * March" is a question the portal could not answer at all. The stages come
 * from the stored record and nowhere else: a submission date, a review date
 * when somebody reviewed it, the note they left, and whether a receipt was
 * raised from it. Nothing here infers a stage the database does not hold.
 */
export async function loadPaymentEvidence(tx: Sql, leaseId: string) {
  return tx<
    { id: string; status: string; claimed_amount_minor: string; claimed_paid_at: string;
      reference: string | null; submitted_at: string; reviewed_at: string | null;
      review_note: string | null; receipt_id: string | null;
      receipt_reference: string | null; allocated_minor: string }[]
  >`
    select e.id, e.status::text, e.claimed_amount_minor::text, e.claimed_paid_at::text,
           e.reference, e.submitted_at::text, e.reviewed_at::text, e.review_note,
           e.receipt_id, r.receipt_number as receipt_reference,
           coalesce((
             select sum(a.amount_minor) from payment_allocations a
             where a.receipt_id = e.receipt_id and a.reversed_at is null
           ), 0)::text as allocated_minor
    from payment_evidence e
    left join receipts r on r.id = e.receipt_id
    where e.lease_id = ${leaseId}::uuid
    order by e.submitted_at desc
    limit 20
  `;
}

/** One request, with everything the resident is allowed to see about it. */
export async function loadResidentRequest(tx: Sql, leaseId: string, ticketId: string) {
  const [ticket] = await tx<
    { id: string; reference: string; status: string; category: string; urgency: string;
      triaged_urgency: string | null; description: string; location: string | null;
      created_at: string }[]
  >`
    select id, reference, status::text, category, urgency, triaged_urgency,
           description, location, created_at::text
    from maintenance_tickets
    where id = ${ticketId}::uuid and lease_id = ${leaseId}::uuid
  `;
  if (!ticket) return null;

  const [events, updates, photos] = await Promise.all([
    // The real status history. RLS lets a resident read the events on their
    // own ticket; the note on an event is written for the trail, so only the
    // transition itself is shown.
    tx<{ from_status: string | null; to_status: string; occurred_at: string }[]>`
      select from_status::text, to_status::text, occurred_at::text
      from maintenance_ticket_events
      where ticket_id = ${ticketId}::uuid
      order by occurred_at asc
    `,
    // Only what was written for the resident. The policy filters internal
    // comments away; the audience is stated again here so a future policy
    // change cannot quietly widen this page.
    tx<{ body: string; created_at: string; author: string | null }[]>`
      select c.body, c.created_at::text, up.full_name as author
      from maintenance_comments c
      left join user_profiles up on up.auth_user_id = c.author_user_id
      where c.ticket_id = ${ticketId}::uuid and c.audience = 'resident_visible'
      order by c.created_at asc
    `,
    tx<{ document_id: string; title: string; created_at: string }[]>`
      select a.document_id, d.title, a.created_at::text
      from maintenance_attachments a
      join documents d on d.id = a.document_id
      where a.ticket_id = ${ticketId}::uuid
        and a.audience = 'resident_visible'
        and d.deleted_at is null and d.quarantined = false
      order by a.created_at asc
    `,
  ]);

  return { ticket, events, updates, photos };
}

/**
 * The next charge that is not yet due.
 *
 * So the headline can say what is coming as well as what is owed. Kept apart
 * from the balance: money not yet due is not money somebody has failed to pay,
 * and a portal that adds them together invents arrears.
 */
export async function loadNextDue(tx: Sql, leaseId: string) {
  const [row] = await tx<{ due_date: string; amount_minor: string; currency_code: string }[]>`
    select b.due_date::text, sum(b.outstanding_minor)::text as amount_minor,
           max(l.currency_code) as currency_code
    from charge_line_balances b
    join leases l on l.id = b.lease_id
    where b.lease_id = ${leaseId}::uuid
      and b.outstanding_minor > 0
      and b.due_date >= current_date
    group by b.due_date
    order by b.due_date
    limit 1
  `;
  return row ?? null;
}
