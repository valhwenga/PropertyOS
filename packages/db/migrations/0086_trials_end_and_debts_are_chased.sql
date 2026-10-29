-- ---------------------------------------------------------------------------
-- 0086  Trials end, and debts are chased
-- ---------------------------------------------------------------------------
--
-- Two holes, both of them revenue.
--
-- **A trial never ended.** `runSubscriptionBilling` skips an organisation whose
-- status is `trial`, with no date anywhere saying when that stops being true —
-- so every customer ever provisioned is free for ever until somebody
-- remembers to change a dropdown. Nothing in the product has ever told
-- anybody to.
--
-- **Nothing chased an unpaid invoice.** The overdue alert from 0030 counts
-- them, which is a start and is not chasing. A landlord who does not pay stays
-- on the product indefinitely, and the only lever is an operator suspending
-- them by hand with no connection to the invoice that prompted it.
--
-- Three decisions.
--
-- **A trial has an end date, and the date is what counts.** Not the status: a
-- status says what somebody last set, a date says what is true. The billing
-- run bills a customer whose trial has ended and moves them to `active` as
-- part of that run, recorded with the reason, so it is a status change caused
-- by a commercial event rather than a silent flip.
--
-- **Reminders are automatic; suspension is not.** A reminder is a message, and
-- the worker can send those on a cadence. Suspension stops a landlord reaching
-- their own tenancy records, which ADR 0017 treats as serious and which this
-- product has consistently refused to automate — so the ladder PROPOSES it and
-- a person decides, the same division as preparing and submitting a debit
-- order.
--
-- **A step is taken once.** `subscription_dunning_steps` is keyed on the
-- invoice and the step, so a worker pass that runs every five minutes cannot
-- send four reminders an hour. That is enforced by a unique index rather than
-- by the pass remembering.

insert into platform_settings (
  key, name, description, value_type, default_value, min_value, max_value,
  per_organisation, customer_visible, sort
) values
  ('trial.length_days', 'How long a trial lasts',
   'Days from sign-up before a customer is charged. Existing trials are measured from '
   || 'the day the account was created. Nothing happens automatically on the last day: '
   || 'the next billing run charges them and moves them to active, and the console says '
   || 'which trials have ended.',
   'integer', '30', 0, 365, false, false, 40),

  ('dunning.first_reminder_days', 'First reminder after',
   'Days past an invoice''s due date before the first reminder is recorded.',
   'integer', '3', 1, 90, false, false, 41),

  ('dunning.final_notice_days', 'Final notice after',
   'Days past the due date before a final notice is recorded.',
   'integer', '10', 1, 180, false, false, 42),

  ('dunning.suspend_days', 'Propose suspension after',
   'Days past the due date before the account is proposed for suspension. Nothing is '
   || 'suspended automatically: it appears on the chasing screen for somebody to decide, '
   || 'because suspension stops a landlord reaching their own records.',
   'integer', '21', 1, 365, false, false, 43);

-- ---------------------------------------------------------------------------
-- When the trial ends
-- ---------------------------------------------------------------------------

alter table subscriptions add column trial_ends_on date;

comment on column subscriptions.trial_ends_on is
  'The day a trial stops being free. Null for a subscription that was never on '
  'trial. The billing run reads this rather than a status, because a date says '
  'what is true and a status says what somebody last set.';

-- Existing trials, measured from the day the account was created, which is the
-- only honest answer available: nothing has ever recorded a trial start.
update subscriptions s
   set trial_ends_on = (o.created_at + make_interval(days => 30))::date
  from organisations o
 where o.id = s.organisation_id
   and s.status = 'trialing'
   and s.trial_ends_on is null;

create index subscriptions_trial_ending_idx
  on subscriptions (trial_ends_on) where status = 'trialing';

-- ---------------------------------------------------------------------------
-- Chasing what is owed
-- ---------------------------------------------------------------------------

