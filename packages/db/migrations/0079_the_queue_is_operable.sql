-- ---------------------------------------------------------------------------
-- 0079  The queue is something you can act on
-- ---------------------------------------------------------------------------
--
-- `failJob` has moved exhausted work to `dead` since the worker was written,
-- and the platform home page counts those rows under "Failed jobs — needs an
-- operator to inspect". There was nothing to inspect with. The count was the
-- whole feature: no list, no error text, no payload, no way to run one again.
-- At pilot, the first dead job means somebody opening a database connection.
--
-- Three decisions.
--
-- **Jobs are keyed on membership, and an operator is a member of nothing**, so
-- `jobs_select` returns them nothing at all — which is why the health counts
-- come from a definer function. The queue needs real policies rather than
-- another counting function, because an operator has to read the error text
-- and the payload to tell a broken handler from a broken database.
--
-- **A dead job that will never run gets a status, not a deletion.** Deleting
-- it loses the evidence; leaving it dead keeps a count nobody can clear, and a
-- permanent red number is a number people stop reading. `abandoned` says a
-- person decided, and carries who and why.
--
-- **Running a job again is not Spike choosing what happens.** The handler was
-- queued by the customer's own action and does what it was always going to do;
-- the operator decides only WHETHER it runs, and that decision is audited
-- against the customer it affects. What they cannot do is edit a payload —
-- there is no path here that changes what a job will do.

insert into platform_permissions (key, description) values
  ('platform.operations.manage',
   'Inspect the job queue, run failed work again, and abandon what will never run');

-- Given to support as well as to administrators on purpose: a queue that
-- backs up is firefighting, the person awake is usually support, and the
-- decision available here is only whether work the customer already asked for
-- runs. It changes nothing commercial, which is the line the support role is
-- otherwise drawn on.
insert into platform_role_permissions (role_key, permission_key) values
  ('platform_admin', 'platform.operations.manage'),
  ('platform_support', 'platform.operations.manage');

-- ---------------------------------------------------------------------------
-- A decision somebody made
-- ---------------------------------------------------------------------------
alter table jobs drop constraint jobs_status_check;
alter table jobs add constraint jobs_status_check check (
  status in ('queued', 'running', 'succeeded', 'failed', 'dead', 'abandoned')
);

alter table jobs
  add column decided_by     uuid references auth.users (id),
  add column decided_at     timestamptz,
  add column decision_reason text;

comment on column jobs.decision_reason is
  'Why an operator ran this job again or abandoned it. Null for every job the '
  'worker has handled on its own, which is almost all of them.';

-- The worker claims `status = 'queued'` and nothing else, so an abandoned job
-- is inert without a line of worker code changing. Asserted here because that
-- is the kind of thing a later reader has to take on trust otherwise.
create index jobs_dead_idx on jobs (status, created_at desc)
  where status in ('dead', 'abandoned');

-- ---------------------------------------------------------------------------
-- What an operator may see and do
-- ---------------------------------------------------------------------------
--
-- Read and act are the same permission. The payload and the error text are
-- what tells a broken handler from a broken database, so an operator who may
-- look is already an operator who may diagnose; splitting the two would have
-- produced a role that can see a failure and not clear it.
--
-- The payload is identifiers and amounts — `emitEvent` has required that since
-- it was written, and the job payload is the outbox payload — so this exposes
-- no resident name, balance or document to somebody outside the organisation.
create policy jobs_platform_select on jobs
  for select using (app.platform_permission('platform.operations.manage'));

create policy jobs_platform_update on jobs
  for update
  using (app.platform_permission('platform.operations.manage'))
  with check (app.platform_permission('platform.operations.manage'));

-- `job_attempts_none` denies everybody, which was right while nothing read it.
-- The attempt history is the difference between "it failed" and "it failed the
-- same way five times", so an operator diagnosing needs it.
create policy job_attempts_platform_select on job_attempts
  for select using (app.platform_permission('platform.operations.manage'));

-- The backlog an operator has to see when the worker is behind: these are
-- Spike's own plumbing rather than customer records, and both already carry
-- organisation-keyed policies for the customer's side.
create policy outbox_events_platform_select on outbox_events
  for select using (app.platform_permission('platform.operations.manage'));

grant select on job_attempts to propertyos_app;

select app.assert_table_privileges();
