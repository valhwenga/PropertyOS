-- ---------------------------------------------------------------------------
-- 0065  A support session grants nothing until the customer approves it
-- ---------------------------------------------------------------------------
--
-- The product says, in this schema's own comments and on the customer's own
-- screen, that Spike reaching customer records "requires an authorised,
-- time-limited, audited support session". Two of those three were true. The
-- session was time limited and audited, and it was authorised by nobody: an
-- operator inserted one for themselves and read the customer's records at
-- once. `support_sessions.authorised_by` existed, was nullable, was never set
-- by any path, and the customer's history rendered the honest consequence —
-- "Not authorised by you" — against every session there had ever been.
-- `app.support_organisation_ids()` was even commented as returning the
-- organisations the caller "holds a live, AUTHORISED support session for".
--
-- So the condition is made real, in the one place that decides it: the set
-- functions behind every read policy. An unapproved session now returns no
-- organisation, which means it reads nothing — not a filtered subset, nothing.
--
-- Two ways a session becomes approved, because a rule support cannot work
-- under gets worked around rather than followed:
--
--   * the customer approves THAT session, after seeing who asked and why; or
--   * the customer opened a window in advance (`support_access_grants`) and
--     the session was opened inside it, which approves it on arrival. This is
--     the "I'm about to raise a ticket, come in and look" case, and it is
--     still bounded, still attributed to the person who opened the window, and
--     still revocable in one click.
--
-- There is no break-glass path and deliberately so. An operator who could
-- admit themselves in an emergency can admit themselves at any time, and the
-- product would be back where it started with a longer comment.
--
-- Existing rows are NOT backfilled as approved. Legacy sessions were opened
-- under the old rule and backfilling them would be this migration asserting a
-- customer approval that never happened. They keep their history and lose
-- their access, which costs nothing: this product has never been deployed, and
-- every session in existence belongs to a demo or a test.

alter table support_sessions
  add column approved_at timestamptz,
  add column approved_via_grant_id uuid;

-- Approval is a fact about a person: the timestamp and the approver travel
-- together or not at all, so no row can read as approved by nobody.
alter table support_sessions
  add constraint support_sessions_approval_is_attributed
  check ((approved_at is null) = (authorised_by is null));

comment on column support_sessions.approved_at is
  'When the customer approved this session. Null means waiting: the session '
  'exists, is visible to both sides, and grants no access at all.';
comment on column support_sessions.approved_via_grant_id is
  'Set when the approval came from a window the customer opened in advance '
  'rather than from approving this session one at a time.';

-- ---------------------------------------------------------------------------
-- A window the customer opens in advance
-- ---------------------------------------------------------------------------
create table support_access_grants (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  -- The person at the customer who opened it. Not nullable: a window nobody
  -- opened is the thing this migration exists to prevent.
  authorised_by   uuid not null references auth.users(id),
  reason          text not null check (length(btrim(reason)) between 5 and 500),
  granted_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_by      uuid references auth.users(id),
  constraint support_access_grants_window check (expires_at > granted_at)
);

comment on table support_access_grants is
  'A window during which the customer lets Spike support open a session '
  'without being asked each time. Time limited, attributed, and revocable.';

create index support_access_grants_live_idx
  on support_access_grants (organisation_id, expires_at)
  where revoked_at is null;

alter table support_access_grants enable row level security;

alter table support_sessions
  add constraint support_sessions_approved_via_grant_fkey
  foreign key (approved_via_grant_id) references support_access_grants(id)
  on delete set null;

-- The customer's own administrators manage these. `support.access.manage` is
-- the permission that already means "authorise and revoke Spike support
-- sessions", which is exactly this.
create policy support_access_grants_select on support_access_grants
  for select
  using (app.has_permission(organisation_id, 'support.access.manage'));

create policy support_access_grants_insert on support_access_grants
  for insert
  with check (
    app.has_permission(organisation_id, 'support.access.manage')
    and authorised_by = auth.uid()
  );

create policy support_access_grants_update on support_access_grants
  for update
  using (app.has_permission(organisation_id, 'support.access.manage'))
  with check (app.has_permission(organisation_id, 'support.access.manage'));

-- An operator may see that a window exists, because otherwise they cannot
-- tell whether opening a session will reach anything. The row names the
-- customer's own approver and their reason and nothing else.
create policy support_access_grants_platform_select on support_access_grants
  for select
  using (app.is_platform_operator());

grant select, insert, update on support_access_grants to propertyos_app;
grant select on support_access_grants to propertyos_worker;

-- ---------------------------------------------------------------------------
-- The condition itself
-- ---------------------------------------------------------------------------
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
     and s.expires_at > now()
     -- The whole point of this migration.
     and s.approved_at is not null;
$$;

comment on function app.support_organisation_ids() is
  'Organisations this caller holds a live support session for that the '
  'customer has approved. An unapproved session returns nothing.';

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
      and s.approved_at is not null
  );
$$;

comment on function app.has_support_access(uuid) is
  'Whether this caller holds a live, customer-approved support session for '
  'this organisation.';

-- A session the customer has not approved yet is still a row the customer must
-- be able to UPDATE, because approving it is an update. The existing
-- `support_sessions_org_revoke` policy already admits exactly the holders of
-- `support.access.manage`, so approval needs no new policy — but it does need
-- the operator to be unable to approve their own session, and the WITH CHECK
-- on that policy is the customer's permission, which an operator never holds.

select app.assert_table_privileges();
