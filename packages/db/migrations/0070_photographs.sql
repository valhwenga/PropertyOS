-- ---------------------------------------------------------------------------
-- 0070  A resident can see the photographs on their own inspection
-- ---------------------------------------------------------------------------
--
-- `inspection_photos` has existed since the operations migration with a
-- member-only read, so a RESIDENT could not see the photographs attached to
-- their own inspection report — and those photographs are the evidence behind
-- a deduction from their deposit, which makes them the last thing that should
-- be visible only to the party making the deduction. The resident's report
-- screen now shows them.
--
-- Nothing else is added here, and that is the point. The first draft of this
-- migration also created a `maintenance_ticket_photos` table so a resident
-- could photograph a leak — and `maintenance_attachments` already existed, with
-- an `audience` column AND a resident insert policy, waiting for a screen that
-- had never been built. A second link table for one job would have been a
-- schema with two answers to the same question. What was missing there was the
-- upload control, not the schema.
--
-- The quarantine rule is left exactly as it is, and it is worth being plain
-- about what it means today: with no malware scanner configured every upload is
-- recorded `skipped_not_configured`, which IS quarantined, and
-- `authoriseDownload` then refuses the file to everybody — the landlord
-- included. The screens say so in those words rather than offering a link that
-- cannot work. They start working the day a scanner is configured.

create policy inspection_photos_resident_select on inspection_photos
  for select
  using (
    inspection_item_id in (
      select it.id from public.inspection_items it
       where it.inspection_id in (select app.resident_inspection_ids())
    )
  );

comment on policy inspection_photos_resident_select on inspection_photos is
  'A resident sees the photographs on their own finalised inspection: they are '
  'the evidence behind any deduction from that resident''s deposit, so the '
  'party being charged can look at them too.';

-- The photograph row is not enough on its own: `documents_resident_select`
-- admits only files a landlord explicitly SHARED with the lease
-- (`resident_shared`, unquarantined), and an inspection photograph is an
-- internal record of the landlord's. So a resident could see that a photograph
-- existed and nothing about it, which is the same gap one level down.
--
-- This policy is narrow on purpose: a document attached to an item of an
-- inspection that is already theirs to read. Quarantine is deliberately NOT in
-- the predicate — the row being visible is how the screen can say "a
-- photograph is on file and nobody can open it yet", which is true and useful,
-- while `authoriseDownload` still refuses the bytes to everybody until a
-- scanner clears them.
create policy documents_resident_inspection_select on documents
  for select
  using (
    deleted_at is null
    and id in (
      select ip.document_id
        from public.inspection_photos ip
        join public.inspection_items it on it.id = ip.inspection_item_id
       where it.inspection_id in (select app.resident_inspection_ids())
    )
  );

comment on policy documents_resident_inspection_select on documents is
  'A resident may read the photographs attached to their own finalised '
  'inspection, because they are the evidence behind any deduction from that '
  'resident''s deposit. Downloading still requires the file to have cleared '
  'quarantine, which is enforced by app-level authorisation.';

-- A resident can read back a file they uploaded themselves.
--
-- Not a convenience: without it a resident upload cannot complete at all.
-- `registerDocument` ends its insert with `returning id`, and Postgres applies
-- the SELECT policies to a RETURNING row as well as the WITH CHECK — so with
-- every insert condition satisfied, the statement still failed with "new row
-- violates row-level security policy", because the resident could not read the
-- row back. The same insert without `returning` succeeded, which is what made
-- it worth writing down: that error does not always mean what it says.
--
-- It is also the right policy on its own merits. `documents_resident_select`
-- shows a resident only what a landlord deliberately SHARED with them, so
-- their own proof of payment and their own photograph of a leak were invisible
-- to the person who sent them. Scoped to their own uploads on their own
-- leases, and quarantine is left out of the predicate for the same reason as
-- above: seeing that a file arrived is useful even while nobody can open it.
create policy documents_resident_own_upload_select on documents
  for select
  using (
    uploaded_by = auth.uid()
    and lease_id is not null
    and lease_id in (select app.resident_lease_ids())
  );

comment on policy documents_resident_own_upload_select on documents is
  'A resident reads back the files they uploaded themselves on their own '
  'lease. Required for their upload to complete at all, because a RETURNING '
  'clause is filtered by the SELECT policies.';

select app.assert_table_privileges();
