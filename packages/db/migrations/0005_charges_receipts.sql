-- 0005_charges_receipts.sql
-- Charge schedules, charge documents, receipts, payment evidence, allocations
-- and deposits.

-- ---------------------------------------------------------------------------
-- Recurring charge schedules
-- ---------------------------------------------------------------------------
-- Schedules are kept separate from issued charge documents, so changing a
-- schedule never restates a charge that was already posted.
create table charge_schedules (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  lease_id        uuid not null,
  category        text not null check (category in ('rent', 'utility_fixed', 'parking', 'other')),
  description     text not null,
  amount_minor    bigint not null check (amount_minor >= 0),
  currency_code   char(3) not null,
  -- Effective dated terms. A rent increase closes the old row and opens a new
  -- one; the historical amount stays readable.
  effective_period daterange not null,
  frequency       text not null default 'monthly' check (frequency in ('monthly')),
  due_day         smallint not null default 1 check (due_day between 1 and 31),
  -- When the due day exceeds the month length, resolve to the last day.
  due_day_overflow text not null default 'last_day'
                  check (due_day_overflow in ('last_day')),
  prorate_first_period boolean not null default true,
  prorate_last_period  boolean not null default true,
  tax_classification text not null default 'residential_rent_exempt',
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete cascade,
  -- One active schedule per lease + category per period.
  exclude using gist (
    lease_id with =, category with =, effective_period with &&
  ) where (is_active)
);

create index charge_schedules_lease_idx on charge_schedules (organisation_id, lease_id);

-- ---------------------------------------------------------------------------
-- Billing runs
-- ---------------------------------------------------------------------------
create table billing_runs (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  book_id         uuid not null,
  period_start    date not null,
  period_end      date not null,
  status          app.billing_run_status not null default 'preview',
  -- The preview is versioned; posting must quote the version it approved so a
  -- stale preview cannot be posted after the underlying data changed.
  preview_version integer not null default 1,
  preview_hash    bytea,
  property_scope  uuid[],
  totals_minor    bigint not null default 0,
  line_count      integer not null default 0,
  exception_count integer not null default 0,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  posted_at       timestamptz,
  posted_by       uuid references auth.users (id),
  failure_reason  text,
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, book_id)
    references financial_books (organisation_id, id) on delete restrict,
  constraint billing_runs_period check (period_end >= period_start)
);

create unique index billing_runs_idempotency
  on billing_runs (organisation_id, idempotency_key) where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- Charge documents
-- ---------------------------------------------------------------------------
create table charge_documents (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  book_id         uuid not null,
  lease_id        uuid not null,
  document_type   app.charge_document_type not null,
  document_number text not null,
  status          app.charge_document_status not null default 'draft',
  currency_code   char(3) not null,
  issue_date      date not null,
  due_date        date not null,
  -- The billing period this document covers. Combined with the schedule it forms
  -- the duplicate-prevention key below.
  period_start    date,
  period_end      date,
  schedule_id     uuid,
  billing_run_id  uuid,
  total_minor     bigint not null default 0,
  journal_id      uuid,
  -- Corrections point back at what they correct.
  corrects_document_id uuid,
  correction_reason    text,
  reversed_by_document_id uuid,
  disputed        boolean not null default false,
  dispute_note    text,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  posted_at       timestamptz,
  posted_by       uuid references auth.users (id),
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, document_number),
  foreign key (organisation_id, book_id)
    references financial_books (organisation_id, id) on delete restrict,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete restrict,
  foreign key (organisation_id, schedule_id)
    references charge_schedules (organisation_id, id) on delete restrict,
  foreign key (organisation_id, billing_run_id)
    references billing_runs (organisation_id, id) on delete restrict,
  foreign key (organisation_id, journal_id)
    references journals (organisation_id, id) on delete restrict,
  foreign key (organisation_id, corrects_document_id)
    references charge_documents (organisation_id, id) on delete restrict,
  constraint charge_documents_dates check (due_date >= issue_date),
  constraint charge_documents_period check (
    (period_start is null and period_end is null) or
    (period_start is not null and period_end is not null and period_end >= period_start)
  ),
  -- A posted document must carry its journal; a draft must not.
  constraint charge_documents_posting check (
    (status = 'draft'  and journal_id is null and posted_at is null) or
    (status <> 'draft' and journal_id is not null and posted_at is not null)
  ),
  -- Credit notes are negative-effect documents and always reference an original.
  constraint charge_documents_credit_link check (
    document_type <> 'credit_note' or corrects_document_id is not null
  )
);

