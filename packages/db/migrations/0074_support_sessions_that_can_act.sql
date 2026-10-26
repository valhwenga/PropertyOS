-- ---------------------------------------------------------------------------
-- 0074  A support session that can do what the customer asked for
-- ---------------------------------------------------------------------------
--
-- Support sessions have been read-only since they were built, which was the
-- right default and is the wrong end state. A landlord who writes "the ticket
-- for 12B is on the wrong unit, please move it" cannot be helped: Spike can
-- see the mistake and not touch it, so the answer is a set of instructions for
-- the customer to carry out on their own screen. That is not support.
--
-- So a session can now ACT, under four conditions, none of which is optional:
--
--   1. the customer authorised it, in advance or in answer to a request;
--   2. the customer chose WHAT it may do, from named scopes they can read;
--   3. it expires, and they can revoke it at any moment;
--   4. everything done under it is attributed to it in the audit trail.
--
-- Three decisions carry the weight.
--
-- **Scopes are data, with an allowlist in front of them.** A scope is a row
-- joining a customer permission to a thing a landlord would recognise
-- ("maintenance", "records", "documents"). What may appear in one is
-- restricted by `app.support_grantable_permission`, an ALLOWLIST: a permission
-- invented by a later migration is forbidden to support sessions until
-- somebody deliberately adds it. A denylist would have the opposite default
-- and the wrong failure mode.
--
-- **Money and governance are not scopes, and have no policy.** There is no
-- scope that reaches bank accounts, receipts, allocations, reversals,
-- deposits, expenses, period locks, memberships, support access itself, the
-- bulk export, or identity documents. Not "a scope nobody is given" — no
-- policy on those tables mentions support sessions at all, so the write is
-- refused by the row whatever any code believes. Redirecting rent and granting
-- yourself permanent access are the two attacks a support channel invites; the
-- schema simply cannot express them.
--
-- **The writes are a SEPARATE policy per table.** The alternative was editing
-- twenty existing policies to OR in a support clause, and the first draft of
-- 0073 proved what that costs: conditions get dropped in the rewrite. Policies
-- are OR-ed anyway, so a `*_support_*` policy beside each existing one is the
-- same grant, visible on its own, droppable on its own, and it leaves the
-- membership path untouched.

-- ---------------------------------------------------------------------------
-- What a customer can let Spike do
-- ---------------------------------------------------------------------------
create table support_scopes (
  key         text primary key,
  name        text not null,
  -- Written for the landlord who is about to tick the box, not for us.
  description text not null,
  sort        integer not null default 0
);

insert into support_scopes (key, name, description, sort) values
  ('maintenance', 'Maintenance',
   'Raise, re-assign, comment on and close maintenance tickets, and attach photographs.', 1),
  ('records', 'Property and lease records',
   'Correct property, unit, resident and lease details, and draft or activate a lease. '
   || 'Cannot end a tenancy.', 2),
  ('documents', 'Documents',
   'Upload documents and file them against the right lease. Identity documents stay closed.', 3);

-- The allowlist. Deliberately a function with the keys written out: adding to
-- it is a migration somebody has to justify, which is the friction this
-- decision wants.
create or replace function app.support_grantable_permission(p_key text)
returns boolean
language sql
immutable
as $$
  select p_key = any (array[
    -- Maintenance, which is what most support requests are actually about.
    'maintenance.read', 'maintenance.manage',
    -- Correcting records. Note what is NOT here: lease.close ends somebody's
    -- tenancy, and maintenance.quote.approve and inspection.manage commit
    -- money or drive deposit deductions.
    'portfolio.read', 'property.create', 'property.update',
    'resident.read', 'resident.manage',
    'lease.read', 'lease.create', 'lease.activate',
    -- Documents, excluding the identity ones.
    'document.read', 'document.manage'
  ]);
$$;

comment on function app.support_grantable_permission(text) is
  'Whether a permission may appear in a support scope at all. An allowlist, so '
  'a permission added by a later migration is forbidden to support sessions '
  'until somebody adds it here on purpose.';

