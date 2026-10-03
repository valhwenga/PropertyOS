-- 0013_platform_operator_scope.sql
-- Spike platform administration.
--
-- The starting posture is correct and stays: a platform operator has NO access
-- to customer content. Running the platform, however, requires platform
-- METADATA — which customers exist, what plan they are on, how many units they
-- are being billed for, whether the queue is healthy.
--
-- This migration opens exactly that, and nothing else:
--   * organisations, subscriptions: the account record itself.
--   * support_sessions: an operator may open and close their OWN sessions.
--   * audit_events, outbox_events: append-only, so a platform action cannot
--     commit without its audit record.
--
-- Usage figures are served by a function that returns COUNTS ONLY. An operator
-- can see that a customer has 37 units; they cannot see a single unit, resident,
-- lease or amount without an authorised support session.

create or replace function app.is_platform_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.auth_user_id = auth.uid() and p.is_platform_operator
  );
$$;

grant execute on function app.is_platform_operator() to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- Account metadata
-- ---------------------------------------------------------------------------
create policy organisations_platform_select on organisations
  for select using (app.is_platform_operator());

create policy organisations_platform_update on organisations
  for update
  using (app.is_platform_operator())
  with check (app.is_platform_operator());

create policy subscriptions_platform_select on subscriptions
  for select using (app.is_platform_operator());

create policy subscriptions_platform_update on subscriptions
  for update
  using (app.is_platform_operator())
  with check (app.is_platform_operator());

create policy subscriptions_platform_insert on subscriptions
  for insert with check (app.is_platform_operator());

-- ---------------------------------------------------------------------------
-- Support sessions
-- ---------------------------------------------------------------------------
-- An operator may open a session only in their own name, and only read-only.
-- They cannot grant a session to someone else, and cannot create a writable one.
create policy support_sessions_platform_insert on support_sessions
  for insert
  with check (
    app.is_platform_operator()
    and operator_user_id = auth.uid()
    and read_only = true
  );

-- An operator may close their own session. Revoking is the only field that
-- matters here; the customer can also revoke, via support_sessions_org_revoke.
create policy support_sessions_platform_update on support_sessions
  for update
  using (app.is_platform_operator() and operator_user_id = auth.uid())
  with check (app.is_platform_operator() and operator_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Audit and outbox
-- ---------------------------------------------------------------------------
-- Append-only. A platform action must never be able to commit without the audit
-- record that explains it, so the insert has to succeed; reading remains closed.
create policy audit_events_platform_insert on audit_events
  for insert with check (app.is_platform_operator());

create policy outbox_events_platform_insert on outbox_events
  for insert with check (app.is_platform_operator());

-- An operator can read the audit trail of their OWN actions, so support work is
-- reviewable. They cannot read the customer's own operational audit history.
create policy audit_events_platform_own_select on audit_events
  for select
  using (app.is_platform_operator() and actor_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Usage metering: counts only, never content
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because the counts span tables the operator deliberately
-- cannot read. The function returns scalars; there is no column through which a
-- name, an amount or an identifier of a customer record could escape.
create or replace function app.platform_customer_usage()
returns table (
  organisation_id uuid,
  billable_units integer,
  member_count integer,
  active_leases integer,
  document_bytes bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id,
    (select count(*)::integer from public.units u
      where u.organisation_id = o.id and u.status = 'active'),
    (select count(*)::integer from public.memberships m
      where m.organisation_id = o.id and m.status = 'active'),
    (select count(*)::integer from public.leases l
      where l.organisation_id = o.id and l.status in ('active', 'notice_given')),
    (select coalesce(sum(d.byte_size), 0)::bigint from public.documents d
      where d.organisation_id = o.id and d.deleted_at is null)
  from public.organisations o
  -- The gate: a caller who is not a platform operator gets an empty set.
  where app.is_platform_operator();
$$;

grant execute on function app.platform_customer_usage() to propertyos_app;

-- Service health, likewise counts only.
create or replace function app.platform_health()
returns table (
  queued_jobs integer, running_jobs integer, dead_jobs integer,
  unpublished_outbox integer, oldest_unpublished timestamptz,
  failed_notifications integer, undelivered_notifications integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select count(*)::integer from public.jobs where status = 'queued'),
    (select count(*)::integer from public.jobs where status = 'running'),
    (select count(*)::integer from public.jobs where status = 'dead'),
    (select count(*)::integer from public.outbox_events where published_at is null),
    (select min(occurred_at) from public.outbox_events where published_at is null),
    (select count(*)::integer from public.notifications where status = 'failed'),
    (select count(*)::integer from public.notifications where status = 'development_sink')
  where app.is_platform_operator();
$$;

grant execute on function app.platform_health() to propertyos_app;