-- "A database unique key on schedule, charge period and document type prevents
-- duplicate recurring charges. A worker can retry after a crash without billing
-- twice." Drafts are excluded so a cancelled preview can be regenerated.
create unique index charge_documents_no_duplicate_period
  on charge_documents (schedule_id, period_start, document_type)
  where schedule_id is not null and status <> 'draft';

create index charge_documents_lease_idx on charge_documents (organisation_id, lease_id, due_date);
create index charge_documents_run_idx on charge_documents (billing_run_id);
create index charge_documents_open_idx
  on charge_documents (organisation_id, due_date) where status = 'posted';

create table charge_lines (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  document_id     uuid not null,
  lease_id        uuid not null,
  line_number     smallint not null check (line_number > 0),
  category        text not null,
  description     text not null,
  -- Positive for a receivable (debit to the resident), negative for a credit.
  amount_minor    bigint not null,
  currency_code   char(3) not null,
  income_account_id uuid not null,
  -- Proration evidence, persisted so the statement can explain the calculation.
  prorated        boolean not null default false,
  proration_numerator   integer check (proration_numerator >= 0),
  proration_denominator integer check (proration_denominator > 0),
  full_period_amount_minor bigint,
  service_period_start date,
  service_period_end   date,
  due_date        date not null,
  primary key (id),
  unique (organisation_id, id),
  unique (document_id, line_number),
  foreign key (organisation_id, document_id)
    references charge_documents (organisation_id, id) on delete cascade,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete restrict,
  foreign key (organisation_id, income_account_id)
    references accounts (organisation_id, id) on delete restrict,
  constraint charge_lines_proration check (
    prorated = false or (proration_numerator is not null and proration_denominator is not null)
  ),
  constraint charge_lines_nonzero check (amount_minor <> 0)
);

create index charge_lines_document_idx on charge_lines (document_id);
create index charge_lines_lease_due_idx on charge_lines (organisation_id, lease_id, due_date);

-- Draft lines stay editable; once the document is posted the line is frozen.
create or replace function app.block_posted_charge_line_mutation()
returns trigger
language plpgsql
as $$
declare
  v_status app.charge_document_status;
begin
  select status into v_status from charge_documents where id = old.document_id;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'charge line % belongs to a posted document and is immutable', old.id
      using errcode = '42501',
            hint = 'Issue a linked credit note or adjustment instead.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger charge_lines_immutable_once_posted
  before update or delete on charge_lines
  for each row execute function app.block_posted_charge_line_mutation();

-- ---------------------------------------------------------------------------
-- Receipts and payment evidence
-- ---------------------------------------------------------------------------
-- Evidence a resident uploads is NOT a receipt. It never reduces a balance.
create table payment_evidence (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  lease_id        uuid not null,
  submitted_by    uuid references auth.users (id),
  submitted_at    timestamptz not null default now(),
  claimed_amount_minor bigint check (claimed_amount_minor > 0),
  claimed_paid_at date,
  reference       text,
  document_id     uuid,
  status          app.evidence_status not null default 'submitted',
  reviewed_by     uuid references auth.users (id),
  reviewed_at     timestamptz,
  review_note     text,
  -- Set only when an operator confirms real funds and creates the receipt.
  receipt_id      uuid,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete cascade
);

comment on table payment_evidence is
  'Proof of payment awaiting verification. Carries no accounting effect whatsoever: there is deliberately no journal, no allocation and no balance impact until an operator confirms the funds and a receipt is created.';

create table receipts (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  book_id         uuid not null,
  -- A receipt may arrive before the payer is identified; it then sits in suspense.
  lease_id        uuid,
  receipt_number  text not null,
  status          app.receipt_status not null default 'created',
  -- Gross amount actually received. Provider fees are recorded separately so a
  -- R8,000 rent payment with a R120 fee never leaves R120 of fictitious arrears.
  amount_minor    bigint not null check (amount_minor > 0),
  fee_minor       bigint not null default 0 check (fee_minor >= 0),
  currency_code   char(3) not null,
  received_on     date not null,
  method          text not null default 'eft' check (method in ('eft', 'cash', 'card', 'debit_order', 'other')),
  payer_reference text,
  bank_transaction_id uuid,
  journal_id      uuid,
  confirmed_at    timestamptz,
  confirmed_by    uuid references auth.users (id),
  -- Suspense receipts are confirmed funds with no identified lease.
  in_suspense     boolean not null default false,
  reversal_of_receipt_id uuid,
  notes           text,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, receipt_number),
  foreign key (organisation_id, book_id)
    references financial_books (organisation_id, id) on delete restrict,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete restrict,
  foreign key (organisation_id, journal_id)
    references journals (organisation_id, id) on delete restrict,
  constraint receipts_confirmed_has_journal check (
    status <> 'confirmed' or (journal_id is not null and confirmed_at is not null)
  ),
  constraint receipts_suspense_shape check (
    in_suspense = false or lease_id is null
  )
);

