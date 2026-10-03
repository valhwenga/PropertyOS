-- 0001_foundation.sql
-- Extensions, auth compatibility shim, application roles, and the identity/access core.
--
-- This migration is written to run identically against a managed Supabase project
-- (where the `auth` schema and `auth.uid()` already exist) and against a plain
-- PostgreSQL 16 cluster used for local development and automated tests. Every
-- object that Supabase already provides is created defensively.

create extension if not exists pgcrypto;      -- gen_random_uuid(), digest()
create extension if not exists btree_gist;    -- exclusion constraints mixing = and &&
create extension if not exists citext;        -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Auth compatibility shim
-- ---------------------------------------------------------------------------
-- Supabase owns `auth.users` and `auth.uid()`. When this schema runs on a plain
-- cluster we create an equivalent so that every Row Level Security policy below
-- is byte-for-byte the same in both environments. `auth.uid()` always resolves
-- the caller from the verified JWT claims injected by the connection layer; it
-- never reads anything the browser can set directly.

create schema if not exists auth;

create table if not exists auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         citext unique,
  -- Only populated by the local development credential provider. On Supabase
  -- this column stays null and Supabase Auth owns the credential material.
  password_hash text,
  created_at    timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

-- ---------------------------------------------------------------------------
-- Application schema and database roles
-- ---------------------------------------------------------------------------
create schema if not exists app;

do $$
begin
  -- The role every request-scoped connection uses. It is NOT a superuser and is
  -- NOT the table owner, so Row Level Security is always enforced against it.
  if not exists (select 1 from pg_roles where rolname = 'propertyos_app') then
    create role propertyos_app nologin;
  end if;
  -- The worker role. Still RLS-enforced; it derives organisation scope from the
  -- durable job row it claimed, never from request input.
  if not exists (select 1 from pg_roles where rolname = 'propertyos_worker') then
    create role propertyos_worker nologin;
  end if;
end
$$;

grant usage on schema public, app, auth to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- Shared domain types
-- ---------------------------------------------------------------------------
create type app.organisation_status as enum ('trial', 'active', 'suspended', 'closed');
create type app.membership_status   as enum ('invited', 'active', 'suspended', 'revoked');
create type app.scope_type          as enum ('organisation', 'portfolio', 'property');

-- ---------------------------------------------------------------------------
-- Customer platform
-- ---------------------------------------------------------------------------
create table organisations (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(btrim(name)) between 2 and 200),
  slug            citext not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  status          app.organisation_status not null default 'trial',
  -- Stored explicitly so expansion beyond South Africa never requires a migration
  -- of implicit assumptions. Launch defaults are applied by the application.
  country_code    char(2) not null,
  currency_code   char(3) not null,
  time_zone       text    not null,
  -- Phase 1 supports one operating legal entity per organisation, but the
  -- boundary is explicit in every financial row from the start.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint organisations_currency_upper check (currency_code = upper(currency_code)),
  constraint organisations_country_upper  check (country_code = upper(country_code))
);

comment on column organisations.currency_code is
  'ISO 4217. Financial totals are never combined across currencies without an explicit, reviewed exchange rate policy.';

create table plans (
  key               text primary key,
  name              text not null,
  included_units    integer not null check (included_units >= 0),
  monthly_price_minor bigint not null check (monthly_price_minor >= 0),
  currency_code     char(3) not null,
  additional_unit_price_minor bigint not null default 0 check (additional_unit_price_minor >= 0),
  is_active         boolean not null default true
);

