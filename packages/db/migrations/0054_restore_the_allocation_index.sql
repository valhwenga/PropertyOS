-- ---------------------------------------------------------------------------
-- 0054  Putting back an index 0053 should not have moved
-- ---------------------------------------------------------------------------
--
-- 0053 replaced payment_allocations_charge_idx — (charge_line_id) where not
-- reversed — with an organisation-leading version, on the reasoning that every
-- query in this product is about one customer. That reasoning was right about
-- the queries it had just fixed and wrong about this index, because the
-- allocation lookup inside `lease_balances` filters on the charge line alone:
--
--     select sum(pa.amount_minor) from payment_allocations pa
--      where pa.charge_line_id = cl.id and pa.reversed_at is null
--
-- With the leading column unconstrained, that lookup fell back to a sequential
-- scan of every allocation in the database, six thousand times over. Measured:
-- the view went from 2.4 seconds to 194 seconds. The fix for a missing
-- predicate is to add the predicate, not to move the index out from under the
-- query that was using it correctly.
--
-- So: the original shape, plus the covering column that makes each lookup an
-- index-only scan, and the organisation added to the view's own subquery so a
-- future organisation-leading index would also serve it.

drop index if exists payment_allocations_charge_idx;
create index payment_allocations_charge_idx
  on payment_allocations (charge_line_id)
  include (organisation_id, amount_minor)
  where reversed_at is null;

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
                   where pa.charge_line_id = cl.id
                     and pa.organisation_id = cl.organisation_id
                     and pa.reversed_at is null), 0)) as allocated_minor
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

select app.assert_table_privileges();
