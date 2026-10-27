-- ---------------------------------------------------------------------------
-- 0080  Leaving is a process, not a flag
-- ---------------------------------------------------------------------------
--
-- `setAccountStatus('closed')` set a column. That was the whole of offboarding:
-- the console stopped opening and the records sat there for ever, with no
-- record of why the account closed, no date on which anything would happen,
-- and no way to destroy a customer's personal information when they asked for
-- it. Before real customer data lands, a landlord who leaves has to be able to
-- take their records and have the rest removed.
--
-- Four decisions.
--
-- **Closing is a decision with a date.** `organisation_closures` carries the
-- reason, who decided, and the day the records may be destroyed — a retention
-- period rather than an afternoon's judgement. The default is Spike's choice
-- and nothing more: five years is the period a South African landlord's
-- financial records are commonly kept for, and every operator must settle it
-- against their own advice rather than ours. The date is the brake: nothing
-- can be destroyed before it.
--
-- **The customer keeps their way out while the clock runs.** The export route
-- has only ever needed a membership, so a closed customer's archive still
-- builds — but `requireOperator` sends them to the closed page, and the only
-- link to it was on a console page they can no longer open. The way out
-- existed and was unreachable, which is the same as not existing.
--
-- **Destruction removes the customer's records and keeps Spike's.** Deleting
-- the `organisations` row was never possible: `subscription_invoices`
-- references it with NO ACTION, and so Spike's own tax records would have to
-- be destroyed first. That constraint is right, and it settles the shape.
-- The organisation row stays as a tombstone, Spike keeps its invoices, its
-- audit of its own conduct and its record of the sessions the customer let
-- it have, and everything the customer put in is deleted.
--
-- **Destroying rows is not destroying files.** A document's bytes live in a
-- bucket and only `documents.storage_key` says where. Deleting that row first
-- would leave the file in place with nothing left to find it by — the worst of
-- both outcomes. The keys are therefore read before the purge and handed back
-- to the caller, which removes the objects once the transaction has committed
-- and records what would not go.
--
-- **The people are anonymised rather than deleted.** Spike's record of who
-- authorised its access is `support_sessions.authorised_by`, which points at
-- the customer's own administrator; deleting that person's row would delete
-- the evidence of their consent along with it. So an identity left with
-- nothing to belong to keeps its row and loses everything that identifies or
-- admits anybody: name, email, phone, password, second factor.

insert into platform_permissions (key, description) values
  ('platform.customers.destroy',
   'Destroy a closed customer''s records once their retention period has passed');

-- Administrators only, and not support. Everything else in the console is
-- recoverable or reviewable; this is the one action with nothing behind it.
insert into platform_role_permissions (role_key, permission_key) values
  ('platform_admin', 'platform.customers.destroy');

insert into platform_settings (
  key, name, description, value_type, default_value, min_value, max_value,
  per_organisation, customer_visible, sort
) values
  ('offboarding.retention_months', 'Keep a closed customer''s records for',
   'Months between closing an account and the day its records may be destroyed. '
   || 'The default is five years, the period a landlord''s financial records are '
   || 'commonly kept for in South Africa — confirm it against your own advice. '
   || 'Nothing is ever destroyed automatically: the date only decides when a '
   || 'person is allowed to.',
   'integer', '60', 0, 240, false, false, 20);

-- ---------------------------------------------------------------------------
-- The closure itself
-- ---------------------------------------------------------------------------

create table organisation_closures (
  organisation_id    uuid primary key references organisations(id) on delete cascade,
  closed_at          timestamptz not null default now(),
  closed_by          uuid not null references auth.users(id),
  reason             text not null,
  retain_until       date not null,
  destroyed_at       timestamptz,
  destroyed_by       uuid references auth.users(id),
  destruction_reason text,
  rows_destroyed     integer,
  -- Rows are not the whole of a customer's data. The lease agreements,
  -- inspection photographs and identity documents are objects in a bucket, and
  -- destroying `documents` deletes the only record of where they are. So the
  -- keys are collected before the purge, the objects are removed after it, and
  -- anything that would not go is written down here rather than left as
  -- personal information nobody can find any more.
  objects_removed    integer,
  objects_left       text[],
  constraint closure_reason_says_something check (length(btrim(reason)) >= 5),
  -- A destruction is all of its parts or none of them: a timestamp with no
  -- reason beside it is the record of an act nobody will be able to explain.
  constraint destruction_is_whole check (
    (destroyed_at is null and destroyed_by is null
      and destruction_reason is null and rows_destroyed is null)
    or (destroyed_at is not null and destroyed_by is not null
      and length(btrim(destruction_reason)) >= 5 and rows_destroyed is not null)
  )
);

