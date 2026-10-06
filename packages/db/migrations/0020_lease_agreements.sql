-- 0020_lease_agreements.sql
-- Lease agreement templates, and generating a filled agreement from one.
--
-- The product ships the ENGINE, never the wording. A lease is a legal document
-- whose text belongs to whoever drafted it: the TPN LeasePack carries
-- "© TPN Group (Pty) Limited, drafted by SSLR Incorporated" on every page, and a
-- customer's subscription licenses that customer, not this software, to use it.
-- So the clause text lives in each organisation's own rows, uploaded by them,
-- and `source_note` records where they say it came from. Nothing here is
-- seeded with anyone's drafting.
--
-- Two layouts, because real agreements differ in where the variables sit:
--   schedule — a numbered schedule holds every variable and the clauses refer
--              to it by item number (the TPN shape);
--   inline   — values are substituted inside the prose itself (the common
--              "Deed of Lease" shape).
-- Both are served by the same named placeholders, so the distinction is only
-- about how the document reads.

create type app.lease_template_layout as enum ('schedule', 'inline');
create type app.lease_template_status as enum ('draft', 'published', 'archived');
create type app.lease_payment_method as enum ('debit_order', 'bank_deposit', 'eft', 'other');

create table lease_templates (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  name            text not null,
  layout          app.lease_template_layout not null,
  -- What the organisation states about the provenance of this wording. Recorded
  -- rather than assumed: the platform does not own these words and must not
  -- imply it may redistribute them.
  source_note     text,
  status          app.lease_template_status not null default 'draft',
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  updated_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, name),
  constraint lease_templates_name_present check (length(btrim(name)) >= 3)
);

create index lease_templates_org_idx on lease_templates (organisation_id, status);

-- A published version is immutable. An agreement generated months ago must stay
-- reproducible from the exact words that produced it, so edits create a new
-- version instead of changing history.
create table lease_template_versions (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null,
  template_id     uuid not null,
  version         integer not null,
  -- The agreement text, carrying {{placeholders}} from the merge catalogue.
  body            text not null,
  published_at    timestamptz,
  published_by    uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, template_id, version),
  foreign key (organisation_id, template_id)
    references lease_templates (organisation_id, id) on delete cascade,
  constraint lease_template_versions_version_positive check (version >= 1),
  constraint lease_template_versions_body_present check (length(btrim(body)) >= 20)
);

create index lease_template_versions_template_idx
  on lease_template_versions (template_id, version desc);

create or replace function app.block_published_template_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.published_at is not null then
    if new.body is distinct from old.body or new.version is distinct from old.version then
      raise exception
        'Lease template version % is published and cannot be edited. Create a new version.',
        old.version
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger lease_template_versions_immutable
  before update on lease_template_versions
  for each row execute function app.block_published_template_mutation();

-- The landlord's own particulars. A lease names the letting party, its
-- registration or identity number and its addresses; none of that belonged
-- anywhere until now.
create table organisation_profiles (
  organisation_id     uuid primary key references organisations (id) on delete cascade,
  legal_name          text,
  trading_name        text,
  registration_number text,
  vat_number          text,
  -- A natural-person landlord's identity number is personal data, so it is
  -- sealed exactly like a resident's. See the note on resident_profiles below.
  identity_number_cipher bytea,
  identity_number_last4  text,
  physical_address    text,
  postal_address      text,
  phone               text,
  email               citext,
  next_of_kin_name    text,
  next_of_kin_phone   text,
  -- Where a managing agent or property practitioner is involved.
  agent_name          text,
  agent_contact       text,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id),
  constraint organisation_profiles_id_last4 check (
    identity_number_last4 is null or identity_number_last4 ~ '^[0-9]{4}$'
  )
);

-- Full identity and bank numbers.
--
-- Until now the schema deliberately kept only the last four digits, which is
-- right for a screen but cannot produce a signable lease. These columns hold
-- the full value sealed with AES-256-GCM by the application; the key lives in
-- the environment and never in the database, so a database copy alone does not
-- disclose them. The last-four columns stay, because every screen that merely
-- identifies an account should keep reading those and never open the sealed
-- value.
alter table resident_profiles
  add column identity_number_cipher bytea;

comment on column resident_profiles.identity_number_cipher is
  'AES-256-GCM sealed identity number. Opened only to generate a lease agreement, through a permission check that writes an audit event. Never select this into a list or a log.';

alter table bank_accounts
  add column account_number_cipher bytea;

comment on column bank_accounts.account_number_cipher is
  'AES-256-GCM sealed full account number. account_number_last4 remains the display value.';

