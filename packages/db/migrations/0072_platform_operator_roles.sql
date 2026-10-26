-- ---------------------------------------------------------------------------
-- 0072  Spike's own staff, and what each of them may do
-- ---------------------------------------------------------------------------
--
-- Until now "platform operator" was one boolean on user_profiles. Every
-- operator could do everything the console offers — change any customer's
-- plan, suspend any account, issue Spike's invoices, edit the system lease
-- templates every customer inherits — and the only way to make somebody an
-- operator at all was an UPDATE typed into psql. A product that insists a
-- landlord's own staff hold scoped, named roles cannot run its own staff on a
-- flag.
--
-- So platform authority becomes what customer authority already is: named
-- permissions, collected into roles, granted to a person, resolved on every
-- call. Three decisions worth stating.
--
-- **The boolean stays, and keeps its meaning.** `is_platform_operator` is the
-- door into the console and the condition in `app.is_platform_operator()`,
-- which appears in policies across the schema. Redefining it would be a
-- rewrite of the most security-sensitive function in the product for no gain.
-- It now means "may enter the console"; a role says what you may do once in.
--
-- **Every existing operator is backfilled to platform_admin.** Otherwise this
-- migration locks Spike out of its own product the moment the permission
-- checks land in code. Nothing about today's behaviour changes on deploy; the
-- scoping starts when somebody is given a narrower role.
--
-- **The last administrator cannot be removed.** A console nobody can
-- administer is unrecoverable without database access, so the trigger below
-- refuses the revoke rather than trusting every caller to remember.

-- ---------------------------------------------------------------------------
-- What there is to be allowed
-- ---------------------------------------------------------------------------
create table platform_permissions (
  key         text primary key,
  description text not null
);

insert into platform_permissions (key, description) values
  ('platform.customers.read',      'See customer accounts, usage and health'),
  ('platform.customers.provision', 'Set up customers and decide requests for an account'),
  ('platform.customers.plan',      'Change a customer''s plan and allowances'),
  ('platform.customers.status',    'Suspend, reinstate or close a customer account'),
  ('platform.support.request',     'Request and open support sessions'),
  ('platform.billing.manage',      'Spike''s billing identity, billing runs and invoices'),
  ('platform.templates.manage',    'The system lease templates every customer inherits'),
  ('platform.operators.manage',    'Add and remove Spike operators and their roles'),
  ('platform.permissions.manage',  'Change what each customer-facing role may do'),
  ('platform.config.manage',       'Platform-wide configuration'),
  ('platform.audit.read',          'Read the platform audit trail');

-- ---------------------------------------------------------------------------
-- Collected into roles
-- ---------------------------------------------------------------------------
create table platform_roles (
  key         text primary key,
  name        text not null,
  description text not null,
  -- An administrator is the role that can grant roles. Flagged so the console
  -- and the trigger below agree on which one must always exist.
  is_admin    boolean not null default false
);

insert into platform_roles (key, name, description, is_admin) values
  ('platform_admin',   'Platform administrator',
   'Everything the console offers, including who else is an operator', true),
  ('platform_support', 'Support',
   'Reads accounts and asks customers for access; changes nothing commercial', false),
  ('platform_billing', 'Billing',
   'Spike''s invoices and customers'' plans', false),
  ('platform_viewer',  'Read-only',
   'Sees accounts and the audit trail, and acts on nothing', false);

create table platform_role_permissions (
  role_key       text not null references platform_roles (key) on delete cascade,
  permission_key text not null references platform_permissions (key) on delete cascade,
  primary key (role_key, permission_key)
);

insert into platform_role_permissions (role_key, permission_key)
select 'platform_admin', key from platform_permissions;

insert into platform_role_permissions (role_key, permission_key) values
  ('platform_support', 'platform.customers.read'),
  ('platform_support', 'platform.support.request'),
  ('platform_support', 'platform.audit.read'),
  ('platform_billing', 'platform.customers.read'),
  ('platform_billing', 'platform.customers.plan'),
  ('platform_billing', 'platform.billing.manage'),
  ('platform_billing', 'platform.audit.read'),
  ('platform_viewer',  'platform.customers.read'),
  ('platform_viewer',  'platform.audit.read');

-- ---------------------------------------------------------------------------
-- Granted to a person
-- ---------------------------------------------------------------------------
create table platform_operator_roles (
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  role_key     text not null references platform_roles (key) on delete restrict,
  granted_by   uuid references auth.users (id),
  granted_at   timestamptz not null default now(),
  primary key (auth_user_id, role_key)
);

create index platform_operator_roles_role_idx on platform_operator_roles (role_key);

comment on table platform_operator_roles is
  'What each Spike operator may do in the console. The boolean on '
  'user_profiles says whether they may enter it at all.';

-- A role grant is meaningless on somebody who cannot enter the console, and a
-- grant left behind on a revoked operator is the kind of thing that comes back
-- when they are reinstated for an unrelated reason.
create or replace function app.platform_role_requires_operator()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if not exists (
    select 1 from user_profiles
     where auth_user_id = new.auth_user_id and is_platform_operator
  ) then
    raise exception 'That person is not a Spike operator, so a platform role cannot be granted to them.'
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end;
$$;