comment on table organisation_closures is
  'Why an account closed, when its records may be destroyed, and whether they '
  'have been. One row per closed customer; reopening removes it.';

create index organisation_closures_due_idx
  on organisation_closures (retain_until) where destroyed_at is null;

alter table organisation_closures enable row level security;

create policy organisation_closures_platform_select on organisation_closures
  for select using (app.platform_permission('platform.customers.read'));

create policy organisation_closures_platform_insert on organisation_closures
  for insert with check (app.platform_permission('platform.customers.status'));

-- Closing and reopening are the same lever, so they are the same permission.
create policy organisation_closures_platform_delete on organisation_closures
  for delete using (app.platform_permission('platform.customers.status'));

-- The only thing an update does to this row is record a destruction.
create policy organisation_closures_platform_update on organisation_closures
  for update using (app.platform_permission('platform.customers.destroy'))
  with check (app.platform_permission('platform.customers.destroy'));

grant select, insert, update, delete on organisation_closures to propertyos_app;

-- The customer reads their own. The closed page tells them the date their
-- records may be destroyed, and a date somebody else can see and they cannot
-- is not notice.
create policy organisation_closures_member_select on organisation_closures
  for select using (organisation_id in (select app.member_organisation_ids()));

-- ---------------------------------------------------------------------------
-- Destroying the records
-- ---------------------------------------------------------------------------
--
-- Deliberately generic. The customer's data surface is "every table that
-- carries an organisation_id", which is the invariant the schema already
-- holds itself to and the test suite already asserts; a hand-written list of
-- eighty-six tables is a list that silently stops being complete the next
-- time somebody adds one.
--
-- The keep list is therefore the thing to read. It is short, and every entry
-- is something of SPIKE's rather than the customer's:
--
--   subscription_invoices    Spike's own invoices, with the recipient's
--                            details frozen on them at issue. Spike's tax
--                            records are Spike's obligation, not the
--                            customer's to erase.
--   support_sessions,
--   support_access_grants    Who let Spike in, when, and what they approved.
--                            The evidence of the customer's own consent.
--   audit_events             Spike's conduct towards this customer. Only
--                            that: the customer's own entries go, below.
--   organisation_closures     The record of this destruction.
--
-- FK order is handled by running the deletes in passes and letting a delete
-- that is blocked by a child wait for the next one, rather than by hard-coding
-- a topological order that also stops being correct. The function then proves
-- its own result: if a single row with this organisation_id is left anywhere
-- outside the keep list, it raises and the whole thing rolls back.

