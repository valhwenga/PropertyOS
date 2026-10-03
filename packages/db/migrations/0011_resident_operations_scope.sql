-- 0011_resident_operations_scope.sql
-- Residents perform real operational actions: logging a maintenance request,
-- replying on their own ticket, acknowledging or disputing an inspection, and
-- downloading a document shared with them. Each of those writes a child row.
--
-- The policies below are the narrowest grants that make those actions possible.
-- Each is anchored to a lease the resident holds a live portal link for, and
-- none of them grants read access they did not already have.

-- A resident's own ticket transitions. INSERT only: the history is append-only
-- for everyone, and the resident can only write the row that accompanies an
-- action they are themselves permitted to take.
create policy maintenance_ticket_events_resident_insert on maintenance_ticket_events
  for insert
  with check (
    actor_user_id = auth.uid()
    and exists (
      select 1 from maintenance_tickets t
      where t.id = maintenance_ticket_events.ticket_id
        and t.lease_id is not null
        and app.can_access_lease_as_resident(t.lease_id)
    )
  );

-- Acknowledging or disputing a finalised inspection. The resident writes their
-- OWN response row; they still cannot touch inspection_items, so the inspector's
-- submitted record is untouchable.
create policy inspection_acknowledgements_resident_write on inspection_acknowledgements
  for insert
  with check (
    responded_by = auth.uid()
    and exists (
      select 1 from inspections i
      where i.id = inspection_acknowledgements.inspection_id
        and i.lease_id is not null
        and i.status in ('finalised', 'acknowledged', 'disputed')
        and app.can_access_lease_as_resident(i.lease_id)
    )
    and exists (
      select 1 from portal_links pl
      where pl.resident_id = inspection_acknowledgements.resident_id
        and pl.auth_user_id = auth.uid()
        and pl.status = 'active'
        and pl.revoked_at is null
        and pl.expires_at > now()
    )
  );

-- A resident may amend their own response (for example, acknowledging after a
-- dispute is settled), but only their own.
create policy inspection_acknowledgements_resident_update on inspection_acknowledgements
  for update
  using (responded_by = auth.uid())
  with check (responded_by = auth.uid());

create policy inspection_acknowledgements_resident_select on inspection_acknowledgements
  for select
  using (
    exists (
      select 1 from inspections i
      where i.id = inspection_acknowledgements.inspection_id
        and i.lease_id is not null
        and app.can_access_lease_as_resident(i.lease_id)
    )
  );

-- Download grants. Every access to a private object is attributable, including a
-- resident's, so the resident must be able to write the grant row recording
-- their own download. `granted_to = auth.uid()` means they cannot fabricate a
-- grant in someone else's name.
create policy document_access_grants_resident_insert on document_access_grants
  for insert
  with check (
    granted_to = auth.uid()
    and exists (
      select 1 from documents d
      where d.id = document_access_grants.document_id
        and d.organisation_id = document_access_grants.organisation_id
        and d.visibility = 'resident_shared'
        and d.quarantined = false
        and d.scan_status <> 'infected'
        and d.deleted_at is null
        and d.lease_id is not null
        and app.can_access_lease_as_resident(d.lease_id)
    )
  );

-- A resident attaching a photo to their own request.
create policy maintenance_attachments_resident_insert on maintenance_attachments
  for insert
  with check (
    audience = 'resident_visible'
    and exists (
      select 1 from maintenance_tickets t
      where t.id = maintenance_attachments.ticket_id
        and t.lease_id is not null
        and app.can_access_lease_as_resident(t.lease_id)
    )
  );

-- A resident uploading their own proof of payment or request photo. The document
-- is created `internal` and quarantined by the application; this policy only
-- allows the row to exist, and the quarantine check constraint still governs
-- whether it can ever be shared.
create policy documents_resident_insert on documents
  for insert
  with check (
    uploaded_by = auth.uid()
    and visibility = 'internal'
    and quarantined = true
    and lease_id is not null
    and app.can_access_lease_as_resident(lease_id)
    and classification in ('proof_of_payment', 'maintenance')
  );
