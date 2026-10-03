-- 0006_operations.sql
-- Private documents, expenses, maintenance, inspections, bank imports,
-- communications, and the durable job / outbox / audit infrastructure.

-- ---------------------------------------------------------------------------
-- Documents (private storage metadata)
-- ---------------------------------------------------------------------------
create type app.document_visibility as enum ('internal', 'resident_shared', 'contractor_shared', 'owner_shared');
create type app.scan_status as enum ('pending', 'skipped_not_configured', 'clean', 'infected', 'failed');

create table documents (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  classification  text not null check (classification in (
                    'lease', 'identity', 'proof_of_payment', 'invoice', 'inspection',
                    'maintenance', 'deposit_evidence', 'statement_export', 'other')),
  title           text not null,
  -- Object key in a PRIVATE bucket. There are no public URLs anywhere in the
  -- product; downloads go through a permission check that mints a short lived
  -- signed URL.
  storage_bucket  text not null default 'propertyos-private',
  storage_key     text not null,
  content_type    text not null,
  byte_size       bigint not null check (byte_size > 0),
  content_sha256  bytea,
  visibility      app.document_visibility not null default 'internal',
  property_id     uuid,
  lease_id        uuid,
  resident_id     uuid,
  -- New files are quarantined until validated. `skipped_not_configured` is an
  -- explicit, honest state: it records that no scanner is wired up, rather than
  -- pretending a file was scanned.
  scan_status     app.scan_status not null default 'pending',
  scan_detail     text,
  scanned_at      timestamptz,
  quarantined     boolean not null default true,
  retention_class text not null default 'standard',
  version         integer not null default 1,
  supersedes_document_id uuid,
  uploaded_by     uuid references auth.users (id),
  uploaded_at     timestamptz not null default now(),
  deleted_at      timestamptz,
  primary key (id),
  unique (organisation_id, id),
  unique (storage_bucket, storage_key),
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete set null,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete set null,
  foreign key (organisation_id, resident_id)
    references resident_profiles (organisation_id, id) on delete set null,
  foreign key (organisation_id, supersedes_document_id)
    references documents (organisation_id, id) on delete set null,
  -- A quarantined or infected file can never be shared outside the operator team.
  constraint documents_quarantine_not_shared check (
    visibility = 'internal' or (quarantined = false and scan_status <> 'infected')
  )
);

create index documents_org_lease_idx on documents (organisation_id, lease_id);
create index documents_org_property_idx on documents (organisation_id, property_id);

alter table resident_profiles
  add constraint resident_profiles_identity_doc_fk
  foreign key (organisation_id, identity_document_id)
  references documents (organisation_id, id) on delete set null;

alter table leases
  add constraint leases_executed_document_fk
  foreign key (organisation_id, executed_document_id)
  references documents (organisation_id, id) on delete restrict;

alter table payment_evidence
  add constraint payment_evidence_document_fk
  foreign key (organisation_id, document_id)
  references documents (organisation_id, id) on delete set null;

alter table deposit_events
  add constraint deposit_events_evidence_fk
  foreign key (organisation_id, evidence_document_id)
  references documents (organisation_id, id) on delete restrict;

-- Short lived download grants, issued only after a permission check, so every
-- access to a private object is attributable.
create table document_access_grants (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  document_id     uuid not null,
  granted_to      uuid references auth.users (id),
  granted_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  reason          text,
  foreign key (organisation_id, document_id)
    references documents (organisation_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Banking
-- ---------------------------------------------------------------------------
create table bank_accounts (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  book_id         uuid not null,
  label           text not null,
  bank_name       text not null,
  -- Only the last four digits are stored in the ordinary record; full details
  -- live behind a separate verified-banking-details flow with fresh auth.
  account_number_last4 text not null check (account_number_last4 ~ '^[0-9]{4}$'),
  branch_code     text,
  currency_code   char(3) not null,
  account_role    text not null default 'operating'
                  check (account_role in ('operating', 'deposit')),
  ledger_account_id uuid,
  verified_at     timestamptz,
  verified_by     uuid references auth.users (id),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, book_id)
    references financial_books (organisation_id, id) on delete restrict,
  foreign key (organisation_id, ledger_account_id)
    references accounts (organisation_id, id) on delete restrict
);

create table bank_imports (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  bank_account_id uuid not null,
  filename        text not null,
  -- Catches a repeated upload of the exact same file.
  source_sha256   bytea not null,
  row_count       integer not null default 0,
  imported_count  integer not null default 0,
  duplicate_count integer not null default 0,
  status          text not null default 'preview'
                  check (status in ('preview', 'committed', 'failed', 'cancelled')),
  statement_start date,
  statement_end   date,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  committed_at    timestamptz,
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, bank_account_id)
    references bank_accounts (organisation_id, id) on delete restrict
);

