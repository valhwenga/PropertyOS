-- ---------------------------------------------------------------------------
-- 0057  Row Level Security that is evaluated once, not once per row
-- ---------------------------------------------------------------------------
--
-- §26 asks for ordinary page reads under a second. Eight of ten screens met
-- that after 0053; two did not, and `docs/performance.md` said the next piece
-- of work was the collection metrics query the overview and the collection
-- report share. That turned out to be wrong in an instructive way.
--
-- Measured against the blueprint's dataset, the query itself takes **27ms**.
-- The same statement under the application role takes **1,300ms**. The data
-- work was never the problem: the policies were.
--
-- Every policy was written as a function call on the row:
--
--     using (app.is_org_member(organisation_id) or app.has_support_access(...))
--
-- `is_org_member` is STABLE, but its argument changes per row, so Postgres
-- calls it per row — a subquery against `memberships` for every one of six
-- thousand charge lines. Worse, the resident policies on the same tables are
-- separate PERMISSIVE policies that get OR-ed in, and two of them wrapped a
-- correlated EXISTS around another table that has policies of its own. One
-- join of ninety-four allocations to their charge lines cost 878ms, almost all
-- of it re-deciding who the reader is.
--
-- The fix is the shape, not the logic. A set the caller belongs to can be
-- computed ONCE per query and hashed:
--
--     using (organisation_id in (select app.member_organisation_ids()))
--
-- Same answer, evaluated once. That one join falls from 878ms to 38ms.
--
-- WHAT THIS DOES NOT CHANGE: who can see what. Every predicate below resolves
-- to exactly the same rows for the same caller — the membership must still be
-- active, the support session must still be live and held by a platform
-- operator, the portal link must still be active and unexpired. The isolation
-- suites (tests/db/isolation, tests/db/adversarial-isolation) are what hold
-- that, and they are the reason this change is safe to make mechanically.
--
-- The boolean helpers stay. They are used by security-definer functions and by
-- domain SQL where a single row is being checked, which is what they are good
-- at.

/* ------------------------------------------------------- the caller's sets */

-- Each of these answers "which ids may this caller reach", once, for the whole
-- query. SECURITY DEFINER for the same reason the boolean helpers are: the
-- membership and portal tables have policies of their own, and a policy that
-- has to consult a policy is how the per-row cost started.

create or replace function app.member_organisation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
    from public.memberships m
   where m.auth_user_id = auth.uid()
     and m.status = 'active';
$$;

comment on function app.member_organisation_ids() is
  'Organisations this caller is an active member of. The set form of '
  'app.is_org_member, so a policy evaluates it once per query.';

create or replace function app.support_organisation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.organisation_id
    from public.support_sessions s
    join public.user_profiles p on p.auth_user_id = s.operator_user_id
   where s.operator_user_id = auth.uid()
     and p.is_platform_operator
     and s.revoked_at is null
     and s.expires_at > now();
$$;

comment on function app.support_organisation_ids() is
  'Organisations this caller holds a live, authorised support session for.';

-- The id sets that the correlated EXISTS policies used to compute per row.

create or replace function app.resident_charge_line_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select cl.id from public.charge_lines cl
   where cl.lease_id in (select app.resident_lease_ids());
$$;

create or replace function app.resident_deposit_account_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select da.id from public.deposit_accounts da
   where da.lease_id in (select app.resident_lease_ids());
$$;

create or replace function app.resident_ticket_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from public.maintenance_tickets t
   where t.lease_id is not null
     and t.lease_id in (select app.resident_lease_ids());
$$;

-- Only finalised inspections, exactly as the policy it replaces required: a
-- resident must not read an inspection somebody is still writing.
create or replace function app.resident_inspection_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.id from public.inspections i
   where i.lease_id is not null
     and i.status in ('finalised', 'acknowledged', 'disputed')
     and i.lease_id in (select app.resident_lease_ids());
$$;

create or replace function app.resident_property_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct l.property_id from public.leases l
   where l.id in (select app.resident_lease_ids());
$$;

create or replace function app.resident_unit_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct l.unit_id from public.leases l
   where l.id in (select app.resident_lease_ids());
$$;

grant execute on function
  app.member_organisation_ids(), app.support_organisation_ids(),
  app.resident_charge_line_ids(), app.resident_deposit_account_ids(),
  app.resident_ticket_ids(), app.resident_inspection_ids(),
  app.resident_property_ids(), app.resident_unit_ids()
  to propertyos_app, propertyos_worker;

/* ------------------------------ the policies that joined to another table */

-- These are stated in full rather than transformed, because their shape
-- changes: a correlated EXISTS over a second table becomes a membership test
-- against a set of ids. The conditions each one carries — the audience of a
-- comment, the status of an inspection, a ticket that belongs to a lease at
-- all — are preserved exactly.

