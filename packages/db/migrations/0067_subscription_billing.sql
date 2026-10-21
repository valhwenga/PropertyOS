-- ---------------------------------------------------------------------------
-- 0067  Spike charges the landlord
-- ---------------------------------------------------------------------------
--
-- The product has had plans, prices, unit allowances and an overage rate since
-- the first migration, and has never charged anybody. A landlord could be on
-- the portfolio plan at R899 a month with eleven units over the allowance and
-- there was no invoice, no amount owed and no record of having been billed —
-- the reconciliation document carried the whole area as Absent.
--
-- Two decisions are in this schema rather than in code, because they are the
-- ones that would otherwise be quietly broken later.
--
-- **Spike's own billing identity is configuration, not a constant.** An
-- invoice carries a supplier's legal name, address and VAT registration
-- number, and this repository does not know them: inventing a VAT number would
-- be inventing a tax document. So they live in a row an operator fills in, an
-- invoice records what they were AT ISSUE, and a document with no VAT number
-- behind it says INVOICE and shows no tax — exactly the rule docs/scopes/vat.md
-- sets out for the landlord's own documents, applied to Spike's.
--
-- Note which supply this is. The landlord's rent to a resident is usually
-- exempt (section 12(c)); Spike's software to the landlord is an ordinary
-- standard-rated service, so the two have nothing in common but the word VAT.
--
-- **One invoice per customer per period, enforced by a unique index.** A
-- billing run is a thing an operator clicks, twice when they are unsure
-- whether the first one worked, and double-charging a customer is the worst
-- available outcome. `unique (organisation_id, period_start)` makes the second
-- run a no-op rather than a second invoice.

-- ---------------------------------------------------------------------------
-- Who is doing the charging
-- ---------------------------------------------------------------------------
create table platform_billing_settings (
  -- One row, forever: `id` can only be true.
  id                 boolean primary key default true check (id),
  legal_name         text,
  address            text,
  email              text,
  -- Null means not a registered vendor, which is a real state and not a
  -- missing field: an invoice then shows no tax and does not call itself one.
  vat_number         text,
  vat_rate_bp        integer not null default 1500
                     check (vat_rate_bp between 0 and 10000),
  bank_details       text,
  payment_terms_days integer not null default 14
                     check (payment_terms_days between 0 and 90),
  currency_code      char(3) not null default 'ZAR',
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id)
);

comment on table platform_billing_settings is
  'Spike''s own invoicing details. Not constants in code: an invoice carries a '
  'legal name, an address and a VAT number, and inventing any of them would be '
  'inventing a tax document.';
comment on column platform_billing_settings.vat_number is
  'Null means Spike is not a registered vendor. Invoices then show no tax and '
  'are headed INVOICE rather than TAX INVOICE.';

insert into platform_billing_settings (id) values (true);

alter table platform_billing_settings enable row level security;

create policy platform_billing_settings_platform_all on platform_billing_settings
  for all
  using (app.is_platform_operator())
  with check (app.is_platform_operator());

grant select, update on platform_billing_settings to propertyos_app;

-- ---------------------------------------------------------------------------
-- What was charged
-- ---------------------------------------------------------------------------
create type app.subscription_invoice_status as enum ('issued', 'paid', 'void');

create table subscription_invoices (
  id                  uuid primary key default gen_random_uuid(),
  organisation_id     uuid not null references organisations(id),
  invoice_number      text not null unique,
  period_start        date not null,
  period_end          date not null,
  issue_date          date not null,
  due_date            date not null,
  currency_code       char(3) not null,
  -- The plan as it was, by name as well as key: a plan can be renamed or
  -- withdrawn, and an invoice must still read the way it read when it was sent.
  plan_key            text not null references plans(key),
  plan_name           text not null,
  included_units      integer not null check (included_units >= 0),
  billable_units      integer not null check (billable_units >= 0),
  units_over          integer not null check (units_over >= 0),
  subtotal_minor      bigint  not null check (subtotal_minor >= 0),
  vat_rate_bp         integer not null check (vat_rate_bp between 0 and 10000),
  vat_minor           bigint  not null check (vat_minor >= 0),
  total_minor         bigint  not null check (total_minor >= 0),
  -- What Spike's VAT registration was at the moment of issue. Null means the
  -- document is an invoice and not a tax invoice, and it stays null afterwards
  -- even if Spike registers later.
  supplier_vat_number text,
  status              app.subscription_invoice_status not null default 'issued',
  paid_on             date,
  paid_minor          bigint check (paid_minor is null or paid_minor >= 0),
  payment_reference   text,
  payment_recorded_by uuid references auth.users(id),
  voided_at           timestamptz,
  void_reason         text,
  voided_by           uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),

  -- Billing one customer twice for one month is the failure this table exists
  -- to prevent.
  unique (organisation_id, period_start),
  constraint subscription_invoices_period check (period_end > period_start),
  constraint subscription_invoices_due check (due_date >= issue_date),
  constraint subscription_invoices_total check (total_minor = subtotal_minor + vat_minor),
  constraint subscription_invoices_paid_is_attributed
    check ((status = 'paid') = (paid_on is not null)),
  constraint subscription_invoices_void_has_a_reason
    check ((voided_at is null) = (void_reason is null)),
  constraint subscription_invoices_void_status
    check ((status = 'void') = (voided_at is not null))
);

