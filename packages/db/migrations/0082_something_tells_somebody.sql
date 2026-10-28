-- ---------------------------------------------------------------------------
-- 0082  Something tells somebody
-- ---------------------------------------------------------------------------
--
-- Every signal this product has is a screen that somebody has to remember to
-- open. The dead job count, the audit trail, the queue, a landlord locked out
-- whom only Spike can let back in, a closed customer whose retention date has
-- passed, an invoice nobody chased: all of them sit there, correct and
-- unread. A pilot does not fail because the numbers were wrong. It fails
-- because the first dead billing job was discovered three weeks later.
--
-- Four decisions.
--
-- **The conditions are defined once, in SQL.** The console reads them, the
-- worker raises them and the tests assert them from the same function. A
-- threshold written twice is a threshold that will disagree with itself, and
-- the one that matters most — "the worker may be gone" — is the one nobody
-- would notice disagreeing.
--
-- **An alert nobody can quieten is an alert people stop reading.** So a
-- condition can be silenced, with a reason and an expiry, by somebody who
-- holds the permission to act on it. Silenced is not hidden: it still appears
-- in the list, greyed, with who silenced it and until when. Hiding it would
-- recreate the problem one level down.
--
-- **Raising and delivering are separate.** The worker raises a notice per
-- recipient and then tries to send it; what happened to the attempt is on the
-- notice. With no mail provider configured, the notices accumulate as
-- undelivered with the reason on each one, which is the honest state — rather
-- than a product that believes it has told somebody.
--
-- **It repeats, rather than firing once.** A condition that is still true
-- tomorrow is still worth saying tomorrow, and a single notice at 02:00 that
-- nobody opened is how an outage lasts a week. The repeat window is a setting;
-- silencing is how you stop it on purpose.

insert into platform_settings (
  key, name, description, value_type, default_value, min_value, max_value,
  per_organisation, customer_visible, sort
) values
  ('alerts.repeat_hours', 'Say it again after',
   'Hours before a condition that is still true raises another notice. Silencing '
   || 'an alert is how you stop it deliberately; this is how often an unsilenced one '
   || 'comes back.',
   'integer', '24', 1, 168, false, false, 30),

  ('alerts.queue_stuck_minutes', 'Call the queue stuck after',
   'Minutes a job may sit waiting before the queue is treated as stuck rather than '
   || 'busy. A long queue whose oldest entry is recent is a busy worker; a long queue '
   || 'whose oldest entry is from yesterday is no worker at all.',
   'integer', '10', 1, 1440, false, false, 31),

  ('alerts.backlog_threshold', 'Backlog worth mentioning',
   'How many unpublished outbox events, or undelivered messages, count as a backlog '
   || 'rather than ordinary in-flight work.',
   'integer', '50', 1, 10000, false, false, 32);

-- ---------------------------------------------------------------------------
-- What is wrong, right now
-- ---------------------------------------------------------------------------
--
-- Unguarded and granted narrowly: the worker connects as its own role and has
-- no `auth.uid()`, so a guard on `is_platform_operator()` here would mean the
-- one process that can act on a schedule is the one that cannot read the
-- conditions. The guard lives on `app.platform_alerts()` below, which is what
-- the application role may call.
--
-- Every row is a condition that is TRUE. An empty result is the good state and
-- the screens say so in those words.

create or replace function app.platform_alert_conditions()
returns table (
  alert_key text,
  severity  text,
  summary   text,
  detail    text,
  href      text
)
language sql
stable
security definer
set search_path = ''
as $$
  -- Work the worker gave up on. Critical because nothing retries it and the
  -- customer asked for whatever it was.
  select 'jobs.dead', 'critical',
         count(*) || ' background job' || case when count(*) = 1 then '' else 's' end
           || ' given up on',
         'The worker exhausted its retries. Nothing will run them again until '
           || 'somebody decides to.',
         '/platform/jobs'
  from public.jobs where status = 'dead'
  having count(*) > 0

  union all
  -- A worker that died holding jobs. The most important condition here: it
  -- means nothing at all is being processed.
  select 'worker.stalled', 'critical',
         count(*) || ' job' || case when count(*) = 1 then '' else 's' end
           || ' claimed and never returned',
         'A worker took these and stopped. Until one restarts and reclaims them, '
           || 'they are neither running nor queued.',
         '/platform/jobs'
  from public.jobs
  where status = 'running' and locked_at < now() - interval '15 minutes'
  having count(*) > 0

  union all
  select 'queue.stuck', 'critical',
         'The oldest queued job has been waiting since '
           || to_char(min(run_after), 'YYYY-MM-DD HH24:MI'),
         'A busy worker does not leave work this long. Check that the worker '
           || 'process is running before running anything again.',
         '/platform/jobs'
  from public.jobs
  where status = 'queued'
  having min(run_after) < now()
    - make_interval(mins => app.setting_number('alerts.queue_stuck_minutes'))

  union all
  -- Somebody is locked out of their own records and nobody at their own
  -- organisation can let them back in.
  select 'recovery.waiting', 'critical',
         count(*) || ' recovery request' || case when count(*) = 1 then '' else 's' end
           || ' only Spike can decide',
         'Somebody cannot sign in and has no colleague who can confirm who they '
           || 'are. Until this is decided they have no way into their own records.',
         '/platform/recoveries'
  from public.recovery_requests r
  where r.status = 'open'
    and r.auth_user_id is not null
    and not app.recovery_other_admin_exists(r.auth_user_id)
  having count(*) > 0

  union all
  select 'outbox.backlog', 'warning',
         count(*) || ' events not yet queued',
         'The outbox is being drained slower than it is filling, or not at all.',
         '/platform/jobs'
  from public.outbox_events where published_at is null
  having count(*) > app.setting_number('alerts.backlog_threshold')

  union all
  select 'notifications.undelivered', 'warning',
         count(*) || ' messages undelivered',
         'Queued or failed. Nobody they were written for has received them.',
         '/platform/jobs'
  from public.notifications where status in ('queued', 'failed')
  having count(*) > app.setting_number('alerts.backlog_threshold')

  union all
  -- An account request nobody has answered. A landlord who asked for an
  -- account and heard nothing has already formed a view of the product.
  select 'signups.waiting', 'warning',
         count(*) || ' account request' || case when count(*) = 1 then '' else 's' end
           || ' unanswered for more than a day',
         'They asked through the public form and have heard nothing back.',
         '/platform/signups'
  from public.signup_requests
  where status = 'open' and created_at < now() - interval '24 hours'
  having count(*) > 0

  union all
  -- Records Spike said it would destroy and has not. A retention date that
  -- passes silently is the kind of promise that is only noticed when somebody
  -- asks to see the policy.
  select 'retention.due', 'warning',
         count(*) || ' closed customer' || case when count(*) = 1 then '' else 's' end
           || ' past their retention date',
         'Their records may now be destroyed. Nothing happens on its own: '
           || 'somebody has to decide.',
         '/platform'
  from public.organisation_closures
  where destroyed_at is null and retain_until <= current_date
  having count(*) > 0

  union all
  select 'billing.overdue', 'warning',
         count(*) || ' invoice' || case when count(*) = 1 then '' else 's' end
           || ' past their due date',
         'Issued, unpaid and nobody has chased them. Outstanding here means '
           || '"not recorded as received" rather than "unpaid".',
         '/platform/billing'
  from public.subscription_invoices
  where status = 'issued' and due_date < current_date
  having count(*) > 0;