create or replace function app.destroy_organisation_data(
  p_organisation_id uuid,
  out rows_destroyed integer,
  out storage_keys text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep text[] := array[
    'organisation_closures', 'subscription_invoices',
    'support_sessions', 'support_access_grants', 'audit_events'
  ];
  v_people uuid[];
  v_table text;
  v_deleted integer;
  v_pass integer := 0;
  v_pass_deleted integer;
  v_blocked boolean;
  v_total integer := 0;
  v_closure public.organisation_closures;
begin
  -- This function is executable by the application role, which is every
  -- customer's role as well as every operator's. The permission check belongs
  -- inside it for that reason, not in the caller.
  if not app.platform_permission('platform.customers.destroy') then
    raise exception 'Destroying a customer''s records requires platform.customers.destroy'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_closure
  from public.organisation_closures
  where organisation_id = p_organisation_id
  for update;

  if not found then
    raise exception 'That account has not been closed, so there is nothing to destroy'
      using errcode = 'check_violation';
  end if;
  if v_closure.destroyed_at is not null then
    raise exception 'Those records were destroyed on %', v_closure.destroyed_at::date
      using errcode = 'check_violation';
  end if;
  if v_closure.retain_until > current_date then
    raise exception 'Those records are retained until %', v_closure.retain_until
      using errcode = 'check_violation';
  end if;

  -- The files, before the purge. `documents.storage_key` is the only record of
  -- where a lease agreement or an identity document actually is, so reading
  -- these after deleting the rows is not possible and reading them from the
  -- caller's own context returns nothing.
  select coalesce(array_agg(d.storage_key), '{}'::text[]) into storage_keys
  from public.documents d
  where d.organisation_id = p_organisation_id;

  -- The people, before the purge: afterwards there is nothing left to find
  -- them by.
  select coalesce(array_agg(distinct s.u), '{}'::uuid[]) into v_people from (
    select m.auth_user_id as u from public.memberships m
      where m.organisation_id = p_organisation_id
    union
    select o.auth_user_id from public.owner_links o
      where o.organisation_id = p_organisation_id
    union
    select l.auth_user_id from public.portal_links l
      where l.organisation_id = p_organisation_id and l.auth_user_id is not null
  ) s;

  loop
    v_pass := v_pass + 1;
    v_pass_deleted := 0;
    v_blocked := false;

    for v_table in
      select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
        and a.attname = 'organisation_id' and a.attnum > 0 and not a.attisdropped
        and not (c.relname = any(v_keep))
      order by c.relname
    loop
      begin
        execute format('delete from public.%I where organisation_id = $1', v_table)
          using p_organisation_id;
        get diagnostics v_deleted = row_count;
        v_pass_deleted := v_pass_deleted + v_deleted;
      exception when foreign_key_violation then
        -- A child elsewhere still points at these rows. It is in this same
        -- list and will go first on a later pass.
        v_blocked := true;
      end;
    end loop;

    v_total := v_total + v_pass_deleted;
    exit when not v_blocked and v_pass_deleted = 0;

    if v_pass >= 12 then
      raise exception 'Could not destroy % in % passes: something outside the '
        'keep list still references its rows', p_organisation_id, v_pass
        using errcode = 'foreign_key_violation';
    end if;
  end loop;

  -- The guarantee, checked rather than assumed.
  for v_table in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attname = 'organisation_id' and a.attnum > 0 and not a.attisdropped
      and not (c.relname = any(v_keep))
    order by c.relname
  loop
    execute format('select count(*) from public.%I where organisation_id = $1', v_table)
      into v_deleted using p_organisation_id;
    if v_deleted > 0 then
      raise exception 'Destruction left % row(s) in %', v_deleted, v_table;
    end if;
  end loop;

  -- The customer's own trail goes with their records: an entry saying which
  -- resident was added, and what their details were before somebody changed
  -- them, is the personal information this is meant to remove. What stays is
  -- Spike's conduct towards the account, and the fact that the customer took
  -- their data before leaving.
  delete from public.audit_events
  where organisation_id = p_organisation_id
    and action not like 'platform.%'
    and action <> 'customer.exported';
  get diagnostics v_deleted = row_count;
  v_total := v_total + v_deleted;

  -- An identity with nothing left to belong to. It keeps its row, because
  -- support_sessions.authorised_by points at it and that is the record of this
  -- customer's own consent, and loses everything that identifies a person or
  -- admits one: name, email, phone, password, second factor.
  with orphaned as (
    select u.id
    from auth.users u
    where u.id = any(v_people)
      and not exists (select 1 from public.memberships m where m.auth_user_id = u.id)
      and not exists (select 1 from public.owner_links o where o.auth_user_id = u.id)
      and not exists (select 1 from public.portal_links l where l.auth_user_id = u.id)
      and not exists (
        select 1 from public.platform_operator_roles r where r.auth_user_id = u.id
      )
  ), profiles as (
    update public.user_profiles p
       set full_name = 'Removed', email = 'destroyed-' || p.auth_user_id || '@invalid',
           phone = null, updated_at = now()
     where p.auth_user_id in (select id from orphaned)
    returning 1
  ), factors as (
    delete from public.auth_mfa_factors f
     where f.auth_user_id in (select id from orphaned)
    returning 1
  ), codes as (
    delete from public.auth_mfa_recovery_codes c
     where c.auth_user_id in (select id from orphaned)
    returning 1
  )
  update auth.users u
     set email = 'destroyed-' || u.id || '@invalid',
         -- verifyPassword reads scheme$salt$hash and returns false on anything
         -- else, so this is a password no input matches rather than an absent
         -- one somebody could then set.
         password_hash = 'destroyed$' || gen_random_uuid()
   where u.id in (select id from orphaned);
  get diagnostics v_deleted = row_count;
  v_total := v_total + v_deleted;

  rows_destroyed := v_total;
end;
$$;

comment on function app.destroy_organisation_data(uuid) is
  'Deletes every row carrying this organisation_id outside a keep list of '
  'Spike''s own records, removes the customer''s own audit entries, and '
  'anonymises identities left with nothing to belong to. Returns the storage '
  'keys of the documents it deleted, read before the purge, because nothing '
  'afterwards says where those files are. Refuses before the retention date '
  'and raises if a single row is left behind.';

grant execute on function app.destroy_organisation_data(uuid) to propertyos_app;
