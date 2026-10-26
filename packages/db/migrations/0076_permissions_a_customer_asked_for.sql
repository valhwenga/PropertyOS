-- ---------------------------------------------------------------------------
-- 0076  Permissions one customer asked for
-- ---------------------------------------------------------------------------
--
-- `roles`, `permissions` and `role_permissions` have been reference data since
-- the first migration: seeded by migrations, written by nothing, and shown
-- nowhere. Two consequences. Support could not answer "why can't our portfolio
-- manager approve that?" without reading SQL, and a customer who wanted their
-- managers to do one extra thing had to be told no, because the only lever was
-- a migration that would change it for every customer at once.
--
-- The lever this adds is deliberately the smaller one: an extra permission,
-- for one role, in ONE organisation.
--
-- **Grants only, never revokes.** An override can add a permission to a role
-- and cannot take one away. That single rule removes the whole class of
-- accident this feature would otherwise introduce: there is no combination of
-- rows here that can lock a customer out of their own account, strand an
-- organisation with no administrator, or quietly narrow somebody's access
-- between two page loads. What a customer wants taken away they do by not
-- assigning the role, which is theirs to control and always was.
--
-- **An overridden permission always requires a second factor.** MFA is a
-- property of the ROLE in this schema — `roles.requires_mfa`, read by
-- `app.has_permission` — so granting an elevated permission to a role that
-- does not require MFA would hand out the permission without the second
-- factor that everywhere else accompanies it. The override branch below
-- therefore requires aal2 unconditionally. That is stricter than the base
-- path on purpose: a permission somebody asked for by email should not be
-- easier to exercise than one the product shipped.
--
-- **`platform.admin` is never grantable.** It is Spike's own, it belongs to no
-- customer role, and a trigger refuses it rather than trusting the screen.
--
-- Nothing here makes the catalogue readable, because it already is: `roles`,
-- `permissions` and `role_permissions` each carry a `using (true)` policy and
-- a SELECT grant. The first draft of this migration added them on the
-- assumption that reference data with no screen had no policies either, and
-- failed on the duplicate — which is the better outcome of the two.

create table organisation_role_permissions (
  organisation_id uuid not null references organisations (id) on delete cascade,
  role_key        text not null references roles (key) on delete cascade,
  permission_key  text not null references permissions (key) on delete cascade,
  -- Why this customer has it. Not optional: an override with no reason is
  -- unreviewable a year later, which is when somebody asks.
  reason          text not null check (length(btrim(reason)) between 5 and 500),
  granted_by      uuid not null references auth.users (id),
  granted_at      timestamptz not null default now(),
  primary key (organisation_id, role_key, permission_key)
);

create index organisation_role_permissions_org_idx
  on organisation_role_permissions (organisation_id);

comment on table organisation_role_permissions is
  'Extra permissions one customer asked for, on one role. Grants only: '
  'nothing here can take a permission away, so no row can lock a customer '
  'out. An overridden permission always requires a second factor.';

create or replace function app.role_permission_override_is_allowed()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.permission_key = 'platform.admin' then
    raise exception 'platform.admin belongs to Spike and cannot be granted to a customer role.'
      using errcode = 'invalid_parameter_value';
  end if;
  -- An override that duplicates what the role already carries everywhere is
  -- noise: it reads as a decision somebody made for this customer when it was
  -- not, and it would survive a later migration that removed the base grant.
  if exists (
    select 1 from role_permissions
     where role_key = new.role_key and permission_key = new.permission_key
  ) then
    raise exception
      'Every % already has "%" on every account. Nothing needs granting here.',
      new.role_key, new.permission_key
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end;
$$;

create trigger organisation_role_permissions_allowed
  before insert or update on organisation_role_permissions
  for each row execute function app.role_permission_override_is_allowed();

alter table organisation_role_permissions enable row level security;

-- The customer reads their own, and that is not a courtesy: Spike widening
-- what a landlord's own staff may do, with the landlord unable to see it,
-- would be a back door whatever the audit trail said.
create policy organisation_role_permissions_customer_select
  on organisation_role_permissions
  for select
  using (organisation_id in (select app.member_organisation_ids()));

create policy organisation_role_permissions_platform_select
  on organisation_role_permissions
  for select
  using (app.is_platform_operator());

create policy organisation_role_permissions_platform_write
  on organisation_role_permissions
  for all
  using (app.platform_permission('platform.permissions.manage'))
  with check (app.platform_permission('platform.permissions.manage'));

grant select on organisation_role_permissions to propertyos_app, propertyos_worker;
grant insert, delete on organisation_role_permissions to propertyos_app;

-- ---------------------------------------------------------------------------
-- And the condition everything else already reads
-- ---------------------------------------------------------------------------
--
-- The base branch is untouched, character for character, because it is the
-- most security-sensitive expression in the product. The override is a second
-- branch beside it with the stricter MFA rule, in the same shape as the
-- support-session branch added to the command layer in 0074.
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
  )
  or exists (
    -- Granted to this role for this customer only. Always MFA-gated, because
    -- `requires_mfa` describes the role rather than the permission and an
    -- override can put an elevated permission on a role that carries no such
    -- requirement.
    select 1
    from public.memberships m
    join public.membership_roles mr on mr.membership_id = m.id
    join public.organisation_role_permissions orp
      on orp.organisation_id = m.organisation_id
     and orp.role_key = mr.role_key
    where m.organisation_id = p_org
      and m.auth_user_id = auth.uid()
      and m.status = 'active'
      and orp.permission_key = p_permission
      and app.session_assurance_level() = 'aal2'
  );
$$;

comment on function app.has_permission(uuid, text) is
  'Whether the caller holds this permission in this organisation, through a '
  'role they are assigned or through an extra grant this customer asked for. '
  'An extra grant always requires a verified second factor.';

-- ---------------------------------------------------------------------------
-- And the customer can see WHO changed it
-- ---------------------------------------------------------------------------
--
-- `user_profiles_support_operator_select` already lets a customer read the
-- name of a Spike operator who held a support session with them, on the
-- grounds that "somebody at Spike looked at your records" is not an anonymous
-- event. An operator who widened what the customer's own staff may do is the
-- same kind of event and a larger one, and without this the customer's screen
-- can only say "Spike" — which an integration test caught by expecting a name
-- and getting null.
create policy user_profiles_override_grantor_select on user_profiles
  for select
  using (
    is_platform_operator
    and exists (
      select 1 from organisation_role_permissions orp
       where orp.granted_by = user_profiles.auth_user_id
         and orp.organisation_id in (select app.member_organisation_ids())
    )
  );

select app.assert_table_privileges();
