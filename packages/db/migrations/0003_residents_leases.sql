-- 0003_residents_leases.sql
-- Resident profiles, portal access, lease contracts, joint lease parties and
-- actual occupancy.
--
-- Modelling rules enforced here:
--   * A resident can exist with no login. Portal access is a separate, revocable
--     link, verified against the lease before it is issued.
--   * A person can appear in several leases.
--   * Joint lease parties never multiply the rent receivable: the receivable
--     belongs to the lease account, not to each party.
--   * Lease status is separate from actual occupancy. An expired lease can still
--     carry arrears and a holdover occupant.
--   * Overlapping exclusive leases on one unit are rejected by the database.

create type app.resident_status as enum ('prospect', 'active', 'former', 'archived');
create type app.lease_status as enum
  ('draft', 'awaiting_execution', 'active', 'notice_given', 'expired', 'closed', 'cancelled');
create type app.lease_party_role as enum ('primary_resident', 'co_lessee', 'guarantor', 'occupant');
create type app.portal_link_status as enum ('invited', 'active', 'revoked', 'expired');

create table resident_profiles (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  first_name      text not null check (length(btrim(first_name)) between 1 and 100),
  last_name       text not null check (length(btrim(last_name)) between 1 and 100),
  email           citext,
  phone           text,
  -- National identity numbers are collected for a defined purpose only and are
  -- masked in list views. Read access is gated by a separate permission
  -- (resident.identity.read) rather than ordinary profile access.
  identity_number_last4 text check (identity_number_last4 ~ '^[0-9]{4}$'),
  identity_document_id  uuid,
  date_of_birth   date,
  status          app.resident_status not null default 'prospect',
  communication_preference text not null default 'email'
                  check (communication_preference in ('email', 'in_app', 'none')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id)
);

create index resident_profiles_org_name_idx
  on resident_profiles (organisation_id, last_name, first_name);
create index resident_profiles_org_email_idx on resident_profiles (organisation_id, email);

create table emergency_contacts (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  resident_id     uuid not null,
  name            text not null,
  relationship    text,
  phone           text not null,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, resident_id)
    references resident_profiles (organisation_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Leases
-- ---------------------------------------------------------------------------
create table leases (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  property_id     uuid not null,
  unit_id         uuid not null,
  reference       text not null check (length(btrim(reference)) between 1 and 40),
  status          app.lease_status not null default 'draft',
  -- Contract dates. end_date null means open ended / month to month.
  start_date      date not null,
  end_date        date,
  -- Contracted rent for this version of the contract. A renewal creates a linked
  -- successor lease; it never overwrites these figures.
  rent_minor      bigint not null check (rent_minor >= 0),
  currency_code   char(3) not null,
  billing_day     smallint not null default 1 check (billing_day between 1 and 31),
  -- Proration convention is stored per lease so a change of policy cannot
  -- silently restate historical charges.
  proration_method text not null default 'actual_days'
                  check (proration_method in ('actual_days', 'none')),
  deposit_required_minor bigint not null default 0 check (deposit_required_minor >= 0),
  escalation_percent numeric(6,3) check (escalation_percent >= 0),
  escalation_month_interval smallint check (escalation_month_interval between 1 and 60),
  notice_days     smallint check (notice_days between 0 and 365),
  -- Renewal chain. A successor points at the lease it replaces.
  supersedes_lease_id uuid,
  executed_document_id uuid,
  executed_at     timestamptz,
  -- Recorded when a lease is activated without an attached executed contract.
  execution_exception_reason text,
  activated_at    timestamptz,
  activated_by    uuid references auth.users (id),
  closed_at       timestamptz,
  cancellation_reason text,
  dispute_flag    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, reference),
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete restrict,
  foreign key (organisation_id, unit_id)
    references units (organisation_id, id) on delete restrict,
  foreign key (organisation_id, supersedes_lease_id)
    references leases (organisation_id, id) on delete set null,
  constraint leases_date_order check (end_date is null or end_date >= start_date),
  -- A lease may only reach a reserving state with an executed contract or an
  -- explicitly recorded exception, and an activation stamp.
  constraint leases_activation_evidence check (
    status in ('draft', 'awaiting_execution', 'cancelled')
    or activated_at is not null
  ),
  constraint leases_execution_evidence check (
    status in ('draft', 'awaiting_execution', 'cancelled')
    or executed_document_id is not null
    or execution_exception_reason is not null
  ),
  -- The lease currency must match its organisation's currency in Phase 1. The
  -- check lives in the posting path and in the application; recorded here as a
  -- generated column would require a cross-table reference.
  constraint leases_currency_upper check (currency_code = upper(currency_code))
);