create index receipts_org_lease_idx on receipts (organisation_id, lease_id, received_on);
create index receipts_suspense_idx on receipts (organisation_id) where in_suspense;

alter table payment_evidence
  add constraint payment_evidence_receipt_fk
  foreign key (organisation_id, receipt_id)
  references receipts (organisation_id, id) on delete set null;

-- ---------------------------------------------------------------------------
-- Allocations
-- ---------------------------------------------------------------------------
create table payment_allocations (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  receipt_id      uuid not null,
  charge_line_id  uuid not null,
  amount_minor    bigint not null check (amount_minor > 0),
  currency_code   char(3) not null,
  journal_id      uuid,
  -- The ordering policy that produced this allocation, recorded because the
  -- policy affects arrears ageing.
  applied_policy  text not null default 'oldest_due_date_first',
  allocated_at    timestamptz not null default now(),
  allocated_by    uuid references auth.users (id),
  reversed_at     timestamptz,
  reversed_by     uuid references auth.users (id),
  reversal_reason text,
  foreign key (organisation_id, receipt_id)
    references receipts (organisation_id, id) on delete restrict,
  foreign key (organisation_id, charge_line_id)
    references charge_lines (organisation_id, id) on delete restrict,
  foreign key (organisation_id, journal_id)
    references journals (organisation_id, id) on delete restrict
);

create index payment_allocations_receipt_idx on payment_allocations (receipt_id) where reversed_at is null;
create index payment_allocations_charge_idx on payment_allocations (charge_line_id) where reversed_at is null;

-- Over-allocation guard.
--
-- Concurrency: the trigger takes a row lock on the receipt first, then on the
-- charge line. Every allocation path therefore acquires locks in the same
-- order, so two concurrent allocations against one receipt serialise instead of
-- both seeing a stale available balance, and no deadlock cycle is possible
-- between the two resources.
create or replace function app.assert_allocation_within_limits()
returns trigger
language plpgsql
as $$
declare
  v_receipt        receipts%rowtype;
  v_charge         charge_lines%rowtype;
  v_doc_status     app.charge_document_status;
  v_allocated      bigint;
  v_charge_applied bigint;
begin
  -- 1. Lock the receipt. This serialises concurrent allocations of one receipt.
  select * into v_receipt from receipts where id = new.receipt_id for update;
  if not found then
    raise exception 'receipt % not found', new.receipt_id using errcode = '23503';
  end if;

  -- 2. Lock the charge line (always after the receipt).
  select * into v_charge from charge_lines where id = new.charge_line_id for update;
  if not found then
    raise exception 'charge line % not found', new.charge_line_id using errcode = '23503';
  end if;

  if v_receipt.status <> 'confirmed' then
    raise exception 'receipt % is % and cannot be allocated; only confirmed funds may be applied',
      v_receipt.receipt_number, v_receipt.status using errcode = '42501';
  end if;

  select status into v_doc_status from charge_documents where id = v_charge.document_id;
  if v_doc_status <> 'posted' then
    raise exception 'charge line % belongs to a % document and cannot be allocated',
      new.charge_line_id, v_doc_status using errcode = '42501';
  end if;

  if v_receipt.currency_code <> v_charge.currency_code
     or new.currency_code <> v_receipt.currency_code then
    raise exception 'allocation currency mismatch: receipt %, charge %, allocation %',
      v_receipt.currency_code, v_charge.currency_code, new.currency_code
      using errcode = '23514';
  end if;

  if v_receipt.organisation_id <> v_charge.organisation_id
     or new.organisation_id <> v_receipt.organisation_id then
    raise exception 'allocation crosses organisation boundary' using errcode = '42501';
  end if;

  if v_receipt.book_id <> (select d.book_id from charge_documents d where d.id = v_charge.document_id) then
    raise exception 'allocation crosses financial book boundary' using errcode = '42501';
  end if;

  -- 3. Receipt availability.
  select coalesce(sum(amount_minor), 0) into v_allocated
  from payment_allocations
  where receipt_id = new.receipt_id
    and reversed_at is null
    and id <> new.id;

  if v_allocated + new.amount_minor > v_receipt.amount_minor then
    raise exception
      'allocation of % exceeds receipt % available balance (% of % already allocated)',
      new.amount_minor, v_receipt.receipt_number, v_allocated, v_receipt.amount_minor
      using errcode = '23514';
  end if;

  -- 4. Charge outstanding balance. Credit lines (negative) are not allocable.
  if v_charge.amount_minor <= 0 then
    raise exception 'charge line % is a credit line and cannot receive an allocation',
      new.charge_line_id using errcode = '23514';
  end if;

  select coalesce(sum(amount_minor), 0) into v_charge_applied
  from payment_allocations
  where charge_line_id = new.charge_line_id
    and reversed_at is null
    and id <> new.id;

  if v_charge_applied + new.amount_minor > v_charge.amount_minor then
    raise exception
      'allocation of % exceeds charge line outstanding balance (% of % already applied)',
      new.amount_minor, v_charge_applied, v_charge.amount_minor
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger payment_allocations_limits
  before insert on payment_allocations
  for each row execute function app.assert_allocation_within_limits();