create unique index bank_imports_same_file
  on bank_imports (bank_account_id, source_sha256) where status = 'committed';

create table bank_transactions (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  bank_account_id uuid not null,
  import_id       uuid,
  transaction_date date not null,
  description     text not null,
  amount_minor    bigint not null check (amount_minor <> 0),
  currency_code   char(3) not null,
  -- Bank supplied unique identifier when the statement provides one.
  external_id     text,
  -- Conservative fingerprint used only when the bank gives no identifier.
  -- Deliberately includes a per-row ordinal so that two genuinely separate
  -- same-amount payments on one day are preserved rather than silently dropped.
  fingerprint     text not null,
  matched_receipt_id uuid,
  match_status    text not null default 'unmatched'
                  check (match_status in ('unmatched', 'suggested', 'matched', 'ignored', 'needs_review')),
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, bank_account_id)
    references bank_accounts (organisation_id, id) on delete restrict,
  foreign key (organisation_id, import_id)
    references bank_imports (organisation_id, id) on delete set null,
  foreign key (organisation_id, matched_receipt_id)
    references receipts (organisation_id, id) on delete set null
);

-- Overlapping statements must not double-import the same transaction.
create unique index bank_transactions_external_unique
  on bank_transactions (bank_account_id, external_id) where external_id is not null;
create unique index bank_transactions_fingerprint_unique
  on bank_transactions (bank_account_id, fingerprint) where external_id is null;
create index bank_transactions_unmatched_idx
  on bank_transactions (organisation_id, transaction_date) where match_status <> 'matched';

alter table receipts
  add constraint receipts_bank_transaction_fk
  foreign key (organisation_id, bank_transaction_id)
  references bank_transactions (organisation_id, id) on delete set null;

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------
create table vendors (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  name            text not null,
  category        text,
  email           citext,
  phone           text,
  is_contractor   boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id)
);

create table expenses (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  book_id         uuid not null,
  property_id     uuid,
  vendor_id       uuid,
  category        text not null check (category in (
                    'repairs_maintenance', 'municipal', 'insurance', 'levies', 'security',
                    'cleaning', 'management', 'capital_improvement', 'financing', 'other')),
  -- Operating vs capital vs financing is explicit so net operating income is not
  -- silently polluted.
  cost_class      text not null default 'operating'
                  check (cost_class in ('operating', 'capital', 'financing', 'owner_drawing')),
  description     text not null,
  amount_minor    bigint not null check (amount_minor > 0),
  currency_code   char(3) not null,
  expense_date    date not null,
  invoice_reference text,
  invoice_document_id uuid,
  work_order_id   uuid,
  status          text not null default 'draft'
                  check (status in ('draft', 'approved', 'posted', 'paid', 'void')),
  approved_by     uuid references auth.users (id),
  approved_at     timestamptz,
  journal_id      uuid,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, book_id)
    references financial_books (organisation_id, id) on delete restrict,
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete restrict,
  foreign key (organisation_id, vendor_id)
    references vendors (organisation_id, id) on delete restrict,
  foreign key (organisation_id, invoice_document_id)
    references documents (organisation_id, id) on delete set null,
  foreign key (organisation_id, journal_id)
    references journals (organisation_id, id) on delete restrict
);

