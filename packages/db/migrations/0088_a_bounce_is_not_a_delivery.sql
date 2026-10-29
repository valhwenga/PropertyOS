-- ---------------------------------------------------------------------------
-- 0088  A bounce is not a delivery
-- ---------------------------------------------------------------------------
--
-- 0087 made the notices correct and 0036 gave them a provider. Both stop at
-- the same place: the provider says "accepted", we record `sent`, and that is
-- the last thing this product ever learns about the message.
--
-- Acceptance is not arrival. A provider accepts a message and then finds the
-- mailbox does not exist, or is full, or the recipient marks it as spam — and
-- all of that arrives afterwards, by webhook, at an endpoint that did not
-- exist. So a resident who left two years ago is still sent a rent reminder
-- every month, this product still records it as sent, and the one person who
-- could fix it — the landlord, who has their phone number — is never told.
--
-- Worse, in the aggregate: mail to dead addresses is how a sending domain's
-- reputation is destroyed, and the reputation is shared by every customer on
-- it. One stale tenancy list degrades delivery for everybody.
--
-- Three things here.
--
-- **The lifecycle after acceptance, on the notice itself.** `delivered_at`,
-- `bounced_at`, `complained_at` and the provider's own reason. `status` is
-- left alone when a bounce arrives: the message WAS accepted, and overwriting
-- that record would lose the fact. "Accepted and then bounced" is a different
-- and more useful statement than "failed".
--
-- **A suppression list, keyed on the address.** A hard bounce or a complaint
-- means stop sending there — and reputation is a property of the address and
-- the sending domain, not of the customer whose resident it happens to be, so
-- the list is global. Which is also why no customer may read it: an address
-- can belong to residents of two different landlords, and "this person
-- complained" is not a thing one landlord gets to learn about another's mail.
-- What a landlord may see about their OWN resident is a generalised answer,
-- through one narrow definer function, and nothing else.
--
-- **Nothing is ever deleted from it.** Lifting a suppression is a recorded act
-- with a reason and a person, because somebody will ask, and "we tried again
-- because the landlord said it was fixed" is the answer the postmaster wants
-- when the reputation question comes round.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- What happened to the message after the provider took it
-- ---------------------------------------------------------------------------

alter table notifications
  add column if not exists delivered_at  timestamptz,
  add column if not exists bounced_at    timestamptz,
  add column if not exists complained_at timestamptz,
  add column if not exists bounce_kind   text,
  add column if not exists bounce_detail text;

comment on column notifications.delivered_at is
  'When the provider reported the message was accepted by the receiving '
  'server. Distinct from sent_at, which is only when OUR provider took it.';
comment on column notifications.bounced_at is
  'When it came back. status stays as it was: the message was accepted, and '
  '"accepted and then bounced" says more than "failed".';
comment on column notifications.bounce_kind is
  'hard — the address does not exist or refuses mail permanently. soft — full, '
  'greylisted, temporarily unavailable. complaint — the recipient marked it as '
  'spam. blocked — the receiving server refused us.';

alter table notifications
  add constraint bounce_kind_is_known check (
    bounce_kind is null or bounce_kind in ('hard', 'soft', 'complaint', 'blocked')
  );

create index if not exists notifications_bounced_idx
  on notifications (bounced_at desc) where bounced_at is not null;

-- ---------------------------------------------------------------------------
-- Addresses this product will not send to again
-- ---------------------------------------------------------------------------

create table email_suppressions (
  id                  uuid primary key default gen_random_uuid(),
  address             citext not null,
  kind                text not null,
  -- The provider's own words, which is what an operator needs when a landlord
  -- rings up insisting the address is fine.
  reason              text not null,
  first_suppressed_at timestamptz not null default now(),
  last_event_at       timestamptz not null default now(),
  events              integer not null default 1,
  -- Where it came from. For the platform console only: see the policies below.
  notification_id     uuid references notifications (id) on delete set null,
  organisation_id     uuid references organisations (id) on delete set null,
  -- Lifted rather than deleted.
  lifted_at           timestamptz,
  lifted_by           uuid references auth.users (id),
  lifted_reason       text,
  constraint suppression_kind_is_known check (
    kind in ('hard_bounce', 'complaint', 'blocked', 'manual')
  ),
  constraint lifting_is_recorded check (
    (lifted_at is null and lifted_by is null and lifted_reason is null)
    or (lifted_at is not null and lifted_by is not null and length(trim(lifted_reason)) >= 5)
  )
);

comment on table email_suppressions is
  'Addresses that must not be emailed: a hard bounce, a spam complaint, or a '
  'receiving server refusing us. Global by address, because a sending '
  'reputation is shared by every customer on the domain.';

