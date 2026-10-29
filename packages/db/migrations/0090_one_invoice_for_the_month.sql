-- ---------------------------------------------------------------------------
-- 0090  One invoice for the month
-- ---------------------------------------------------------------------------
--
-- 0089 grouped a month's captured utilities into one invoice and left rent on
-- its own, which still meant two documents a month for a tenant who should
-- receive one. The reason was not taste. It was this index:
--
--     unique (schedule_id, period_start, document_type) where schedule_id is not null
--
-- That is the whole protection against billing somebody twice when a run
-- crashes halfway and is retried — and it is keyed on the SCHEDULE, which
-- forces one document per schedule. Putting rent and water on one document
-- means that index can no longer protect anything, so it has to be replaced
-- before the merge, not after.
--
-- The replacement moves the guarantee to where the facts now live.
--
-- **Provenance moves to the line.** `charge_lines.schedule_id` records which
-- schedule produced a line. The document is now a composite and cannot carry
-- one schedule honestly; the line can, and the line is what was billed.
--
-- **The crash guard moves to the run.** One posted document per lease, per
-- period, per billing run. A run that dies after writing a document and is
-- retried finds the row already there and stops; a LATER run for the same
-- period can still raise what the first one did not, which is what somebody
-- who forgot the water readings actually needs.
--
-- **And the second-run guard stays per schedule**, read off the lines: the
-- preview marks a schedule already billed if a line from it exists for the
-- period on a document that is not a draft. Same question as before, asked of
-- the line rather than the document.
--
-- Nothing is dropped. The old index keeps protecting anything that still
-- passes a schedule to `postCharge` — the one-off charge raised from a lease,
-- the opening balance — and goes quiet for run documents, which stop carrying
-- a schedule because they now carry several.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Which schedule produced this line
-- ---------------------------------------------------------------------------

alter table charge_lines
  add column if not exists schedule_id uuid references charge_schedules (id);

comment on column charge_lines.schedule_id is
  'The recurring schedule this line came from, where it came from one. Null '
  'for a utility reading typed into the month, a one-off charge, or an '
  'opening balance. The document used to carry this; it cannot any more, '
  'because one document now carries lines from several schedules.';

-- Everything billed so far came from a document that named its schedule, so
-- the provenance is already in the data — it just has to come down one level.
update charge_lines cl
   set schedule_id = cd.schedule_id
  from charge_documents cd
 where cd.id = cl.document_id
   and cd.schedule_id is not null
   and cl.schedule_id is null;

create index charge_lines_schedule_period_idx
  on charge_lines (schedule_id, service_period_start) where schedule_id is not null;

-- ---------------------------------------------------------------------------
-- One document per lease, per period, per run
-- ---------------------------------------------------------------------------
--
-- This is the index that makes a retried run safe. It is deliberately NOT
-- keyed on document_type: the whole point of this migration is that there is
-- one document, so a second one for the same lease and period in the same run
-- is the bug it is there to catch.
--
-- Creating it is also the check that the existing data permits the merge. If
-- any run ever wrote two documents for one lease and period, this fails and
-- the migration stops — which is the right outcome, because that data would
-- have to be understood before the guarantee could be claimed.

-- Checked first, with words, because a bare unique-index violation names a
-- row and not a problem. A run that raised two documents for one lease and
-- period predates this guarantee; it has to be looked at by somebody who can
-- tell a double billing from a deliberate pair before the index is claimed.
do $$
declare
  colliding integer;
begin
  select count(*) into colliding from (
    select lease_id, period_start, billing_run_id
      from charge_documents
     where billing_run_id is not null and status <> 'draft'
     group by 1, 2, 3 having count(*) > 1
  ) x;

  if colliding > 0 then
    raise exception using
      errcode = 'raise_exception',
      message = format(
        '0090 cannot proceed: %s lease/period/run combinations already have more than one '
        'posted document.', colliding),
      hint = 'These predate the one-document-per-run rule. List them with: select lease_id, '
             'period_start, billing_run_id, count(*) from charge_documents where '
             'billing_run_id is not null and status <> ''draft'' group by 1,2,3 having '
             'count(*) > 1; Decide for each whether it is a double billing (credit note) or '
             'a deliberate pair (leave the older run''s documents, re-key the newer), then '
             'run this migration again.';
  end if;
end $$;

create unique index charge_documents_one_per_run_idx
  on charge_documents (lease_id, period_start, billing_run_id)
  where billing_run_id is not null and status <> 'draft';

comment on index charge_documents_one_per_run_idx is
  'A billing run raises one document per lease per period. The crash guard: a '
  'run that dies after writing and is retried finds this row and stops.';