create trigger platform_operator_roles_require_operator
  before insert or update on platform_operator_roles
  for each row execute function app.platform_role_requires_operator();

-- The console must stay administrable. Without this, revoking the last
-- administrator — by mistake, or as the last step of somebody leaving — leaves
-- a product that can only be repaired with a database connection.
create or replace function app.platform_admin_must_remain()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_admins integer;
begin
  -- Only an administrator role is protected; the check is in the body because
  -- a trigger's WHEN clause may not contain a subquery.
  if not exists (
    select 1 from platform_roles where key = old.role_key and is_admin
  ) then
    return old;
  end if;

  select count(*) into v_admins
    from platform_operator_roles r
    join platform_roles pr on pr.key = r.role_key
    join user_profiles p on p.auth_user_id = r.auth_user_id
   where pr.is_admin and p.is_platform_operator
     and r.auth_user_id <> old.auth_user_id;

  if v_admins = 0 then
    raise exception
      'This is the last platform administrator. Give somebody else that role first.'
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

create trigger platform_operator_roles_keep_an_admin
  before delete on platform_operator_roles
  for each row execute function app.platform_admin_must_remain();

-- ---------------------------------------------------------------------------
-- Bringing a colleague in
-- ---------------------------------------------------------------------------
--
-- Spike staff belong to no organisation, so none of the existing invitation
-- paths can reach them: there is nothing to be a member of. The shape is the
-- same as every other invitation in the product — 32 random bytes, stored only
-- as a sha256, consumed on use, expiring — and redemption is the only thing in
-- the schema that may set `is_platform_operator`.
create table platform_operator_invitations (
  id                uuid primary key default gen_random_uuid(),
  invited_email     citext not null,
  full_name         text not null,
  roles             text[] not null check (cardinality(roles) between 1 and 8),
  invite_token_hash bytea not null unique,
  invited_by        uuid not null references auth.users (id),
  invited_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  status            text not null default 'invited'
                      check (status in ('invited', 'accepted', 'withdrawn')),
  accepted_at       timestamptz,
  accepted_by       uuid references auth.users (id)
);

create unique index platform_operator_invitations_one_open_per_email
  on platform_operator_invitations (invited_email) where status = 'invited';

-- ---------------------------------------------------------------------------
-- The condition
-- ---------------------------------------------------------------------------
--
-- Deliberately built ON `app.is_platform_operator()` rather than beside it, so
-- the second-factor requirement and the console door are stated in exactly one
-- place and a narrower role can never be a way around either.
create or replace function app.platform_permission(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.is_platform_operator() and exists (
    select 1
      from public.platform_operator_roles r
      join public.platform_role_permissions rp on rp.role_key = r.role_key
     where r.auth_user_id = auth.uid()
       and rp.permission_key = p_key
  );
$$;

comment on function app.platform_permission(text) is
  'Whether the caller is an operator in the console (second factor included) '
  'AND holds a platform role carrying this permission.';

grant execute on function app.platform_permission(text) to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- Who can see and change this
-- ---------------------------------------------------------------------------
alter table platform_permissions enable row level security;
alter table platform_roles enable row level security;
alter table platform_role_permissions enable row level security;
alter table platform_operator_roles enable row level security;
alter table platform_operator_invitations enable row level security;

-- The catalogue is readable by anybody already in the console: an operator is
-- entitled to know what their own role allows, and hiding it only makes a
-- refusal look like a fault.
create policy platform_permissions_select on platform_permissions
  for select using (app.is_platform_operator());
create policy platform_roles_select on platform_roles
  for select using (app.is_platform_operator());
create policy platform_role_permissions_select on platform_role_permissions
  for select using (app.is_platform_operator());
create policy platform_operator_roles_select on platform_operator_roles
  for select using (app.is_platform_operator());

create policy platform_operator_roles_manage on platform_operator_roles
  for all
  using (app.platform_permission('platform.operators.manage'))
  with check (app.platform_permission('platform.operators.manage'));

-- An invitation carries somebody's name and address, so it is readable by the
-- operators who administer them rather than by everybody in the console.
create policy platform_operator_invitations_manage on platform_operator_invitations
  for all
  using (app.platform_permission('platform.operators.manage'))
  with check (app.platform_permission('platform.operators.manage'));

grant select on platform_permissions, platform_roles, platform_role_permissions
  to propertyos_app;
grant select, insert, delete on platform_operator_roles to propertyos_app;
grant select, insert, update on platform_operator_invitations to propertyos_app;

-- ---------------------------------------------------------------------------
-- Nobody is locked out by this migration
-- ---------------------------------------------------------------------------
insert into platform_operator_roles (auth_user_id, role_key)
select p.auth_user_id, 'platform_admin'
  from user_profiles p
 where p.is_platform_operator
on conflict do nothing;