-- One live suppression per address; a lifted one stays as history, and the
-- same address can be suppressed again afterwards.
create unique index email_suppressions_live_idx
  on email_suppressions (address) where lifted_at is null;

create index email_suppressions_recent_idx on email_suppressions (last_event_at desc);

alter table email_suppressions enable row level security;

grant select on email_suppressions to propertyos_app;
grant select, insert, update on email_suppressions to propertyos_worker;

-- Spike's operators, who answer the ticket. No customer policy at all: this
-- table says what an address did across every customer on the platform, and
-- a landlord reading another landlord's complaint is exactly the leak this
-- design exists to avoid. What a customer may learn is below.
create policy email_suppressions_platform_select on email_suppressions
  for select using (app.is_platform_operator());

-- Lifting runs on the privileged connection, through a domain function that
-- checks a platform permission in SQL first. There is deliberately no update
-- policy for the application role.

-- ---------------------------------------------------------------------------
-- What a landlord may learn about their own resident
-- ---------------------------------------------------------------------------
--
-- The generalised answer and nothing else. A landlord needs to know that an
-- address they hold is undeliverable, so that they ring the person instead of
-- reminding a dead mailbox for a year. They do not need to know that the
-- person complained about somebody else's mail, so a complaint is reported as
-- "asked not to receive", which is true, actionable, and names nobody.
--
-- Scoped to addresses on that organisation's own residents: an arbitrary
-- address cannot be tested through this function, which would make it an
-- oracle for "has this person ever complained".

create or replace function app.resident_addresses_in_trouble(p_organisation_id uuid)
returns table (address citext, trouble text, since timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.address,
         case when s.kind = 'complaint' then 'asked_not_to_receive'
              else 'undeliverable' end,
         s.first_suppressed_at
    from public.email_suppressions s
   where s.lifted_at is null
     and app.has_permission(p_organisation_id, 'resident.read')
     and exists (
       select 1 from public.resident_profiles r
        where r.organisation_id = p_organisation_id
          and r.email = s.address
     )
   order by s.first_suppressed_at desc
$$;

comment on function app.resident_addresses_in_trouble(uuid) is
  'The generalised reason an address on one of this organisation''s residents '
  'cannot be emailed. Returns nothing for an address that is not theirs, so it '
  'cannot be used to ask whether a stranger has complained.';

grant execute on function app.resident_addresses_in_trouble(uuid) to propertyos_app;

-- ---------------------------------------------------------------------------
-- Somebody has to be told
-- ---------------------------------------------------------------------------
--
-- A bounce nobody looks at is the same as no bounce. The condition is
-- deliberately about the RECENT ones: a suppression list that grows to two
-- hundred over three years is not an emergency, and twelve new ones this week
-- means somebody imported a stale tenancy list or the sending domain is in
-- trouble.

insert into platform_settings (
  key, name, description, value_type, default_value, min_value, max_value,
  per_organisation, customer_visible, sort
) values (
  'alerts.bounce_threshold',
  'New undeliverable addresses before an alert',
  'How many addresses may start bouncing in a week before Spike is told. '
  'Mail to dead addresses is how a sending domain''s reputation is lost, and '
  'the reputation is shared by every customer on it.',
  'integer', '5', 1, 1000, false, false, 760
)
on conflict (key) do nothing;

-- And the condition itself, stated again in full, because a SQL function has
-- no patch. Twelve conditions now.

CREATE OR REPLACE FUNCTION app.platform_alert_conditions()
 RETURNS TABLE(alert_key text, severity text, summary text, detail text, href text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
         'Queued, failed, or taken by the sink because no provider is configured. Nobody they were written for has received them.',
         '/platform/jobs'
  from public.notifications where status = any (app.notification_backlog_states())
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
  having count(*) > 0

  union all
  -- Addresses that started bouncing in the last week. Recent rather than
  -- total: a list that grew to two hundred over three years is housekeeping,
  -- and twelve this week is somebody importing a stale tenancy list or a
  -- sending domain in trouble.
  select 'email.bouncing', 'warning',
         count(*) || ' address' || case when count(*) = 1 then '' else 'es' end
           || ' stopped accepting mail this week',
         'Mail to dead addresses is how a sending domain''s reputation is lost, '
           || 'and every customer shares it. Nothing is sent to them now.',
         '/platform/jobs'
  from public.email_suppressions
  where lifted_at is null and first_suppressed_at > now() - interval '7 days'
  having count(*) > app.setting_number('alerts.bounce_threshold');
$function$;