$$;

comment on function app.platform_alert_conditions() is
  'Every platform condition that is true right now, one row each. Unguarded '
  'and granted narrowly: the worker has no auth.uid() and must be able to read '
  'these on a schedule. app.platform_alerts() is the guarded way in.';

grant execute on function app.platform_alert_conditions() to propertyos_worker;

-- What an operator may read: the same conditions, behind the same gate as the
-- rest of the console.
create or replace function app.platform_alerts()
returns table (
  alert_key text,
  severity  text,
  summary   text,
  detail    text,
  href      text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.is_platform_operator() then
    raise exception 'Reading platform alerts requires a Spike operator session'
      using errcode = 'insufficient_privilege';
  end if;
  return query select * from app.platform_alert_conditions();
end;
$$;

grant execute on function app.platform_alerts() to propertyos_app;

-- ---------------------------------------------------------------------------
-- Quietening one, on purpose
-- ---------------------------------------------------------------------------

create table platform_alert_silences (
  alert_key      text primary key,
  silenced_until timestamptz not null,
  silenced_by    uuid not null references auth.users (id),
  reason         text not null,
  silenced_at    timestamptz not null default now(),
  constraint silence_reason_says_something check (length(btrim(reason)) >= 5)
);

comment on table platform_alert_silences is
  'Conditions somebody has decided not to be told about again yet, with who '
  'decided and why. Silenced is not hidden: the list still shows them.';

alter table platform_alert_silences enable row level security;
grant select, insert, update, delete on platform_alert_silences to propertyos_app;
grant select on platform_alert_silences to propertyos_worker;

-- Any operator sees what has been silenced. Knowing that somebody silenced the
-- dead-job alert until Friday is exactly the sort of thing a colleague needs.
create policy platform_alert_silences_select on platform_alert_silences
  for select using (app.is_platform_operator());

create policy platform_alert_silences_write on platform_alert_silences
  for insert with check (app.platform_permission('platform.operations.manage'));
create policy platform_alert_silences_update on platform_alert_silences
  for update using (app.platform_permission('platform.operations.manage'))
  with check (app.platform_permission('platform.operations.manage'));
create policy platform_alert_silences_delete on platform_alert_silences
  for delete using (app.platform_permission('platform.operations.manage'));

-- ---------------------------------------------------------------------------
-- What was actually said, to whom, and whether it arrived
-- ---------------------------------------------------------------------------
--
-- One row per recipient per raising, not one per condition: "did anybody
-- actually get told" is the question, and a single row per condition cannot
-- answer it. The delivery outcome lives here rather than in a log, so the
-- console can show an operator that eleven notices were raised and none of
-- them left the building.

create table platform_alert_notices (
  id                uuid primary key default gen_random_uuid(),
  alert_key         text not null,
  severity          text not null,
  summary           text not null,
  raised_at         timestamptz not null default now(),
  recipient_user_id uuid not null references auth.users (id) on delete cascade,
  recipient_email   text not null,
  status            text not null default 'queued',
  provider          text,
  sent_at           timestamptz,
  last_error        text,
  constraint notice_status_is_known
    check (status in ('queued', 'sent', 'undeliverable'))
);

comment on table platform_alert_notices is
  'Alerts that were raised, who they were addressed to, and what happened to '
  'the attempt to deliver them.';

create index platform_alert_notices_recent_idx
  on platform_alert_notices (alert_key, raised_at desc);

alter table platform_alert_notices enable row level security;
grant select on platform_alert_notices to propertyos_app;
grant select, insert, update on platform_alert_notices to propertyos_worker;

create policy platform_alert_notices_select on platform_alert_notices
  for select using (app.platform_permission('platform.operations.manage'));