drop policy if exists payment_allocations_resident_select on payment_allocations;
create policy payment_allocations_resident_select on payment_allocations
  for select using (charge_line_id in (select app.resident_charge_line_ids()));

drop policy if exists deposit_events_resident_select on deposit_events;
create policy deposit_events_resident_select on deposit_events
  for select using (deposit_account_id in (select app.resident_deposit_account_ids()));

drop policy if exists maintenance_ticket_events_resident_select on maintenance_ticket_events;
create policy maintenance_ticket_events_resident_select on maintenance_ticket_events
  for select using (ticket_id in (select app.resident_ticket_ids()));

drop policy if exists maintenance_comments_resident_select on maintenance_comments;
create policy maintenance_comments_resident_select on maintenance_comments
  for select using (
    audience = 'resident_visible'::app.comment_audience
    and ticket_id in (select app.resident_ticket_ids())
  );

drop policy if exists maintenance_attachments_resident_select on maintenance_attachments;
create policy maintenance_attachments_resident_select on maintenance_attachments
  for select using (
    audience = 'resident_visible'::app.comment_audience
    and ticket_id in (select app.resident_ticket_ids())
  );

drop policy if exists inspection_items_resident_select on inspection_items;
create policy inspection_items_resident_select on inspection_items
  for select using (inspection_id in (select app.resident_inspection_ids()));

drop policy if exists properties_resident_select on properties;
create policy properties_resident_select on properties
  for select using (id in (select app.resident_property_ids()));

drop policy if exists units_resident_select on units;
create policy units_resident_select on units
  for select using (id in (select app.resident_unit_ids()));

/* ----------------------------------------- everything else, transformed */

-- Two hundred and thirty-odd policies say the same three things in the same
-- three ways. Restating each one by hand would be a thousand lines in which a
-- single mistyped predicate is a tenant isolation hole, so the transformation
-- is applied mechanically and then ASSERTED: the block below rewrites every
-- remaining per-row call into its set form, and the check at the end fails the
-- migration if any policy still carries one.
--
-- The replacement is parenthesised, so a predicate that was one operand of an
-- AND or an OR stays one operand of it.

do $$
declare
  policy_row record;
  new_qual text;
  new_check text;
  statement text;
  command_word text;
begin
  for policy_row in
    select c.relname as table_name,
           p.polname as policy_name,
           p.polcmd as command,
           pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as with_check,
           -- Role 0 is PUBLIC, which `create policy` spells by leaving the
           -- clause out rather than by naming a role.
           array(
             select pg_get_userbyid(r) from unnest(p.polroles) as r
             where r <> 0
           ) as roles
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and (
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~
           '(is_org_member|has_support_access|can_access_lease_as_resident)'
         or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~
           '(is_org_member|has_support_access|can_access_lease_as_resident)'
       )
  loop
    new_qual := policy_row.qual;
    new_check := policy_row.with_check;

    foreach statement in array array[
      'is_org_member|member_organisation_ids',
      'has_support_access|support_organisation_ids',
      'can_access_lease_as_resident|resident_lease_ids'
    ] loop
      new_qual := regexp_replace(
        new_qual,
        'app\.' || split_part(statement, '|', 1) || '\(([^()]*)\)',
        '(\1 in (select app.' || split_part(statement, '|', 2) || '()))',
        'g');
      new_check := regexp_replace(
        new_check,
        'app\.' || split_part(statement, '|', 1) || '\(([^()]*)\)',
        '(\1 in (select app.' || split_part(statement, '|', 2) || '()))',
        'g');
    end loop;

    command_word := case policy_row.command
      when 'r' then 'select' when 'a' then 'insert'
      when 'w' then 'update' when 'd' then 'delete' else 'all' end;

    execute format('drop policy %I on public.%I', policy_row.policy_name, policy_row.table_name);
    execute format(
      'create policy %I on public.%I for %s%s%s%s',
      policy_row.policy_name, policy_row.table_name, command_word,
      case when cardinality(policy_row.roles) > 0
        then ' to ' || array_to_string(policy_row.roles, ', ') else '' end,
      case when new_qual is not null then ' using (' || new_qual || ')' else '' end,
      case when new_check is not null then ' with check (' || new_check || ')' else '' end
    );
  end loop;
end
$$;

-- The assertion. If a policy still calls one of these on a row, the per-row
-- cost is still there and this migration has not done its job.
do $$
declare offenders text;
begin
  select string_agg(c.relname || '.' || p.polname, ', ')
    into offenders
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and (
       coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~
         'app\.(is_org_member|has_support_access|can_access_lease_as_resident)\('
       or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~
         'app\.(is_org_member|has_support_access|can_access_lease_as_resident)\('
     );
  if offenders is not null then
    raise exception 'Policies still evaluate per row: %', offenders;
  end if;
end
$$;

select app.assert_table_privileges();