create table support_scope_permissions (
  scope_key      text not null references support_scopes (key) on delete cascade,
  permission_key text not null references permissions (key) on delete cascade,
  primary key (scope_key, permission_key),
  constraint support_scope_permissions_grantable
    check (app.support_grantable_permission(permission_key))
);

insert into support_scope_permissions (scope_key, permission_key) values
  ('maintenance', 'maintenance.read'),
  ('maintenance', 'maintenance.manage'),
  ('records',     'portfolio.read'),
  ('records',     'property.create'),
  ('records',     'property.update'),
  ('records',     'resident.read'),
  ('records',     'resident.manage'),
  ('records',     'lease.read'),
  ('records',     'lease.create'),
  ('records',     'lease.activate'),
  ('documents',   'document.read'),
  ('documents',   'document.manage');

alter table support_scopes enable row level security;
alter table support_scope_permissions enable row level security;

-- Readable by everybody who might have to decide about them: the customer
-- ticking the boxes and the operator asking. Writable by neither.
create policy support_scopes_read on support_scopes for select using (true);
create policy support_scope_permissions_read on support_scope_permissions
  for select using (true);

grant select on support_scopes, support_scope_permissions
  to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- What this session, and this window, may do
-- ---------------------------------------------------------------------------
alter table support_access_grants
  add column scopes text[] not null default '{}';
alter table support_sessions
  add column scopes text[] not null default '{}';

-- `read_only` has been the flag the policies read since 0013 and it stays
-- exactly that, kept honest rather than left to drift: a session with no
-- scopes is read-only, one with scopes is not, and the constraint makes the
-- two statements the same statement.
alter table support_sessions
  add constraint support_sessions_read_only_matches_scopes
  check (read_only = (cardinality(scopes) = 0));

create or replace function app.support_scopes_are_known()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_unknown text;
begin
  select s into v_unknown
    from unnest(new.scopes) as s
   where not exists (select 1 from support_scopes where key = s)
   limit 1;
  if v_unknown is not null then
    raise exception 'There is no support scope called "%".', v_unknown
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end;
$$;

create trigger support_access_grants_known_scopes
  before insert or update on support_access_grants
  for each row execute function app.support_scopes_are_known();
create trigger support_sessions_known_scopes
  before insert or update on support_sessions
  for each row execute function app.support_scopes_are_known();

-- ---------------------------------------------------------------------------
-- A session may never be wider than what the customer gave
-- ---------------------------------------------------------------------------
--
-- The insert policy from 0013 required `read_only = true`, which is what made
-- a writing session impossible; this replaces that with the condition the
-- product actually wants. An operator may still insert only their own session,
-- and may give it scopes only where the customer's own window already carries
-- them.
drop policy support_sessions_platform_insert on support_sessions;
create policy support_sessions_platform_insert on support_sessions
  for insert
  with check (
    app.platform_permission('platform.support.request')
    and operator_user_id = auth.uid()
    and (
      -- Read-only, as before: anybody may ask, the customer still approves.
      cardinality(scopes) = 0
      -- Or scoped, and then only against a live window of the customer's own
      -- that already carries every scope asked for.
      or exists (
        select 1 from support_access_grants g
         where g.id = approved_via_grant_id
           and g.organisation_id = support_sessions.organisation_id
           and g.revoked_at is null
           and g.expires_at > now()
           and scopes <@ g.scopes
      )
    )
  );

comment on policy support_sessions_platform_insert on support_sessions is
  'An operator opens their own session. It may only carry scopes the '
  'customer''s own live window already carries — so an operator cannot widen '
  'what they were given, and cannot write one for a colleague.';

