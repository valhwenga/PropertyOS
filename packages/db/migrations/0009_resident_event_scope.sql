-- 0009_resident_event_scope.sql
-- Residents are not organisation members, but they do perform real actions
-- (submitting payment evidence, logging a maintenance request). Those actions
-- must still produce an audit record and an outbox event in the same
-- transaction, otherwise the write would either fail or — worse — succeed
-- without its audit trail.
--
-- This grants residents append-only access to the audit and outbox tables for
-- the organisations they actually hold a live portal link in, and nothing more.
-- They still cannot READ either table: the existing select policies require
-- organisation membership.

create or replace function app.is_resident_of_organisation(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.portal_links pl
    join public.leases l
      on l.id = pl.lease_id and l.organisation_id = pl.organisation_id
    where pl.auth_user_id = auth.uid()
      and pl.organisation_id = p_org
      and pl.status = 'active'
      and pl.revoked_at is null
      and pl.expires_at > now()
  );
$$;

grant execute on function app.is_resident_of_organisation(uuid)
  to propertyos_app, propertyos_worker;

create policy outbox_events_resident_insert on outbox_events
  for insert
  with check (app.is_resident_of_organisation(organisation_id));

create policy audit_events_resident_insert on audit_events
  for insert
  with check (app.is_resident_of_organisation(organisation_id));

-- A resident may also read the maintenance ticket history for their own ticket,
-- which is the transition timeline shown in the portal.
create policy maintenance_ticket_events_resident_select on maintenance_ticket_events
  for select
  using (
    exists (
      select 1 from maintenance_tickets t
      where t.id = maintenance_ticket_events.ticket_id
        and t.lease_id is not null
        and app.can_access_lease_as_resident(t.lease_id)
    )
  );