comment on table subscription_invoices is
  'What Spike charged a customer for one period. Immutable once issued except '
  'for being paid or voided: there is no path that edits an issued invoice.';

create index subscription_invoices_org_idx
  on subscription_invoices (organisation_id, period_start desc);
create index subscription_invoices_unpaid_idx
  on subscription_invoices (due_date)
  where status = 'issued';

create table subscription_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references subscription_invoices(id) on delete cascade,
  line_no           integer not null check (line_no > 0),
  kind              text not null check (kind in ('plan', 'overage')),
  description       text not null,
  quantity          numeric(12, 2) not null check (quantity > 0),
  unit_price_minor  bigint not null check (unit_price_minor >= 0),
  amount_minor      bigint not null check (amount_minor >= 0),
  unique (invoice_id, line_no)
);

alter table subscription_invoices enable row level security;
alter table subscription_invoice_lines enable row level security;

-- Spike's side: an operator issues, records payment, and voids.
create policy subscription_invoices_platform_select on subscription_invoices
  for select using (app.is_platform_operator());
create policy subscription_invoices_platform_insert on subscription_invoices
  for insert with check (app.is_platform_operator());
create policy subscription_invoices_platform_update on subscription_invoices
  for update using (app.is_platform_operator())
  with check (app.is_platform_operator());

-- The customer's side: their own bill, for whoever manages the organisation.
-- Not every member — what Spike charges is commercial information about the
-- business, in the same class as the banking details.
create policy subscription_invoices_customer_select on subscription_invoices
  for select
  using (app.has_permission(organisation_id, 'organisation.settings.manage'));

create policy subscription_invoice_lines_platform_select on subscription_invoice_lines
  for select using (app.is_platform_operator());
create policy subscription_invoice_lines_platform_insert on subscription_invoice_lines
  for insert with check (app.is_platform_operator());
create policy subscription_invoice_lines_customer_select on subscription_invoice_lines
  for select
  using (exists (
    select 1 from subscription_invoices i
     where i.id = invoice_id
       and app.has_permission(i.organisation_id, 'organisation.settings.manage')
  ));

grant select, insert, update on subscription_invoices to propertyos_app;
grant select, insert on subscription_invoice_lines to propertyos_app;
grant select on subscription_invoices, subscription_invoice_lines to propertyos_worker;

-- A customer has to be able to read the supplier details printed on their own
-- invoice, and must not be able to read them before there is an invoice — a
-- function rather than a policy, because what they may see is "the supplier of
-- a document I hold", not "this table".
create function app.platform_biller()
returns table (
  legal_name text, address text, email text, vat_number text,
  bank_details text, currency_code text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.legal_name, s.address, s.email, s.vat_number, s.bank_details,
         s.currency_code::text
    from public.platform_billing_settings s
   where s.id
     and (
       app.is_platform_operator()
       or exists (
         select 1 from public.subscription_invoices i
          where i.organisation_id in (select app.member_organisation_ids())
       )
     );
$$;

-- ---------------------------------------------------------------------------
-- An issued invoice does not change its mind about what it charged
-- ---------------------------------------------------------------------------
create or replace function app.subscription_invoice_is_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organisation_id   is distinct from old.organisation_id
     or new.invoice_number is distinct from old.invoice_number
     or new.period_start   is distinct from old.period_start
     or new.period_end     is distinct from old.period_end
     or new.issue_date     is distinct from old.issue_date
     or new.subtotal_minor is distinct from old.subtotal_minor
     or new.vat_minor      is distinct from old.vat_minor
     or new.total_minor    is distinct from old.total_minor
     or new.plan_key       is distinct from old.plan_key
     or new.billable_units is distinct from old.billable_units
     or new.supplier_vat_number is distinct from old.supplier_vat_number
  then
    raise exception 'Invoice % has been issued; what it charged cannot be changed. Void it and issue another.', old.invoice_number
      using errcode = 'check_violation';
  end if;
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'Invoice % has been voided and cannot be reinstated.', old.invoice_number
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger subscription_invoices_immutable
  before update on subscription_invoices
  for each row
  execute function app.subscription_invoice_is_immutable();

-- A line belongs to its invoice and is written with it. There is no update
-- path at all: the grants above allow insert and select only.
create or replace function app.subscription_invoice_lines_are_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.subscription_invoices i
     where i.id = new.invoice_id and i.status <> 'issued'
  ) then
    raise exception 'Lines cannot be added to an invoice that is paid or void.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger subscription_invoice_lines_final
  before insert on subscription_invoice_lines
  for each row
  execute function app.subscription_invoice_lines_are_final();

grant execute on function app.platform_biller() to propertyos_app, propertyos_worker;

select app.assert_table_privileges();