-- The schedule values an agreement needs that no other table carries.
--
-- Typed where the value is money or a count, because a lease that says
-- "R1 500.00" must mean 150000 minor units and nothing else. `extra` carries
-- whatever a particular template asks for beyond this.
create table lease_agreement_terms (
  lease_id                  uuid not null,
  organisation_id           uuid not null,
  parking_bays              text,
  max_occupants             smallint,
  permanent_vehicles        smallint,
  smoking_allowed           boolean,
  pets_allowed              boolean,
  pets_detail               text,
  admin_fee_minor           bigint,
  credit_check_fee_minor    bigint,
  inspection_fee_minor      bigint,
  -- Interest charged on arrear rental, as a monthly percentage with an annual
  -- ceiling, which is how both supplied agreements express it.
  arrear_interest_monthly_percent numeric(5,2),
  arrear_interest_annual_cap_percent numeric(5,2),
  renewal_option_months     smallint,
  renewal_notice_months     smallint,
  cancellation_penalty_months numeric(4,2),
  sales_commission_percent  numeric(5,2),
  payment_method            app.lease_payment_method,
  place_of_payment          text,
  jurisdiction_court        text,
  key_return_at             date,
  surcharge_detail          text,
  special_conditions        text,
  extra                     jsonb not null default '{}'::jsonb,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users (id),
  primary key (lease_id),
  unique (organisation_id, lease_id),
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete cascade,
  constraint lease_agreement_terms_fees_non_negative check (
    coalesce(admin_fee_minor, 0) >= 0
    and coalesce(credit_check_fee_minor, 0) >= 0
    and coalesce(inspection_fee_minor, 0) >= 0
  ),
  constraint lease_agreement_terms_counts_sane check (
    coalesce(max_occupants, 0) >= 0 and coalesce(permanent_vehicles, 0) >= 0
  )
);

-- What was generated, from which words, for which lease.
--
-- A generated agreement is a DRAFT. It is not an executed lease: leases already
-- carry executed_document_id and executed_at for that, and nothing here sets
-- them. The distinction matters because a produced PDF is easy to mistake for a
-- concluded agreement.
create table lease_agreement_generations (
  id                  uuid not null default gen_random_uuid(),
  organisation_id     uuid not null,
  lease_id            uuid not null,
  template_version_id uuid not null,
  document_id         uuid not null,
  -- The merged values, REDACTED: identity and account numbers appear here as
  -- their masked form only. The full values exist in the generated PDF, which
  -- lives in private storage behind the same authorisation as every other
  -- document. A snapshot table is not a second place for personal data to leak.
  field_values        jsonb not null,
  -- Placeholders the template asked for that had no value. Recorded so the
  -- agreement is never quietly issued with blanks nobody noticed.
  missing_fields      text[] not null default '{}',
  generated_at        timestamptz not null default now(),
  generated_by        uuid references auth.users (id),
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete cascade,
  foreign key (organisation_id, template_version_id)
    references lease_template_versions (organisation_id, id) on delete restrict,
  foreign key (organisation_id, document_id)
    references documents (organisation_id, id) on delete restrict
);

create index lease_agreement_generations_lease_idx
  on lease_agreement_generations (lease_id, generated_at desc);

/* ------------------------------------------------------------------ RLS */

alter table lease_templates enable row level security;
alter table lease_template_versions enable row level security;
alter table organisation_profiles enable row level security;
alter table lease_agreement_terms enable row level security;
alter table lease_agreement_generations enable row level security;

create policy lease_templates_select on lease_templates
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );
create policy lease_templates_write on lease_templates
  for all
  using (app.has_permission(organisation_id, 'lease.template.manage'))
  with check (app.has_permission(organisation_id, 'lease.template.manage'));

create policy lease_template_versions_select on lease_template_versions
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );
create policy lease_template_versions_write on lease_template_versions
  for all
  using (app.has_permission(organisation_id, 'lease.template.manage'))
  with check (app.has_permission(organisation_id, 'lease.template.manage'));

create policy organisation_profiles_select on organisation_profiles
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );
create policy organisation_profiles_write on organisation_profiles
  for all
  using (app.has_permission(organisation_id, 'organisation.settings.manage'))
  with check (app.has_permission(organisation_id, 'organisation.settings.manage'));

create policy lease_agreement_terms_select on lease_agreement_terms
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );
create policy lease_agreement_terms_write on lease_agreement_terms
  for all
  using (app.has_permission(organisation_id, 'lease.create'))
  with check (app.has_permission(organisation_id, 'lease.create'));

create policy lease_agreement_generations_select on lease_agreement_generations
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );
create policy lease_agreement_generations_insert on lease_agreement_generations
  for insert with check (app.has_permission(organisation_id, 'lease.agreement.generate'));

/* ----------------------------------------------------------- privileges */

grant select, insert, update, delete on
  lease_templates, lease_template_versions, organisation_profiles,
  lease_agreement_terms, lease_agreement_generations
  to propertyos_app, propertyos_worker;

/* ---------------------------------------------------------- permissions */

insert into permissions (key, description) values
  ('lease.template.manage', 'Create and publish lease agreement templates'),
  ('lease.agreement.generate', 'Generate a lease agreement from a template')
on conflict (key) do nothing;

-- Generating an agreement opens sealed identity and bank numbers, so it sits
-- with the roles that already carry responsibility for the lease itself rather
-- than with everyone who can read one.
insert into role_permissions (role_key, permission_key)
select r.key, p.key
from roles r
cross join (values ('lease.template.manage'), ('lease.agreement.generate')) as p(key)
where r.key in ('org_admin', 'portfolio_manager')
on conflict do nothing;

select app.assert_table_privileges();