-- The approval guard from 0066 decides which columns may move after insert.
-- `scopes` joins that list: the customer may widen a session when they
-- approve it, and nobody may widen it afterwards — least of all the operator
-- it belongs to.
create or replace function app.support_session_approval_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.approved_at is distinct from old.approved_at
     or new.authorised_by is distinct from old.authorised_by
     or new.approved_via_grant_id is distinct from old.approved_via_grant_id
     or new.scopes is distinct from old.scopes
  then
    if old.approved_at is not null and new.scopes is distinct from old.scopes then
      -- Narrowing after the fact would be a second way to revoke, with a
      -- worse record of what happened. Ending the session is the way.
      raise exception
        'What a support session may do cannot change once approved; end the session instead (session %).',
        old.id using errcode = 'check_violation';
    end if;
    if old.approved_at is not null and new.approved_at is distinct from old.approved_at then
      raise exception 'A support session approval cannot be changed once given (session %).', old.id
        using errcode = 'check_violation';
    end if;
    if new.approved_at is null and old.approved_at is not null then
      raise exception 'A support session approval cannot be removed; end the session instead (session %).', old.id
        using errcode = 'check_violation';
    end if;
    if not app.has_permission(old.organisation_id, 'support.access.manage') then
      raise exception 'Only an administrator of this organisation can approve Spike support access.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

comment on function app.support_session_approval_guard() is
  'Lets the approval columns and the scopes of a support session move only for '
  'a holder of the customer''s support.access.manage, only from unapproved to '
  'approved, and never after approval. The operator who asked cannot answer '
  'for them, and cannot widen what they were given.';

-- ---------------------------------------------------------------------------
-- The conditions the policies read
-- ---------------------------------------------------------------------------
create or replace function app.support_may_write(p_org uuid, p_scope text)
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
     where s.operator_user_id = auth.uid()
       and s.organisation_id = p_org
       and p.is_platform_operator
       and s.revoked_at is null
       and s.expires_at > now()
       and s.approved_at is not null
       and p_scope = any (s.scopes)
  );
$$;

comment on function app.support_may_write(uuid, text) is
  'Whether the caller holds a live, customer-approved support session on this '
  'organisation carrying this scope. The condition behind every support write '
  'policy.';

