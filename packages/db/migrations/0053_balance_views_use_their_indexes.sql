-- ---------------------------------------------------------------------------
-- 0053  The balance views could not use the indexes built for them
-- ---------------------------------------------------------------------------
--
-- Measuring §26 against the blueprint's dataset showed the rent roll, the
-- overview and the collection report taking three seconds. The plan said why:
--
--     Seq Scan on charge_lines cl
--       Filter: (lease_id = l.id)
--       Rows Removed by Filter: 299940
--       loops=100
--
-- Thirty million rows examined to total a hundred leases. The index that
-- should have answered it, charge_lines_lease_due_idx, leads with
-- organisation_id — as every index in this schema does, because every query in
-- this product is about one customer. The lateral filtered on lease_id alone,
-- so the leading column was unconstrained and the index was unusable.
--
-- The same omission is in the unapplied-credit and deposit laterals beside it.
--
-- Adding the organisation to each lateral changes no result: a lease's charge
-- lines, receipts and deposit accounts belong to that lease's organisation, and
-- the composite foreign keys make any other arrangement impossible. It only
-- tells the planner what the schema already guarantees.

create or replace view lease_balances with (security_invoker = true) as
select
  l.id                as lease_id,
  l.organisation_id,
  l.property_id,
  l.unit_id,
  l.currency_code,
  coalesce(c.charged_minor, 0)        as charged_minor,
  coalesce(c.allocated_minor, 0)      as allocated_minor,
  coalesce(c.charged_minor, 0) - coalesce(c.allocated_minor, 0) as receivable_minor,
  coalesce(u.unapplied_minor, 0)      as unapplied_credit_minor,
  coalesce(d.deposit_held_minor, 0)   as deposit_held_minor
from leases l
left join lateral (
  select
    sum(cl.amount_minor) as charged_minor,
    sum(coalesce((select sum(pa.amount_minor) from payment_allocations pa
                  where pa.charge_line_id = cl.id and pa.reversed_at is null), 0)) as allocated_minor
  from charge_lines cl
  join charge_documents cd
    on cd.organisation_id = cl.organisation_id and cd.id = cl.document_id
  where cl.organisation_id = l.organisation_id
    and cl.lease_id = l.id
    and cd.status = 'posted'
) c on true
left join lateral (
  select sum(rb.unapplied_minor) as unapplied_minor
  from receipt_balances rb
  where rb.organisation_id = l.organisation_id and rb.lease_id = l.id
) u on true
left join lateral (
  select sum(de.amount_minor) as deposit_held_minor
  from deposit_accounts da
  join deposit_events de
    on de.organisation_id = da.organisation_id and de.deposit_account_id = da.id
  where da.organisation_id = l.organisation_id and da.lease_id = l.id
) d on true;

-- The same treatment for the per-charge-line view. Its own filter is already
-- organisation-scoped by every caller, but the document join was not, so a
-- query over one customer's lines still reached for every customer's documents.
create or replace view charge_line_balances with (security_invoker = true) as
select
  cl.id                       as charge_line_id,
  cl.organisation_id,
  cl.document_id,
  cl.lease_id,
  cl.category,
  cl.description,
  cl.due_date,
  cl.currency_code,
  cl.amount_minor,
  coalesce(alloc.allocated_minor, 0)                       as allocated_minor,
  cl.amount_minor - coalesce(alloc.allocated_minor, 0)     as outstanding_minor
from charge_lines cl
join charge_documents cd
  on cd.organisation_id = cl.organisation_id and cd.id = cl.document_id
left join lateral (
  select sum(pa.amount_minor) as allocated_minor
  from payment_allocations pa
  where pa.organisation_id = cl.organisation_id
    and pa.charge_line_id = cl.id
    and pa.reversed_at is null
) alloc on true
where cd.status = 'posted';

-- An allocation is looked up by its charge line constantly — once per line in
-- every balance read. Carrying the amount in the index turns each of those from
-- an index lookup plus a heap fetch into an index-only scan.
drop index if exists payment_allocations_charge_idx;
create index payment_allocations_charge_idx
  on payment_allocations (organisation_id, charge_line_id)
  include (amount_minor)
  where reversed_at is null;

select app.assert_table_privileges();