-- A given supplier invoice is recorded once, even if it is attached both to a
-- maintenance ticket and to an expense.
create unique index expenses_invoice_unique
  on expenses (organisation_id, vendor_id, invoice_reference)
  where invoice_reference is not null and status <> 'void';

create index expenses_org_property_date_idx on expenses (organisation_id, property_id, expense_date);

-- ---------------------------------------------------------------------------
-- Maintenance
-- ---------------------------------------------------------------------------
create type app.ticket_status as enum
  ('submitted', 'triaged', 'awaiting_approval', 'assigned', 'in_progress',
   'awaiting_confirmation', 'resolved', 'closed', 'on_hold', 'cancelled');
create type app.comment_audience as enum ('internal', 'resident_visible', 'contractor_visible');

create table maintenance_tickets (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  reference       text not null,
  property_id     uuid not null,
  unit_id         uuid,
  lease_id        uuid,
  reported_by_user uuid references auth.users (id),
  reported_by_resident uuid,
  category        text not null,
  location        text,
  description     text not null,
  urgency         text not null default 'normal' check (urgency in ('emergency', 'high', 'normal', 'low')),
  -- The resident's claim and the manager's assessment are stored separately;
  -- a manager may correct priority without rewriting what the resident reported.
  triaged_urgency text check (triaged_urgency in ('emergency', 'high', 'normal', 'low')),
  status          app.ticket_status not null default 'submitted',
  on_hold_reason  text,
  cancelled_reason text,
  access_notes    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  closed_at       timestamptz,
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, reference),
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete restrict,
  foreign key (organisation_id, unit_id)
    references units (organisation_id, id) on delete restrict,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete set null,
  foreign key (organisation_id, reported_by_resident)
    references resident_profiles (organisation_id, id) on delete set null
);

create index maintenance_tickets_open_idx
  on maintenance_tickets (organisation_id, status, urgency, created_at);

-- Complete transition history: every state change captures actor and time.
create table maintenance_ticket_events (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  ticket_id       uuid not null,
  from_status     app.ticket_status,
  to_status       app.ticket_status not null,
  actor_user_id   uuid references auth.users (id),
  occurred_at     timestamptz not null default now(),
  note            text,
  foreign key (organisation_id, ticket_id)
    references maintenance_tickets (organisation_id, id) on delete cascade
);

create table maintenance_comments (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  ticket_id       uuid not null,
  author_user_id  uuid references auth.users (id),
  audience        app.comment_audience not null,
  body            text not null check (length(btrim(body)) > 0),
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, ticket_id)
    references maintenance_tickets (organisation_id, id) on delete cascade
);

create table maintenance_attachments (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  ticket_id       uuid not null,
  document_id     uuid not null,
  -- Attachments inherit the same audience rule as comments.
  audience        app.comment_audience not null,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, ticket_id)
    references maintenance_tickets (organisation_id, id) on delete cascade,
  foreign key (organisation_id, document_id)
    references documents (organisation_id, id) on delete cascade
);

create table work_orders (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  ticket_id       uuid not null,
  vendor_id       uuid,
  scope           text not null,
  spending_ceiling_minor bigint check (spending_ceiling_minor >= 0),
  currency_code   char(3) not null,
  appointment_at  timestamptz,
  status          text not null default 'issued'
                  check (status in ('issued', 'accepted', 'completed', 'cancelled')),
  approved_by     uuid references auth.users (id),
  approved_at     timestamptz,
  completed_at    timestamptz,
  completion_note text,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, ticket_id)
    references maintenance_tickets (organisation_id, id) on delete cascade,
  foreign key (organisation_id, vendor_id)
    references vendors (organisation_id, id) on delete restrict
);

alter table expenses
  add constraint expenses_work_order_fk
  foreign key (organisation_id, work_order_id)
  references work_orders (organisation_id, id) on delete set null;