-- Allocations are reversed (reversed_at set), never deleted or re-pointed.
create or replace function app.guard_allocation_update()
returns trigger
language plpgsql
as $$
begin
  if new.receipt_id <> old.receipt_id
     or new.charge_line_id <> old.charge_line_id
     or new.amount_minor <> old.amount_minor
     or new.journal_id is distinct from old.journal_id then
    raise exception 'an allocation may only be reversed, not amended'
      using errcode = '42501',
            hint = 'Reverse the allocation and create a new one.';
  end if;
  if old.reversed_at is not null then
    raise exception 'allocation % is already reversed', old.id using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger payment_allocations_reverse_only
  before update on payment_allocations
  for each row execute function app.guard_allocation_update();

create trigger payment_allocations_no_delete
  before delete on payment_allocations
  for each row execute function app.block_financial_mutation();

-- ---------------------------------------------------------------------------
-- Deposits
-- ---------------------------------------------------------------------------
-- Deposit money is a liability to the resident. It is never rental income and
-- never reduces the rent receivable until an approved, lawful transfer is posted.
create table deposit_accounts (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  book_id         uuid not null,
  lease_id        uuid not null,
  -- Who physically holds the money, recorded rather than assumed.
  holder          text not null check (holder in ('landlord', 'agency_trust', 'third_party_custodian')),
  holder_reference text,
  bank_reference  text,
  currency_code   char(3) not null,
  required_minor  bigint not null default 0 check (required_minor >= 0),
  status          text not null default 'open' check (status in ('open', 'closed')),
  -- Interest is only ever recorded from actual evidence or an agreed reviewed
  -- calculation. There is deliberately no automatic accrual: an assumed rate
  -- must never be presented as earned interest.
  interest_basis  text check (interest_basis in ('bank_statement_evidence', 'agreed_reviewed_calculation')),
  opened_on       date not null,
  closed_on       date,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, lease_id),
  foreign key (organisation_id, book_id)
    references financial_books (organisation_id, id) on delete restrict,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete restrict
);

create table deposit_events (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  deposit_account_id uuid not null,
  event_type      app.deposit_event_type not null,
  -- Positive increases the liability held for the resident, negative reduces it.
  amount_minor    bigint not null check (amount_minor <> 0),
  currency_code   char(3) not null,
  effective_on    date not null,
  description     text not null,
  -- Deductions and refunds require documentary evidence and an approver who is
  -- not the preparer.
  evidence_document_id uuid,
  requested_by    uuid references auth.users (id),
  requested_at    timestamptz,
  approved_by     uuid references auth.users (id),
  approved_at     timestamptz,
  approval_reason text,
  refund_reference text,
  journal_id      uuid,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, deposit_account_id)
    references deposit_accounts (organisation_id, id) on delete restrict,
  foreign key (organisation_id, journal_id)
    references journals (organisation_id, id) on delete restrict,
  -- "Deposit refund is attempted without evidence/permission: blocked and logged."
  constraint deposit_events_refund_controls check (
    event_type not in ('deduction', 'refund', 'transfer_to_rent')
    or (approved_by is not null and approved_at is not null
        and evidence_document_id is not null
        and length(btrim(coalesce(approval_reason, ''))) >= 5)
  ),
  -- Interest must never be invented. Crediting interest requires evidence.
  constraint deposit_events_interest_evidence check (
    event_type <> 'interest_credited' or evidence_document_id is not null
  ),
  -- The preparer may not approve their own refund or deduction.
  constraint deposit_events_segregation check (
    approved_by is null or requested_by is null or approved_by <> requested_by
  )
);

create index deposit_events_account_idx on deposit_events (deposit_account_id, effective_on);

create trigger deposit_events_immutable
  before delete on deposit_events
  for each row execute function app.block_financial_mutation();
