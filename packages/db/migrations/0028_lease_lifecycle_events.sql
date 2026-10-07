-- 0028_lease_lifecycle_events.sql
-- Why a lease ended or was extended, kept as a record rather than an edit.
--
-- leases already has closed_at and cancellation_reason, but those are a single
-- current value: extend a lease twice and the first reason is gone. A lease is
-- a contract, and what happened to it and why is exactly what someone asks
-- about a year later, so each change is appended rather than overwritten.
--
-- The row is written in the same transaction as the change it describes. A
-- lease cannot be ended without a reason being recorded, because the command
-- writes both or neither.

create type app.lease_lifecycle_kind as enum ('terminated', 'extended');

create table lease_lifecycle_events (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references organisations(id),
  lease_id          uuid not null,
  kind              app.lease_lifecycle_kind not null,
  reason            text not null,
  -- For a termination, the day the lease ends. For an extension, the new end
  -- date. Both are the date the change takes effect on the lease.
  effective_date    date not null,
  previous_end_date date,
  previous_status   text not null,
  recorded_at       timestamptz not null default now(),
  recorded_by       uuid references auth.users(id),

  -- Composite: a lifecycle event can never point at another organisation's
  -- lease, enforced by the database rather than by the caller remembering.
  constraint lease_lifecycle_events_lease_fkey
    foreign key (lease_id, organisation_id)
    references leases (id, organisation_id),
  constraint lease_lifecycle_events_reason_not_blank
    check (length(btrim(reason)) >= 3)
);

create index on lease_lifecycle_events (lease_id, recorded_at desc);

alter table lease_lifecycle_events enable row level security;

create policy lease_lifecycle_events_select on lease_lifecycle_events
  for select
  using (app.is_org_member(organisation_id) or app.has_support_access(organisation_id));

create policy lease_lifecycle_events_insert on lease_lifecycle_events
  for insert
  with check (app.is_org_member(organisation_id));

-- A resident may see what happened to their OWN lease. Being told your lease
-- ended, without being told when or why, is worse than not being told.
create policy lease_lifecycle_events_resident_select on lease_lifecycle_events
  for select
  using (app.can_access_lease_as_resident(lease_id));

-- Append-only: the record of why a contract changed is not editable afterwards.
grant select, insert on lease_lifecycle_events to propertyos_app;

select app.assert_table_privileges();