create table subscription_dunning_steps (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null references subscription_invoices (id) on delete cascade,
  organisation_id uuid not null references organisations (id) on delete cascade,
  step            text not null,
  days_overdue    integer not null,
  taken_at        timestamptz not null default now(),
  -- Null for the steps the worker takes by itself: a reminder is a message and
  -- nobody decided it. Set for the ones a person decided.
  taken_by        uuid references auth.users (id),
  note            text,
  notification_id uuid references notifications (id) on delete set null,
  constraint dunning_step_is_known check (
    step in ('first_reminder', 'final_notice', 'suspension_proposed', 'suspended', 'written_off')
  ),
  constraint dunning_days_are_real check (days_overdue >= 0)
);

comment on table subscription_dunning_steps is
  'What has been done about an unpaid invoice, one row per step. Keyed so that '
  'a step happens once however often the chasing pass runs.';

-- The whole protection against a worker pass that runs every five minutes
-- sending four reminders an hour.
create unique index subscription_dunning_steps_once_idx
  on subscription_dunning_steps (invoice_id, step);

create index subscription_dunning_steps_organisation_idx
  on subscription_dunning_steps (organisation_id, taken_at desc);

alter table subscription_dunning_steps enable row level security;

grant select on subscription_dunning_steps to propertyos_app;
grant select, insert on subscription_dunning_steps to propertyos_worker;

-- The customer sees what has been done about their own unpaid invoice. Being
-- chased and not knowing it is how a suspension arrives as a surprise.
create policy subscription_dunning_steps_customer_select on subscription_dunning_steps
  for select using (app.has_permission(organisation_id, 'organisation.settings.manage'));

create policy subscription_dunning_steps_platform_select on subscription_dunning_steps
  for select using (app.is_platform_operator());

-- Recording a step runs on the privileged connection: the worker does it on a
-- cadence with no session at all, and the operator actions that record one go
-- through a command that checked a platform permission in SQL first.

-- ---------------------------------------------------------------------------
-- Two more things worth being told about
-- ---------------------------------------------------------------------------
--
-- Both of them wait on a person, which is exactly what an alert is for.

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
  select 'jobs.dead', 'critical',
         count(*) || ' background job' || case when count(*) = 1 then '' else 's' end
           || ' given up on',
         'The worker exhausted its retries. Nothing will run them again until '
           || 'somebody decides to.',
         '/platform/jobs'
  from public.jobs where status = 'dead'
  having count(*) > 0

  union all
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
  -- New: a trial that has run out. Every day this is true is a day of free
  -- service nobody decided to give.
  select 'trials.ended', 'warning',
         count(*) || ' trial' || case when count(*) = 1 then ' has' else 's have' end
           || ' ended',
         'They are past the end of their trial and are not being charged. The next '
           || 'billing run will charge them and move them to active.',
         '/platform/chasing'
  from public.subscriptions s
  join public.organisations o on o.id = s.organisation_id
  where s.status = 'trialing' and s.trial_ends_on <= current_date
    and o.status not in ('closed', 'suspended')
  having count(*) > 0

  union all
  -- New: the ladder has run out of automatic steps and is waiting on somebody.
  select 'dunning.waiting', 'critical',
         count(*) || ' account' || case when count(*) = 1 then '' else 's' end
           || ' proposed for suspension',
         'They have been reminded and given final notice and still have not paid. '
           || 'Suspending them is a decision for a person.',
         '/platform/chasing'
  from public.subscription_dunning_steps d
  join public.subscription_invoices i on i.id = d.invoice_id
  where d.step = 'suspension_proposed'
    and i.status = 'issued'
    and not exists (
      select 1 from public.subscription_dunning_steps later
      where later.invoice_id = d.invoice_id and later.step in ('suspended', 'written_off')
    )
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
  select 'signups.waiting', 'warning',
         count(*) || ' account request' || case when count(*) = 1 then '' else 's' end
           || ' unanswered for more than a day',
         'They asked through the public form and have heard nothing back.',
         '/platform/signups'
  from public.signup_requests
  where status = 'open' and created_at < now() - interval '24 hours'
  having count(*) > 0

  union all
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
         'Issued, unpaid and being chased. The chasing screen says how far each '
           || 'one has got.',
         '/platform/chasing'
  from public.subscription_invoices
  where status = 'issued' and due_date < current_date
  having count(*) > 0;
$$;

grant execute on function app.platform_alert_conditions() to propertyos_worker;
