-- 0016_import_batches.sql
-- Onboarding imports.
--
-- "A failed import rolls back the relevant batch or records a controlled
-- resumable state; operators must not have to guess which rows were committed."
--
-- PropertyOS takes the first option: one batch commits in one transaction, or
-- not at all. The batch row records what was attempted, what the preview found,
-- and — for an opening balance import — who signed the figures off.

create type app.import_kind as enum (
  'properties', 'units', 'residents', 'leases', 'charge_schedules',
  'opening_balances', 'deposits'
);

create type app.import_status as enum ('preview', 'committed', 'failed', 'cancelled');

create table import_batches (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  kind            app.import_kind not null,
  filename        text not null,
  -- Catches a repeated upload of the same file.
  source_sha256   bytea not null,
  row_count       integer not null default 0,
  valid_count     integer not null default 0,
  error_count     integer not null default 0,
  imported_count  integer not null default 0,
  status          app.import_status not null default 'preview',
  -- The full per-row, per-field error list from the preview, so an operator can
  -- come back to it rather than re-uploading to see the problems again.
  errors          jsonb not null default '[]'::jsonb,
  failure_reason  text,

  -- Opening balance controls. "Opening balances need a cut off date, source
  -- reference and approval."
  cut_off_date      date,
  source_reference  text,
  approved_by       uuid references auth.users (id),
  approved_at       timestamptz,
  -- Set when only a single total was available per lease, so the statement and
  -- the arrears ageing can say the detail is limited rather than implying
  -- precision that was never supplied.
  limited_ageing_detail boolean not null default false,

  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  committed_at    timestamptz,
  primary key (id),
  unique (organisation_id, id),
  -- An opening balance batch cannot commit without its three controls.
  constraint import_batches_opening_balance_controls check (
    kind <> 'opening_balances'
    or status <> 'committed'
    or (cut_off_date is not null
        and length(btrim(coalesce(source_reference, ''))) >= 3
        and approved_by is not null
        and approved_at is not null)
  )
);

create index import_batches_org_idx on import_batches (organisation_id, created_at desc);

-- The same file cannot be committed twice for the same import kind.
create unique index import_batches_same_file
  on import_batches (organisation_id, kind, source_sha256)
  where status = 'committed';

alter table import_batches enable row level security;

create policy import_batches_select on import_batches
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );
create policy import_batches_insert on import_batches
  for insert with check (app.is_org_member(organisation_id));
create policy import_batches_update on import_batches
  for update
  using (app.is_org_member(organisation_id))
  with check (app.is_org_member(organisation_id));

-- Links an imported opening balance back to the batch that created it, so a
-- statement can show where the figure came from and who approved it.
alter table charge_documents
  add column import_batch_id uuid,
  add constraint charge_documents_import_batch_fk
    foreign key (organisation_id, import_batch_id)
    references import_batches (organisation_id, id) on delete restrict;

create index charge_documents_import_batch_idx on charge_documents (import_batch_id);

alter table deposit_accounts
  add column import_batch_id uuid,
  add constraint deposit_accounts_import_batch_fk
    foreign key (organisation_id, import_batch_id)
    references import_batches (organisation_id, id) on delete restrict;
