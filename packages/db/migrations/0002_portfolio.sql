-- 0002_portfolio.sql
-- Portfolios, properties, optional buildings, rentable units and availability.
--
-- Modelling rules enforced here:
--   * A building is optional. A standalone house is one property with one unit
--     and no building row.
--   * Unit codes are unique within a property.
--   * Commercial availability (out of service periods) is separate from physical
--     occupancy, which lives with the lease.

create type app.property_type as enum
  ('house', 'cottage', 'apartment', 'apartment_block', 'townhouse', 'other');
create type app.property_status as enum ('active', 'archived');
create type app.unit_status as enum ('active', 'archived');
create type app.unit_rentable_type as enum ('whole_property', 'apartment', 'cottage', 'room', 'other');

create table portfolios (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 160),
  code            text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, code)
);

create table properties (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  portfolio_id    uuid not null,
  name            text not null check (length(btrim(name)) between 1 and 200),
  code            text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$'),
  property_type   app.property_type not null,
  status          app.property_status not null default 'active',
  address_line1   text not null,
  address_line2   text,
  suburb          text,
  city            text not null,
  province        text,
  postal_code     text,
  country_code    char(2) not null,
  -- Optional acquisition data. Yield metrics stay hidden while these are null
  -- rather than being computed from an assumed denominator.
  purchase_price_minor bigint check (purchase_price_minor >= 0),
  purchase_date        date,
  municipal_account_ref text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, code),
  -- Composite foreign key: a property can only sit in a portfolio owned by the
  -- same organisation. Enforced by the database, not by application code.
  foreign key (organisation_id, portfolio_id)
    references portfolios (organisation_id, id) on delete restrict
);

create index properties_org_portfolio_idx on properties (organisation_id, portfolio_id);
create index properties_org_status_idx on properties (organisation_id, status);

create table buildings (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  property_id     uuid not null,
  name            text not null check (length(btrim(name)) between 1 and 160),
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete cascade
);

create table units (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  property_id     uuid not null,
  building_id     uuid,
  code            text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,23}$'),
  description     text,
  rentable_type   app.unit_rentable_type not null default 'apartment',
  bedrooms        smallint check (bedrooms between 0 and 50),
  bathrooms       numeric(3,1) check (bathrooms >= 0 and bathrooms <= 50),
  floor           text,
  floor_area_sqm  numeric(10,2) check (floor_area_sqm > 0),
  -- Advertised rent is a marketing figure and is deliberately separate from the
  -- contracted rent held on the lease.
  advertised_rent_minor bigint check (advertised_rent_minor >= 0),
  status          app.unit_status not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  -- "Duplicate unit codes within one property must fail."
  unique (organisation_id, property_id, code),
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete cascade,
  foreign key (organisation_id, building_id)
    references buildings (organisation_id, id) on delete set null
);

create index units_org_property_idx on units (organisation_id, property_id);

-- Out of service periods give occupancy reporting a stable denominator.
create table unit_availability (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  unit_id         uuid not null,
  period          daterange not null,
  reason          text not null check (length(btrim(reason)) >= 3),
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  foreign key (organisation_id, unit_id)
    references units (organisation_id, id) on delete cascade,
  -- A unit cannot be out of service twice over the same days.
  exclude using gist (unit_id with =, period with &&)
);

-- ---------------------------------------------------------------------------
-- Ownership (kept separate from organisation membership)
-- ---------------------------------------------------------------------------
create table parties (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  party_type      text not null check (party_type in ('person', 'legal_entity')),
  display_name    text not null check (length(btrim(display_name)) between 1 and 200),
  registration_number text,
  email           citext,
  phone           text,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id)
);

create table property_ownerships (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  property_id     uuid not null,
  party_id        uuid not null,
  -- Effective dated so historical reports retain their original context.
  effective_period daterange not null,
  share_percent   numeric(7,4) not null check (share_percent > 0 and share_percent <= 100),
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete cascade,
  foreign key (organisation_id, party_id)
    references parties (organisation_id, id) on delete restrict
);

create index property_ownerships_property_idx on property_ownerships (organisation_id, property_id);

-- An owner viewer only ever sees properties linked to the parties they own.
create table owner_links (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  party_id        uuid not null,
  auth_user_id    uuid not null references auth.users (id) on delete cascade,
  created_at      timestamptz not null default now(),
  unique (organisation_id, party_id, auth_user_id),
  foreign key (organisation_id, party_id)
    references parties (organisation_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Property scope resolution
-- ---------------------------------------------------------------------------
-- Answers: may the current user act on this property? An organisation scoped
-- assignment covers everything; otherwise the portfolio or the property must be
-- assigned explicitly. A property manager with no matching assignment is denied
-- even inside their own organisation.
create or replace function app.can_access_property(p_org uuid, p_property uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.property_assignments pa on pa.membership_id = m.id
    left join public.properties prop
      on prop.id = p_property and prop.organisation_id = p_org
    where m.organisation_id = p_org
      and m.auth_user_id = auth.uid()
      and m.status = 'active'
      and (
            pa.scope_type = 'organisation'
        or (pa.scope_type = 'property'  and pa.property_id = p_property)
        or (pa.scope_type = 'portfolio' and pa.portfolio_id = prop.portfolio_id)
      )
  );
$$;

grant execute on function app.can_access_property(uuid, uuid)
  to propertyos_app, propertyos_worker;
