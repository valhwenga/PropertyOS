-- ---------------------------------------------------------------------------
-- 0087  A notice reaches somebody
-- ---------------------------------------------------------------------------
--
-- The product has written notices to people for eighty-six migrations and
-- delivered almost none of them, in two different ways, both of which this
-- file makes impossible rather than merely discouraged.
--
-- **An in-app notice with no `recipient_user_id` is unreadable.** The inbox
-- reads `where recipient_user_id = <the signed-in person>`, so a notice
-- without one is a row no human being can ever reach. The worker's `notify`
-- handler has written exactly that for five event types — a receipt
-- allocation, a resident's proof of payment, a maintenance request, and the
-- two Spike support-access notices — and recorded each as `sent`. Not queued,
-- not undelivered: **sent**. The worst state in the table, because every
-- screen and every alert believes it.
--
-- **And the body was the template, placeholders and all.** The five templates
-- those events use carry `{{reference}}`, `{{amount}}`, `{{resident_name}}`;
-- nothing in this product has ever substituted one. A resident would have
-- read "Maintenance request {{reference}} has been logged".
--
-- So: a check constraint for each, and the existing rows cleaned out. The
-- rows being deleted are the unreadable ones — nobody has seen them, by
-- definition, so nothing is being taken away from anybody.
--
-- Two smaller corrections of the same kind.
--
-- **Two seeded templates contain a literal backslash-n** rather than a
-- newline — two characters, `\` and `n`, sitting in an email body since 0008.
-- Nothing had rendered them, so nobody had seen it.
--
-- **A receipt allocation was borrowing the statement template**, so applying a
-- payment to somebody's account would have told them their statement was
-- ready. It gets its own wording.
--
-- And the alert that counts undelivered messages is widened, because the
-- delivery pass this slice adds moves every undelivered email from `queued` to
-- `development_sink` — which would have quietly emptied the alert while
-- nothing was being delivered at all.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- What a template expects
-- ---------------------------------------------------------------------------

alter table notification_templates
  add column if not exists variables text[] not null default '{}';

comment on column notification_templates.variables is
  'The placeholder names this template requires, derived from its own text. '
  'The renderer refuses a notice with any of them unresolved, so a declared '
  'variable is a promise the dispatcher has to keep.';

-- Derived from the text rather than typed out beside it: a list maintained by
-- hand next to the thing it describes is a list that drifts.
update notification_templates t
   set variables = coalesce((
         select array_agg(distinct m[1] order by m[1])
           from regexp_matches(coalesce(t.subject, '') || ' ' || t.body,
                               '\{\{([a-z_]+)\}\}', 'g') as m
       ), '{}');

-- ---------------------------------------------------------------------------
-- The two literal backslash-n bodies, and one borrowed template
-- ---------------------------------------------------------------------------

-- `like '%\n%'` would mean "contains the letter n": a backslash is LIKE's own
-- escape character. Asked by position instead, which has no escaping to get
-- wrong.
update notification_templates
   set body = replace(body, '\n', E'\n')
 where position('\n' in body) > 0;

insert into notification_templates (key, channel, subject, body, variables) values
  ('receipt.allocated', 'in_app', 'A payment was applied to your account',
   E'We applied {{amount}} to your account.\n\n'
   'Your statement in the portal shows what it was applied to and what is '
   'still outstanding.',
   array['amount'])
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The rows nobody could read
-- ---------------------------------------------------------------------------

-- Counted before they go, in the migration's own output, because a delete in a
-- migration should say how much it deleted.
do $$
declare
  unreadable integer;
  unrendered integer;
begin
  select count(*) into unreadable
    from notifications where channel = 'in_app' and recipient_user_id is null;
  select count(*) into unrendered
    from notifications where body like '%{{%' or subject like '%{{%';
  raise notice '0087: deleting % unreadable in-app notices and % with unresolved placeholders',
    unreadable, unrendered;
end $$;

-- Order matters: the dunning steps and nothing else reference a notification.
update subscription_dunning_steps
   set notification_id = null
 where notification_id in (
   select id from notifications
    where (channel = 'in_app' and recipient_user_id is null)
       or body like '%{{%' or subject like '%{{%'
 );

delete from notifications
 where (channel = 'in_app' and recipient_user_id is null)
    or body like '%{{%'
    or subject like '%{{%';

-- ---------------------------------------------------------------------------
-- And now it cannot happen again
-- ---------------------------------------------------------------------------

alter table notifications
  add constraint in_app_notice_has_a_reader check (
    channel <> 'in_app' or recipient_user_id is not null
  );

comment on constraint in_app_notice_has_a_reader on notifications is
  'The inbox reads by recipient_user_id, so an in-app notice without one is a '
  'row no person can reach. Writing one is a bug, not a state.';

alter table notifications
  add constraint notice_is_rendered check (
    body not like '%{{%' and (subject is null or subject not like '%{{%')
    and (title is null or title not like '%{{%')
  );

comment on constraint notice_is_rendered on notifications is
  'An unsubstituted placeholder reaching a person is worse than no message: '
  'the renderer refuses, so nothing should ever get this far.';

-- An email notice needs an address to be delivered to. A notice recorded with
-- neither an address nor a reader is addressed to nobody at all.
alter table notifications
  add constraint notice_is_addressed check (
    recipient_user_id is not null
    or recipient_email is not null
    or recipient_resident_id is not null
  );

-- ---------------------------------------------------------------------------
-- Writing the same notice twice
-- ---------------------------------------------------------------------------
--
-- The old handler used `provider_message_id` as its idempotency key, holding
-- `outbox-<id>`. That column is the PROVIDER's id for the message, and an
-- email notice needs it for exactly that once it is delivered — so the key and
-- the receipt were the same column and the second would have overwritten the
-- first. A key of our own, and a unique index rather than a look-before-insert,
-- because the worker can redeliver the same event to two passes at once.

alter table notifications add column if not exists dedupe_key text;

comment on column notifications.dedupe_key is
  'Our own key for "this notice has already been written", distinct from the '
  'provider''s message id. One per recipient per event.';

-- Nulls are distinct in a unique index, so every notice written by something
-- that has no key of its own is unaffected.
create unique index if not exists notifications_dedupe_idx
  on notifications (organisation_id, dedupe_key);

-- The delivery pass reads exactly this set, every minute of the day.
create index if not exists notifications_awaiting_delivery_idx
  on notifications (created_at)
  where channel = 'email' and status = 'queued';

-- ---------------------------------------------------------------------------
-- The alert has to keep meaning what it says
-- ---------------------------------------------------------------------------
--
-- `development_sink` is the honest record of "the adapter took it and threw it
-- away because no provider is configured". Before the delivery pass existed
-- nothing produced it in bulk; now every undelivered message lands there, so
-- an alert that counted only `queued` and `failed` would have reported all
-- clear for a product delivering nothing.

create or replace function app.notification_backlog_states() returns text[]
language sql immutable as $$
  select array['queued', 'failed', 'development_sink']
$$;

comment on function app.notification_backlog_states() is
  'The notification statuses that mean nobody received it. Named once so the '
  'alert and the console cannot drift apart.';

-- And the condition itself, recreated with that one line changed. Repeated in
-- full because a SQL function has no patch: the only honest way to change one
-- rung of it is to state the whole ladder again.

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
  having count(*) > 0;
$function$;