create table maintenance_quotes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  ticket_id       uuid not null,
  vendor_id       uuid not null,
  amount_minor    bigint not null check (amount_minor > 0),
  currency_code   char(3) not null,
  document_id     uuid,
  status          text not null default 'submitted'
                  check (status in ('submitted', 'approved', 'rejected', 'expired')),
  approved_by     uuid references auth.users (id),
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, ticket_id)
    references maintenance_tickets (organisation_id, id) on delete cascade,
  foreign key (organisation_id, vendor_id)
    references vendors (organisation_id, id) on delete restrict,
  foreign key (organisation_id, document_id)
    references documents (organisation_id, id) on delete set null
);

create table contractor_assignments (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  work_order_id   uuid not null,
  vendor_id       uuid not null,
  auth_user_id    uuid references auth.users (id),
  -- Contractor visibility is time boxed to the live assignment.
  active_from     timestamptz not null default now(),
  active_until    timestamptz,
  revoked_at      timestamptz,
  foreign key (organisation_id, work_order_id)
    references work_orders (organisation_id, id) on delete cascade,
  foreign key (organisation_id, vendor_id)
    references vendors (organisation_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Inspections
-- ---------------------------------------------------------------------------
create table inspection_templates (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  name            text not null,
  version         integer not null default 1,
  items           jsonb not null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, name, version)
);

create table inspections (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  property_id     uuid not null,
  unit_id         uuid not null,
  lease_id        uuid,
  template_id     uuid not null,
  template_version integer not null,
  inspection_type text not null check (inspection_type in ('move_in', 'move_out', 'routine', 'other')),
  scheduled_for   date,
  performed_on    date,
  inspector_user_id uuid references auth.users (id),
  attendees       text,
  status          text not null default 'draft'
                  check (status in ('draft', 'finalised', 'acknowledged', 'disputed', 'superseded')),
  -- Once finalised an inspection is never edited; a new version is created.
  finalised_at    timestamptz,
  supersedes_inspection_id uuid,
  revision_reason text,
  keys_handed_over text,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete restrict,
  foreign key (organisation_id, unit_id)
    references units (organisation_id, id) on delete restrict,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete set null,
  foreign key (organisation_id, template_id)
    references inspection_templates (organisation_id, id) on delete restrict,
  foreign key (organisation_id, supersedes_inspection_id)
    references inspections (organisation_id, id) on delete set null
);

create table inspection_items (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  inspection_id   uuid not null,
  room            text not null,
  item            text not null,
  condition       text not null check (condition in ('good', 'fair', 'poor', 'damaged', 'not_applicable')),
  -- Wear and recorded damage are distinguished rather than merged.
  damage_type     text check (damage_type in ('fair_wear_and_tear', 'damage', 'missing')),
  note            text,
  sort_order      integer not null default 0,
  foreign key (organisation_id, inspection_id)
    references inspections (organisation_id, id) on delete cascade
);

create table inspection_photos (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  inspection_item_id uuid not null references inspection_items (id) on delete cascade,
  document_id     uuid not null,
  captured_at     timestamptz,
  foreign key (organisation_id, document_id)
    references documents (organisation_id, id) on delete restrict
);

-- A resident may acknowledge or dispute, but never edit the inspector's record.
create table inspection_acknowledgements (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  inspection_id   uuid not null,
  resident_id     uuid not null,
  response        text not null check (response in ('acknowledged', 'disputed')),
  comment         text,
  responded_at    timestamptz not null default now(),
  responded_by    uuid references auth.users (id),
  unique (inspection_id, resident_id),
  foreign key (organisation_id, inspection_id)
    references inspections (organisation_id, id) on delete cascade,
  foreign key (organisation_id, resident_id)
    references resident_profiles (organisation_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Communications
-- ---------------------------------------------------------------------------
create table notification_templates (
  key         text primary key,
  channel     text not null check (channel in ('email', 'in_app')),
  subject     text,
  body        text not null,
  version     integer not null default 1
);

create table notifications (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  template_key    text references notification_templates (key),
  channel         text not null check (channel in ('email', 'in_app')),
  recipient_user_id uuid references auth.users (id),
  recipient_email citext,
  recipient_resident_id uuid,
  subject         text,
  body            text not null,
  -- 'sent' is only ever written by an adapter that received provider
  -- acknowledgement. The development sink writes 'development_sink' so a message
  -- is never reported as delivered when it was not.
  status          text not null default 'queued'
                  check (status in ('queued', 'sent', 'development_sink', 'failed', 'suppressed')),
  provider        text,
  provider_message_id text,
  attempts        integer not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  read_at         timestamptz,
  foreign key (organisation_id, recipient_resident_id)
    references resident_profiles (organisation_id, id) on delete set null
);

create index notifications_recipient_idx on notifications (recipient_user_id, created_at desc);

create table delivery_attempts (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  notification_id uuid not null references notifications (id) on delete cascade,
  attempted_at    timestamptz not null default now(),
  outcome         text not null,
  provider_response text
);

-- ---------------------------------------------------------------------------
-- Durable infrastructure: outbox, jobs, idempotency, audit
-- ---------------------------------------------------------------------------
-- Outbox rows are written in the SAME transaction as the business data, so a
-- notification can never be lost because the worker crashed, and can never be
-- emitted for a transaction that rolled back.
create table outbox_events (
  id              bigserial primary key,
  organisation_id uuid not null references organisations (id) on delete cascade,
  event_type      text not null,
  event_version   integer not null default 1,
  resource_type   text not null,
  resource_id     uuid,
  -- Deliberately minimal: identifiers and amounts, never personal detail.
  payload         jsonb not null default '{}'::jsonb,
  correlation_id  uuid,
  occurred_at     timestamptz not null default now(),
  published_at    timestamptz
);

create index outbox_unpublished_idx on outbox_events (id) where published_at is null;

create table jobs (
  id              bigserial primary key,
  organisation_id uuid references organisations (id) on delete cascade,
  job_type        text not null,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'queued'
                  check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  run_after       timestamptz not null default now(),
  attempts        integer not null default 0,
  max_attempts    integer not null default 5,
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  -- Repeating a command with the same key returns the stored result rather than
  -- performing the work twice.
  idempotency_key text,
  correlation_id  uuid,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create unique index jobs_idempotency_idx
  on jobs (job_type, idempotency_key) where idempotency_key is not null;
create index jobs_claimable_idx on jobs (status, run_after) where status = 'queued';

create table job_attempts (
  id          bigserial primary key,
  job_id      bigint not null references jobs (id) on delete cascade,
  attempt     integer not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  outcome     text,
  error       text
);

-- Command level idempotency. The key binds organisation, actor, command and a
-- hash of the payload: replaying returns the stored result, while reusing a key
-- with a different payload is rejected.
create table idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  actor_user_id   uuid,
  command         text not null,
  key             text not null,
  payload_sha256  bytea not null,
  result          jsonb,
  status          text not null default 'in_progress'
                  check (status in ('in_progress', 'succeeded', 'failed')),
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique (organisation_id, command, key)
);

create table webhook_events (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  provider_event_id text not null,
  organisation_id uuid references organisations (id) on delete set null,
  event_type      text not null,
  signature_verified boolean not null default false,
  payload         jsonb not null,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  processing_result text,
  unique (provider, provider_event_id)
);

create table audit_events (
  id              bigserial primary key,
  organisation_id uuid references organisations (id) on delete cascade,
  actor_user_id   uuid,
  actor_role      text,
  action          text not null,
  resource_type   text not null,
  resource_id     uuid,
  occurred_at     timestamptz not null default now(),
  correlation_id  uuid,
  reason          text,
  -- Redacted before write by the application layer: never bank details, identity
  -- numbers or document contents.
  before_state    jsonb,
  after_state     jsonb,
  ip_hash         text,
  support_session_id uuid references support_sessions (id) on delete set null
);

create index audit_events_org_time_idx on audit_events (organisation_id, occurred_at desc);
create index audit_events_resource_idx on audit_events (resource_type, resource_id);

-- NOTE: `schema_migrations` is created and owned by the migration runner itself
-- (packages/db/src/cli/migrate.ts) before any migration is applied, so it is
-- deliberately not created here.