-- The same question asked by permission rather than by scope, which is what
-- the command layer needs: it knows it wants `maintenance.manage`, not which
-- scope happens to carry it.
create or replace function app.support_may(p_org uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.support_grantable_permission(p_permission) and exists (
    select 1
      from public.support_sessions s
      join public.user_profiles p on p.auth_user_id = s.operator_user_id
      join public.support_scope_permissions sp on sp.scope_key = any (s.scopes)
     where s.operator_user_id = auth.uid()
       and s.organisation_id = p_org
       and p.is_platform_operator
       and s.revoked_at is null
       and s.expires_at > now()
       and s.approved_at is not null
       and sp.permission_key = p_permission
  );
$$;

comment on function app.support_may(uuid, text) is
  'Whether the caller may exercise this customer permission under a live, '
  'approved support session. The allowlist is applied here too, so a forbidden '
  'permission is refused even if a scope somehow carried it.';

create or replace function app.current_support_session(p_org uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.support_sessions s
   where s.operator_user_id = auth.uid()
     and s.organisation_id = p_org
     and s.revoked_at is null
     and s.expires_at > now()
     and s.approved_at is not null
   order by s.granted_at desc
   limit 1;
$$;

grant execute on function
  app.support_may_write(uuid, text), app.support_may(uuid, text),
  app.current_support_session(uuid), app.support_grantable_permission(text)
  to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- The writes themselves, one named policy per table
-- ---------------------------------------------------------------------------
--
-- Each is a second permissive policy beside the membership one, so the
-- membership path is untouched and the support path can be read — and removed
-- — on its own. Property scoping is deliberately absent: a window the customer
-- opens is for their organisation, exactly as a read-only session always was.

-- Maintenance.
create policy maintenance_tickets_support_insert on maintenance_tickets
  for insert with check (app.support_may_write(organisation_id, 'maintenance'));
create policy maintenance_tickets_support_update on maintenance_tickets
  for update
  using (app.support_may_write(organisation_id, 'maintenance'))
  with check (app.support_may_write(organisation_id, 'maintenance'));

create policy maintenance_ticket_events_support_insert on maintenance_ticket_events
  for insert with check (app.support_may_write(organisation_id, 'maintenance'));
create policy maintenance_ticket_events_support_update on maintenance_ticket_events
  for update
  using (app.support_may_write(organisation_id, 'maintenance'))
  with check (app.support_may_write(organisation_id, 'maintenance'));

create policy maintenance_attachments_support_insert on maintenance_attachments
  for insert with check (app.support_may_write(organisation_id, 'maintenance'));
create policy maintenance_attachments_support_update on maintenance_attachments
  for update
  using (app.support_may_write(organisation_id, 'maintenance'))
  with check (app.support_may_write(organisation_id, 'maintenance'));

-- Property, unit and lease records.
create policy properties_support_insert on properties
  for insert with check (app.support_may_write(organisation_id, 'records'));
create policy properties_support_update on properties
  for update
  using (app.support_may_write(organisation_id, 'records'))
  with check (app.support_may_write(organisation_id, 'records'));

create policy buildings_support_insert on buildings
  for insert with check (app.support_may_write(organisation_id, 'records'));
create policy buildings_support_update on buildings
  for update
  using (app.support_may_write(organisation_id, 'records'))
  with check (app.support_may_write(organisation_id, 'records'));

create policy units_support_insert on units
  for insert with check (app.support_may_write(organisation_id, 'records'));
create policy units_support_update on units
  for update
  using (app.support_may_write(organisation_id, 'records'))
  with check (app.support_may_write(organisation_id, 'records'));

create policy resident_profiles_support_insert on resident_profiles
  for insert with check (app.support_may_write(organisation_id, 'records'));
create policy resident_profiles_support_update on resident_profiles
  for update
  using (app.support_may_write(organisation_id, 'records'))
  with check (app.support_may_write(organisation_id, 'records'));

create policy leases_support_insert on leases
  for insert with check (app.support_may_write(organisation_id, 'records'));
create policy leases_support_update on leases
  for update
  using (app.support_may_write(organisation_id, 'records'))
  with check (app.support_may_write(organisation_id, 'records'));

create policy lease_parties_support_insert on lease_parties
  for insert with check (app.support_may_write(organisation_id, 'records'));
create policy lease_parties_support_update on lease_parties
  for update
  using (app.support_may_write(organisation_id, 'records'))
  with check (app.support_may_write(organisation_id, 'records'));

create policy charge_schedules_support_insert on charge_schedules
  for insert with check (app.support_may_write(organisation_id, 'records'));
create policy charge_schedules_support_update on charge_schedules
  for update
  using (app.support_may_write(organisation_id, 'records'))
  with check (app.support_may_write(organisation_id, 'records'));

-- Documents.
create policy documents_support_insert on documents
  for insert with check (app.support_may_write(organisation_id, 'documents'));
create policy documents_support_update on documents
  for update
  using (app.support_may_write(organisation_id, 'documents'))
  with check (app.support_may_write(organisation_id, 'documents'));

-- ---------------------------------------------------------------------------
-- Everything done under a session is attributed to it
-- ---------------------------------------------------------------------------
--
-- `audit_events.support_session_id` has existed since the first migration and
-- was filled only where a command remembered to pass it. Under a session that
-- can change records, "which support session did this" must not depend on a
-- command remembering, so the row fills it in itself.
create or replace function app.audit_attributes_support_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.support_session_id is null and new.organisation_id is not null then
    new.support_session_id := app.current_support_session(new.organisation_id);
  end if;
  return new;
end;
$$;

create trigger audit_events_attribute_support_session
  before insert on audit_events
  for each row execute function app.audit_attributes_support_session();

comment on function app.audit_attributes_support_session() is
  'Stamps the live support session onto an audit row written under one, so '
  'attribution does not depend on every command remembering to pass it.';

select app.assert_table_privileges();
