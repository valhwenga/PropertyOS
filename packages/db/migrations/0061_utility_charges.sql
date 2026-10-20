-- ---------------------------------------------------------------------------
-- 0061  Billing a tenant for water, electricity and the rest of the municipality
-- ---------------------------------------------------------------------------
--
-- Until now a lease could carry a FIXED monthly charge and nothing else. Every
-- real recovery a South African landlord makes — water, electricity, sewerage
-- (what a municipal account calls domestic effluent), refuse — moves every
-- month, because it is a meter reading multiplied by a tariff. The product
-- could hold the amount and could not hold the only thing that lets a tenant
-- check it.
--
-- So a charge line gains the arithmetic behind its amount:
--
--     meter 004312 → 004324   ·   12.000 kl × R32.1500   =   R385.80
--
-- Three rules, all enforced here rather than in a form:
--
--  1. A measured line is ALL of quantity, unit and rate, or none of them. Half
--     a calculation printed on an invoice is worse than no calculation: it
--     invites a tenant to check it and gives them nothing to check it with.
--  2. Meter readings come in pairs. One reading answers nothing.
--  3. Nothing is computed here. The amount posted is the amount charged; the
--     quantity and rate are EVIDENCE of it, and the invoice says so if they
--     do not agree. A database that quietly recomputes a line changes what a
--     tenant owes after the fact.
--
-- The category list widens at the same time, because "utility_fixed" cannot
-- tell a water recovery from a refuse charge, and a tenant disputing one needs
-- to know which it is.

alter table charge_lines
  -- 14,4 is enough for a kilolitre to four decimals and for any kWh reading a
  -- residential meter produces.
  add column if not exists quantity numeric(14,4),
  add column if not exists unit text,
  add column if not exists unit_rate_minor bigint,
  add column if not exists meter_previous numeric(14,3),
  add column if not exists meter_current numeric(14,3);

alter table charge_lines
  drop constraint if exists charge_lines_measurement_whole,
  add constraint charge_lines_measurement_whole check (
    (quantity is null and unit is null and unit_rate_minor is null)
    or (quantity is not null and unit is not null and unit_rate_minor is not null)
  ),
  drop constraint if exists charge_lines_measurement_sane,
  add constraint charge_lines_measurement_sane check (
    (quantity is null or quantity > 0)
    and (unit_rate_minor is null or unit_rate_minor >= 0)
    and (unit is null or length(btrim(unit)) between 1 and 16)
  ),
  drop constraint if exists charge_lines_meter_pair,
  add constraint charge_lines_meter_pair check (
    (meter_previous is null) = (meter_current is null)
  ),
  -- A reading without a quantity is a number on a page that explains nothing.
  drop constraint if exists charge_lines_meter_needs_quantity,
  add constraint charge_lines_meter_needs_quantity check (
    meter_current is null or quantity is not null
  );

comment on column charge_lines.quantity is
  'How much was consumed or supplied: kilolitres, kWh, units. Evidence for the '
  'amount, never the source of it — nothing recomputes a posted line.';
comment on column charge_lines.unit_rate_minor is
  'The tariff applied, in minor units. Stored so a tenant can check the sum '
  'against their municipal account.';
comment on column charge_lines.meter_current is
  'The reading this charge was raised from, with the previous one beside it. '
  'Both or neither: one reading answers nothing.';

/* ------------------------------------------------------- what a line may be */

-- Named categories, because "utility_fixed" cannot tell a water recovery from
-- a refuse charge and a tenant querying one needs to know which it is. The
-- older keys stay valid — 'utility_fixed' and 'opening_balance' among them.
-- Documents already posted are immutable, so a constraint that invalidates
-- history is a constraint that cannot be added at all.
alter table charge_lines
  drop constraint if exists charge_lines_category,
  add constraint charge_lines_category check (category in (
    'rent',
    'utility_water', 'utility_electricity', 'utility_sewerage', 'utility_refuse',
    'utility_gas', 'utility_fixed', 'utility_other',
    'parking', 'levy', 'admin_fee', 'late_fee', 'repairs_recovery', 'insurance',
    'adjustment', 'opening_balance', 'other'
  ));

alter table charge_schedules
  drop constraint if exists charge_schedules_category_check,
  add constraint charge_schedules_category_check check (category in (
    'rent',
    'utility_water', 'utility_electricity', 'utility_sewerage', 'utility_refuse',
    'utility_gas', 'utility_fixed', 'utility_other',
    'parking', 'levy', 'admin_fee', 'insurance',
    'other'
  ));

/* ------------------------- what a tenant may read about their own deposit */

-- A deposit refund is the one piece of money in this product that a tenant
-- cannot see at all: they are told what is held, and nothing about what
-- happened to it. The Rental Housing Act requires a landlord to account for
-- interest and to give written proof of every deduction, so this returns the
-- deposit's own history for a lease the caller holds — amounts, dates and the
-- description recorded with each event.
--
-- Note what it does NOT return: who approved anything, any internal note, any
-- reference to an operator. A tenant is entitled to the money's history, not
-- to the organisation's.
create or replace function app.resident_deposit_history(p_lease uuid)
returns table (
  account_id uuid,
  currency_code char(3),
  required_minor bigint,
  opened_on date,
  closed_on date,
  event_id uuid,
  event_type text,
  amount_minor bigint,
  effective_on date,
  description text,
  refund_reference text
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.currency_code, a.required_minor, a.opened_on, a.closed_on,
         e.id, e.event_type::text, e.amount_minor, e.effective_on, e.description,
         e.refund_reference
  from public.deposit_accounts a
  left join public.deposit_events e on e.deposit_account_id = a.id
  where a.lease_id = p_lease
    and app.can_access_lease_as_resident(p_lease)
  order by e.effective_on, e.created_at
$$;

comment on function app.resident_deposit_history(uuid) is
  'A tenant''s own deposit: what was received, what interest was credited, what '
  'was deducted and why, and what was refunded. No approver and no internal note.';

grant execute on function app.resident_deposit_history(uuid)
  to propertyos_app, propertyos_worker;

select app.assert_table_privileges();
