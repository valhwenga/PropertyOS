-- ---------------------------------------------------------------------------
-- 0078  A price is a thing with a date on it
-- ---------------------------------------------------------------------------
--
-- `plans` has carried a price since the first migration and nothing has ever
-- written to it: launching a tier, raising R899, or widening an allowance
-- meant a migration and a deploy. The console could assign a customer to a
-- plan and could not change what a plan costs.
--
-- The obvious fix — make the columns editable — is wrong, and the billing run
-- is where it shows. It reads the plan's price AT THE MOMENT IT RUNS, so
-- invoicing March in April, after a price rise on 1 April, would charge March
-- at April's price. Nobody would notice until a customer did.
--
-- So a price gets a date, and the run asks for the price in force for the
-- PERIOD rather than the price today. `plan_prices` is the list of what a plan
-- has cost and will cost; `plans` keeps what a plan IS — its name, its
-- currency, whether it can still be sold.
--
-- Three things worth stating.
--
-- **The columns are dropped, not left behind.** A `monthly_price_minor` on
-- `plans` that no longer decides anything is a trap for the next person to
-- read it. Every reader was found first (three functions in two modules); the
-- drop makes a missed one fail at migrate time instead of quietly billing from
-- a stale number.
--
-- **The backfill changes nothing.** Each plan's current price becomes a row
-- effective from well before any customer existed, so every invoice this run
-- would have produced yesterday it still produces today.
--
-- **A period already invoiced cannot be repriced.** Issued invoices carry
-- their own figures and are not rewritten by anything here, so a price change
-- over an invoiced period would make the invoice and the price list disagree
-- for ever. The trigger refuses it and says which period.

create table plan_prices (
  plan_key                    text not null references plans (key) on delete cascade,
  -- The first day this price applies. A billing run for a period uses the
  -- price in force on the period's FIRST day.
  effective_from              date not null,
  included_units              integer not null check (included_units >= 0),
  monthly_price_minor         bigint not null check (monthly_price_minor >= 0),
  additional_unit_price_minor bigint not null check (additional_unit_price_minor >= 0),
  reason                      text not null,
  set_by                      uuid references auth.users (id),
  set_at                      timestamptz not null default now(),
  primary key (plan_key, effective_from)
);

comment on table plan_prices is
  'What a plan has cost and will cost. A billing run reads the price in force '
  'on the first day of the period it is billing, never the price today.';

-- Everything each plan costs now, from before any customer existed, so the
-- behaviour on the day this lands is identical to the day before.
insert into plan_prices (
  plan_key, effective_from, included_units, monthly_price_minor,
  additional_unit_price_minor, reason
)
select key, date '2000-01-01', included_units, monthly_price_minor,
       additional_unit_price_minor,
       'The price this plan shipped with, before the price list could be edited.'
  from plans;

alter table plans
  drop column included_units,
  drop column monthly_price_minor,
  drop column additional_unit_price_minor;

-- ---------------------------------------------------------------------------
-- The price in force
-- ---------------------------------------------------------------------------
create or replace function app.plan_price_at(p_plan_key text, p_on date)
returns table (
  included_units integer,
  monthly_price_minor bigint,
  additional_unit_price_minor bigint,
  effective_from date
)
language sql
stable
security definer
set search_path = ''
as $$
  select pp.included_units, pp.monthly_price_minor, pp.additional_unit_price_minor,
         pp.effective_from
    from public.plan_prices pp
   where pp.plan_key = p_plan_key
     and pp.effective_from <= p_on
   order by pp.effective_from desc
   limit 1;
$$;

comment on function app.plan_price_at(text, date) is
  'The price for this plan in force on this date: the latest one that had '
  'started by then.';

grant execute on function app.plan_price_at(text, date)
  to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- What has been invoiced is settled
-- ---------------------------------------------------------------------------
create or replace function app.plan_price_period_is_open()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_from    date;
  v_invoice record;
begin
  v_from := coalesce(new.effective_from, old.effective_from);

  select i.invoice_number, i.period_start into v_invoice
    from subscription_invoices i
   where i.plan_key = coalesce(new.plan_key, old.plan_key)
     and i.period_start >= v_from
     and i.status <> 'void'
   order by i.period_start
   limit 1;

  if v_invoice.invoice_number is not null then
    raise exception
      'A period from % has already been invoiced (% covers %). Price it from a later date.',
      v_from, v_invoice.invoice_number, v_invoice.period_start
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger plan_prices_period_open
  before insert or update or delete on plan_prices
  for each row execute function app.plan_price_period_is_open();

-- A plan must always have a price: a plan somebody can be put on, with no
-- price in force, bills them nothing and nobody notices until the month end.
create or replace function app.plan_keeps_a_price()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  -- A cascade from `plans` takes every price with it, and a plan that no
  -- longer exists needs no price. Without this the trigger makes a plan
  -- undeletable, which the first version of it did.
  if not exists (select 1 from plans where key = old.plan_key) then
    return old;
  end if;
  if not exists (select 1 from plan_prices where plan_key = old.plan_key) then
    raise exception 'That is the only price % has. A plan cannot exist with no price.',
      old.plan_key
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

create constraint trigger plan_prices_keep_one
  after delete on plan_prices
  deferrable initially deferred
  for each row execute function app.plan_keeps_a_price();

-- ---------------------------------------------------------------------------
-- Who may change the price list
-- ---------------------------------------------------------------------------
--
-- A price list is not a secret — `listPlans` has said so since it was written,
-- and a customer is entitled to see what their plan costs — so reading stays
-- open. Writing is `platform.billing.manage`, the same permission that issues
-- the invoices these prices produce.
alter table plan_prices enable row level security;

create policy plan_prices_read on plan_prices for select using (true);
create policy plan_prices_manage on plan_prices
  for all
  using (app.platform_permission('platform.billing.manage'))
  with check (app.platform_permission('platform.billing.manage'));

create policy plans_manage on plans
  for all
  using (app.platform_permission('platform.billing.manage'))
  with check (app.platform_permission('platform.billing.manage'));

create policy plan_entitlements_manage on plan_entitlements
  for all
  using (app.platform_permission('platform.billing.manage'))
  with check (app.platform_permission('platform.billing.manage'));

grant select on plan_prices to propertyos_app, propertyos_worker;
grant insert, update, delete on plan_prices to propertyos_app;
grant insert, update, delete on plans to propertyos_app;
grant insert, update, delete on plan_entitlements to propertyos_app;

select app.assert_table_privileges();