create index leases_org_unit_idx on leases (organisation_id, unit_id);
create index leases_org_property_idx on leases (organisation_id, property_id);
create index leases_org_status_end_idx on leases (organisation_id, status, end_date);

-- The reserving interval. Generated so it can never drift from the dates, and
-- NULL for states that do not reserve a unit (draft, cancelled, closed), which
-- keeps those rows out of the exclusion constraint entirely.
alter table leases
  add column reserved_period daterange
  generated always as (
    case
      when status in ('awaiting_execution', 'active', 'notice_given', 'expired')
        then daterange(start_date, end_date, '[]')
      else null
    end
  ) stored;

comment on column leases.reserved_period is
  'Drafts and cancelled leases deliberately do not reserve a unit, so two operators may draft against the same unit; only one can reach an executed/reserving state.';

-- "Two operators activate overlapping exclusive leases: one succeeds; the
-- conflicting operation fails." Enforced by the database under concurrency.
alter table leases
  add constraint leases_no_overlapping_reservation
  exclude using gist (unit_id with =, reserved_period with &&)
  where (reserved_period is not null);

create table lease_parties (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  lease_id        uuid not null,
  resident_id     uuid not null,
  role            app.lease_party_role not null,
  -- Whether this party may see the shared lease financials. Guarantors and
  -- household occupants do not receive this by default.
  can_view_financials boolean not null default false,
  joined_on       date,
  removed_on      date,
  created_at      timestamptz not null default now(),
  unique (organisation_id, lease_id, resident_id, role),
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete cascade,
  foreign key (organisation_id, resident_id)
    references resident_profiles (organisation_id, id) on delete restrict
);

create index lease_parties_lease_idx on lease_parties (organisation_id, lease_id);
create index lease_parties_resident_idx on lease_parties (organisation_id, resident_id);

-- Exactly one primary resident per lease.
create unique index lease_parties_one_primary
  on lease_parties (lease_id)
  where role = 'primary_resident' and removed_on is null;

-- Actual occupancy, tracked independently of lease status so a holdover
-- occupant after lease expiry is visible and reportable.
create table occupancy_intervals (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  unit_id         uuid not null,
  lease_id        uuid,
  period          daterange not null,
  move_in_at      timestamptz,
  move_out_at     timestamptz,
  is_holdover     boolean not null default false,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, unit_id)
    references units (organisation_id, id) on delete cascade,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete set null,
  -- A unit is physically occupied by one household at a time.
  exclude using gist (unit_id with =, period with &&)
);

create index occupancy_org_unit_idx on occupancy_intervals (organisation_id, unit_id);

-- ---------------------------------------------------------------------------
-- Portal access
-- ---------------------------------------------------------------------------
-- A portal link is the only thing that connects a login to a lease. It is issued
-- after the operator reviews the lease and recipient, and it is revocable.
create table portal_links (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  resident_id     uuid not null,
  lease_id        uuid not null,
  auth_user_id    uuid references auth.users (id) on delete set null,
  invited_email   citext not null,
  -- Only the hash of the invitation token is stored, so a database read cannot
  -- be replayed as an invitation.
  invite_token_hash bytea,
  status          app.portal_link_status not null default 'invited',
  invited_at      timestamptz not null default now(),
  invited_by      uuid references auth.users (id),
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  expires_at      timestamptz not null,
  unique (organisation_id, lease_id, resident_id),
  foreign key (organisation_id, resident_id)
    references resident_profiles (organisation_id, id) on delete cascade,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete cascade
);

create index portal_links_user_idx on portal_links (auth_user_id) where status = 'active';
create unique index portal_links_token_idx on portal_links (invite_token_hash)
  where invite_token_hash is not null;

-- ---------------------------------------------------------------------------
-- Resident scope resolution
-- ---------------------------------------------------------------------------
-- A resident sees exactly the leases they hold an active portal link for.
-- Changing a lease ID in a request therefore cannot reach another lease.
create or replace function app.resident_lease_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pl.lease_id
  from public.portal_links pl
  where pl.auth_user_id = auth.uid()
    and pl.status = 'active'
    and pl.revoked_at is null
    and pl.expires_at > now();
$$;

create or replace function app.can_access_lease_as_resident(p_lease uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.resident_lease_ids() l where l = p_lease);
$$;

grant execute on function app.resident_lease_ids(), app.can_access_lease_as_resident(uuid)
  to propertyos_app, propertyos_worker;
