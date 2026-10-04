-- 0015_mfa_assurance.sql
-- Multi-factor authentication enforcement.
--
-- The blueprint requires MFA for Spike administrators and finance approvers.
-- Enforcing that in the application only would mean a direct database path, or a
-- forgotten check in one command, silently bypasses it. So the assurance level
-- is made part of the PERMISSION RESOLUTION itself: a role flagged
-- `requires_mfa` simply does not grant its permissions unless the session was
-- authenticated with a second factor.
--
-- The level is read from the JWT, using Supabase's `aal` claim convention
-- (aal1 = password only, aal2 = second factor verified). The local development
-- auth provider sets the same claim after verifying a TOTP code, so the rule is
-- identical in both environments and is covered by tests.

create or replace function app.session_assurance_level()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.aal', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal',
    'aal1'
  );
$$;

comment on function app.session_assurance_level() is
  'aal1 = single factor, aal2 = second factor verified. Defaults to aal1 so a missing claim is treated as the WEAKER state, never the stronger one.';

-- Permission resolution, now assurance-aware.
--
-- A permission is granted when the caller holds it through at least one role
-- that is EITHER not MFA-gated, or is MFA-gated and the session has aal2. An
-- organisation administrator signed in without a second factor therefore holds
-- none of their elevated permissions until they complete it.
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
    join public.roles r on r.key = mr.role_key
    join public.role_permissions rp on rp.role_key = mr.role_key
    where m.organisation_id = p_org
      and m.auth_user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = p_permission
      and (r.requires_mfa = false or app.session_assurance_level() = 'aal2')
  );
$$;

-- Reports whether a permission is held ONLY through an MFA-gated role, so the
-- interface can say "complete your second factor to do this" rather than the
-- misleading "you do not have access".
create or replace function app.permission_needs_mfa(p_org uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.roles r on r.key = mr.role_key
      join public.role_permissions rp on rp.role_key = mr.role_key
      where m.organisation_id = p_org
        and m.auth_user_id = auth.uid()
        and m.status = 'active'
        and rp.permission_key = p_permission
        and r.requires_mfa
    )
    and not app.has_permission(p_org, p_permission);
$$;

-- Platform operator status is likewise MFA-gated: the Spike console is the most
-- privileged surface in the product.
create or replace function app.is_platform_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.auth_user_id = auth.uid()
      and p.is_platform_operator
      and app.session_assurance_level() = 'aal2'
  );
$$;

grant execute on function app.session_assurance_level(), app.permission_needs_mfa(uuid, text)
  to propertyos_app, propertyos_worker;

-- Credential material for the local development auth provider. On Supabase this
-- table stays empty and Supabase Auth owns enrolment.
create table auth_mfa_factors (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null references auth.users (id) on delete cascade,
  factor_type   text not null default 'totp' check (factor_type in ('totp')),
  -- Base32 TOTP secret. Never leaves the server and is never written to logs or
  -- the audit trail.
  secret        text not null,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (auth_user_id, factor_type)
);

-- Replay protection: a TOTP code is valid for one use, never twice.
create table auth_mfa_used_codes (
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  time_step    bigint not null,
  used_at      timestamptz not null default now(),
  primary key (auth_user_id, time_step)
);

alter table auth_mfa_factors enable row level security;
alter table auth_mfa_used_codes enable row level security;
-- No application policy at all: these are reachable only by the pre-session
-- authentication path, which runs on its own narrowly scoped connection.
create policy auth_mfa_factors_none on auth_mfa_factors for select using (false);
create policy auth_mfa_used_codes_none on auth_mfa_used_codes for select using (false);

revoke all on auth_mfa_factors, auth_mfa_used_codes from propertyos_app, propertyos_worker;

-- Sign-in attempt log, for rate limiting and for seeing a credential-stuffing
-- attempt. Stores no password material and hashes the client address.
create table auth_attempts (
  id            bigserial primary key,
  email         citext,
  ip_hash       text,
  outcome       text not null check (outcome in ('success', 'bad_credentials', 'mfa_required', 'mfa_failed', 'rate_limited')),
  attempted_at  timestamptz not null default now()
);

create index auth_attempts_email_idx on auth_attempts (email, attempted_at desc);
create index auth_attempts_ip_idx on auth_attempts (ip_hash, attempted_at desc);

alter table auth_attempts enable row level security;
create policy auth_attempts_none on auth_attempts for select using (false);
revoke all on auth_attempts from propertyos_app, propertyos_worker;