create table subscriptions (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null unique references organisations (id) on delete cascade,
  plan_key        text not null references plans (key),
  status          text not null default 'trialing'
                  check (status in ('trialing','active','past_due','paused','cancelled')),
  current_period_start date,
  current_period_end   date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table subscriptions is
  'Spike SaaS subscription billing. Deliberately separate from rent money flows: no table here ever posts to a customer financial book.';

create table plan_entitlements (
  plan_key   text not null references plans (key) on delete cascade,
  feature    text not null,
  limit_value integer,
  primary key (plan_key, feature)
);

-- ---------------------------------------------------------------------------
-- Access: profiles, memberships, roles, scopes
-- ---------------------------------------------------------------------------
create table user_profiles (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  full_name    text not null check (length(btrim(full_name)) between 1 and 200),
  email        citext not null,
  phone        text,
  -- Spike staff flag. Being a platform operator grants no customer data access
  -- on its own; access additionally requires an authorised support session.
  is_platform_operator boolean not null default false,
  mfa_enrolled boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table roles (
  key         text primary key,
  name        text not null,
  description text not null,
  -- Elevated roles must carry MFA before they can be granted in production.
  requires_mfa boolean not null default false
);

create table permissions (
  key         text primary key,
  description text not null
);

create table role_permissions (
  role_key       text not null references roles (key) on delete cascade,
  permission_key text not null references permissions (key) on delete cascade,
  primary key (role_key, permission_key)
);

create table memberships (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  auth_user_id    uuid not null references auth.users (id) on delete cascade,
  status          app.membership_status not null default 'invited',
  invited_email   citext,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, auth_user_id),
  -- Required so that every organisation-owned table can declare a composite
  -- foreign key that pins the organisation, making cross-organisation
  -- references structurally impossible rather than merely policy-blocked.
  unique (organisation_id, id)
);

create index memberships_auth_user_idx on memberships (auth_user_id) where status = 'active';
create index memberships_org_idx on memberships (organisation_id);

create table membership_roles (
  membership_id uuid not null references memberships (id) on delete cascade,
  role_key      text not null references roles (key) on delete restrict,
  granted_at    timestamptz not null default now(),
  granted_by    uuid references auth.users (id),
  primary key (membership_id, role_key)
);

-- Resource scope. A membership with no row here has no property access at all.
-- An 'organisation' scope row grants every property in the organisation.
create table property_assignments (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  membership_id   uuid not null,
  scope_type      app.scope_type not null,
  portfolio_id    uuid,
  property_id     uuid,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, membership_id)
    references memberships (organisation_id, id) on delete cascade,
  constraint property_assignments_shape check (
    (scope_type = 'organisation' and portfolio_id is null and property_id is null) or
    (scope_type = 'portfolio'    and portfolio_id is not null and property_id is null) or
    (scope_type = 'property'     and property_id is not null and portfolio_id is null)
  )
);

create index property_assignments_membership_idx on property_assignments (membership_id);

-- ---------------------------------------------------------------------------
-- Spike support access
-- ---------------------------------------------------------------------------
-- A platform operator reaches customer content only through a time limited,
-- organisation authorised, audited session. There is no permanent all-customer
-- role.
create table support_sessions (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references organisations (id) on delete cascade,
  operator_user_id uuid not null references auth.users (id) on delete cascade,
  reason           text not null check (length(btrim(reason)) >= 10),
  authorised_by    uuid references auth.users (id),
  granted_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  read_only        boolean not null default true,
  constraint support_sessions_window check (expires_at > granted_at)
);

create index support_sessions_active_idx
  on support_sessions (operator_user_id, organisation_id, expires_at);

-- ---------------------------------------------------------------------------
-- Scope resolution helpers
-- ---------------------------------------------------------------------------
-- These run as SECURITY DEFINER with a pinned empty search_path so that the
-- access tables can themselves carry RLS without the policies recursing. Each
-- one answers a single narrow question about the *current authenticated user*;
-- none of them accepts a caller-supplied identity.

create or replace function app.current_membership(p_org uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.memberships m
  where m.organisation_id = p_org
    and m.auth_user_id = auth.uid()
    and m.status = 'active';
$$;

create or replace function app.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organisation_id = p_org
      and m.auth_user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function app.has_support_access(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.support_sessions s
    join public.user_profiles p on p.auth_user_id = s.operator_user_id
    where s.organisation_id = p_org
      and s.operator_user_id = auth.uid()
      and p.is_platform_operator
      and s.revoked_at is null
      and s.expires_at > now()
  );
$$;

-- True when the current user holds the named permission in the organisation.
-- Permissions are always resolved against *current* membership and role grants,
-- never against long lived claims baked into a token.
create or replace function app.has_permission(p_org uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.membership_roles mr on mr.membership_id = m.id
    join public.role_permissions rp on rp.role_key = mr.role_key
    where m.organisation_id = p_org
      and m.auth_user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = p_permission
  );
$$;

grant execute on function auth.uid() to propertyos_app, propertyos_worker;
grant execute on function app.current_membership(uuid), app.is_org_member(uuid),
  app.has_support_access(uuid), app.has_permission(uuid, text)
  to propertyos_app, propertyos_worker;
