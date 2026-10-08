-- 0036_allocation_business_dates.sql
-- When an allocation happened, in the business's calendar rather than the
-- server's clock.
--
-- `allocated_at` and `reversed_at` are system timestamps: the instant a row was
-- written. That is the right thing for an audit trail and the wrong thing for a
-- report. An operator who captures January's receipts on the 3rd of February is
-- describing January, and a management pack "as at 31 January" must include
-- that allocation. Asked the other way round: a figure for a closed month must
-- not change because someone corrected an allocation in March.
--
-- Both questions need the posting date, which the ledger has always carried on
-- the journal. These two columns put it on the allocation itself so a report can
-- apply a cut-off without joining through to the journal — and so a reversal has
-- a business date at all, which until now it did not.
--
-- The system timestamps are untouched. Nothing here rewrites financial history:
-- the columns are additive, the backfill derives each row's date from the
-- journal that already recorded it, and the amounts are not read.

alter table payment_allocations
  add column allocated_on date,
  add column reversed_on  date;

-- Backfill from the journal's posting date, which is the business date the
-- allocation was actually posted under. Rows with no journal (none expected, but
-- the column is nullable) fall back to the system timestamp's date.
update payment_allocations pa
set allocated_on = coalesce(j.posting_date, pa.allocated_at::date)
from journals j
where j.id = pa.journal_id and pa.allocated_on is null;

update payment_allocations
set allocated_on = allocated_at::date
where allocated_on is null;

-- A reversal's business date. Before this column existed the reversal journal
-- held the only business date, so the best available answer for historical rows
-- is the day the reversal was recorded.
update payment_allocations
set reversed_on = reversed_at::date
where reversed_at is not null and reversed_on is null;

alter table payment_allocations
  alter column allocated_on set not null,
  alter column allocated_on set default current_date;

-- The pair must agree: a reversed allocation has a reversal date, an open one
-- does not. Otherwise a cut-off could read an allocation as both live and
-- reversed depending on which column it consulted.
alter table payment_allocations
  add constraint payment_allocations_reversal_dates_agree
    check ((reversed_at is null) = (reversed_on is null));

comment on column payment_allocations.allocated_on is
  'Business date the allocation was posted under, from the journal. Reports '
  'apply their cut-off to this, not to allocated_at, which is the system clock.';
comment on column payment_allocations.reversed_on is
  'Business date of the reversal. Null while the allocation stands. A report '
  'as at a date before this still counts the allocation, which is what makes a '
  'closed period reproducible.';

-- Reports filter on the business date and skip reversed rows, in that order.
create index payment_allocations_allocated_on_idx
  on payment_allocations (organisation_id, allocated_on)
  where reversed_on is null;

-- The business date is now part of what an allocation IS, so it is immutable in
-- the same way its amount is. Without this a posting date could be edited after
-- the fact and a closed period would quietly restate.
create or replace function app.guard_allocation_update()
returns trigger
language plpgsql
as $$
begin
  if new.receipt_id <> old.receipt_id
     or new.charge_line_id <> old.charge_line_id
     or new.amount_minor <> old.amount_minor
     or new.allocated_on <> old.allocated_on
     or new.journal_id is distinct from old.journal_id then
    raise exception 'an allocation may only be reversed, not amended'
      using errcode = '42501',
            hint = 'Reverse the allocation and create a new one.';
  end if;
  if old.reversed_at is not null then
    raise exception 'allocation % is already reversed', old.id using errcode = '42501';
  end if;
  return new;
end;
$$;
