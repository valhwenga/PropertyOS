-- 0004_subledger.sql
-- Balanced rental subledger: books, accounts, journals, charges, receipts,
-- allocations and deposits.
--
-- Invariants enforced by the database, not by application code:
--   * Every journal balances within its posting transaction (deferred constraint
--     trigger), per currency. No client supplied total is trusted.
--   * Posted journals, journal lines and posted charge documents are immutable.
--     Corrections are linked credits, adjustments or reversals.
--   * Money is stored as integer minor units. Rates use explicit numeric scale.
--   * Allocations can never exceed the receipt's available amount or the
--     charge's outstanding balance, including under concurrent requests.
--   * A charge cannot be posted into a locked accounting period.

create type app.account_type as enum ('asset', 'liability', 'income', 'expense', 'equity');
create type app.journal_source as enum
  ('opening_balance', 'rent_charge', 'utility_charge', 'adjustment', 'receipt',
   'allocation', 'deposit', 'deposit_refund', 'expense', 'reversal', 'write_off');
create type app.charge_document_type as enum
  ('rent_invoice', 'utility_invoice', 'adjustment_debit', 'credit_note', 'opening_balance');
create type app.charge_document_status as enum ('draft', 'posted', 'reversed');
create type app.receipt_status as enum ('created', 'pending', 'confirmed', 'failed', 'cancelled');
create type app.evidence_status as enum ('submitted', 'under_review', 'accepted', 'rejected');
create type app.billing_run_status as enum ('preview', 'validated', 'posting', 'posted', 'failed', 'cancelled');
create type app.deposit_event_type as enum
  ('received', 'interest_credited', 'deduction', 'refund', 'transfer_to_rent', 'adjustment');

-- ---------------------------------------------------------------------------
-- Books and chart of accounts
-- ---------------------------------------------------------------------------
-- A financial book is the legal entity + currency boundary. Phase 1 creates one
-- per organisation; the boundary is explicit so agency trust books can be added
-- later without restating history.
create table financial_books (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  name            text not null,
  legal_entity_name text not null,
  currency_code   char(3) not null,
  is_default      boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id)
);

create unique index financial_books_one_default
  on financial_books (organisation_id) where is_default;

create table accounts (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  book_id         uuid not null,
  code            text not null check (code ~ '^[A-Z0-9_]{2,40}$'),
  name            text not null,
  account_type    app.account_type not null,
  -- Marks the accounts the domain layer resolves by role rather than by code.
  system_role     text check (system_role in (
                    'resident_receivable', 'unapplied_receipts', 'rental_income',
                    'utility_recovery_income', 'other_income', 'bank_control',
                    'deposit_bank_control', 'deposit_liability', 'deposit_interest_expense',
                    'suspense', 'property_expense', 'write_off_expense', 'opening_equity')),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (organisation_id, id),
  unique (organisation_id, book_id, code),
  foreign key (organisation_id, book_id)
    references financial_books (organisation_id, id) on delete cascade
);

create unique index accounts_one_per_system_role
  on accounts (book_id, system_role) where system_role is not null;

-- ---------------------------------------------------------------------------
-- Period locks
-- ---------------------------------------------------------------------------
create table period_locks (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  book_id         uuid not null,
  locked_through  date not null,
  locked_at       timestamptz not null default now(),
  locked_by       uuid references auth.users (id),
  reopened_at     timestamptz,
  reopened_by     uuid references auth.users (id),
  reopen_reason   text,
  foreign key (organisation_id, book_id)
    references financial_books (organisation_id, id) on delete cascade
);

create index period_locks_book_idx on period_locks (book_id, locked_through desc);

create or replace function app.period_is_locked(p_book uuid, p_date date)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from period_locks pl
    where pl.book_id = p_book
      and pl.reopened_at is null
      and pl.locked_through >= p_date
  );
$$;

-- ---------------------------------------------------------------------------
-- Journals
-- ---------------------------------------------------------------------------
create table journals (
  id              uuid not null default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  book_id         uuid not null,
  currency_code   char(3) not null,
  posting_date    date not null,
  source          app.journal_source not null,
  -- Free-form pointer back to the originating document for traceability.
  source_table    text,
  source_id       uuid,
  description     text not null,
  -- Corrections are linked, never silent edits.
  reverses_journal_id uuid,
  reversal_reason text,
  posted_at       timestamptz not null default now(),
  posted_by       uuid references auth.users (id),
  correlation_id  uuid,
  primary key (id),
  unique (organisation_id, id),
  foreign key (organisation_id, book_id)
    references financial_books (organisation_id, id) on delete restrict,
  foreign key (organisation_id, reverses_journal_id)
    references journals (organisation_id, id) on delete restrict,
  constraint journals_reversal_reason check (
    reverses_journal_id is null or length(btrim(coalesce(reversal_reason, ''))) >= 5
  )
);

create index journals_org_book_date_idx on journals (organisation_id, book_id, posting_date);
create index journals_source_idx on journals (source_table, source_id);
create unique index journals_one_reversal_per_journal
  on journals (reverses_journal_id) where reverses_journal_id is not null;

create table journal_lines (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  journal_id      uuid not null,
  account_id      uuid not null,
  -- Exactly one side carries a non-zero value; both are non-negative minor units.
  debit_minor     bigint not null default 0 check (debit_minor >= 0),
  credit_minor    bigint not null default 0 check (credit_minor >= 0),
  currency_code   char(3) not null,
  -- Optional analysis dimensions.
  lease_id        uuid,
  property_id     uuid,
  unit_id         uuid,
  memo            text,
  line_number     smallint not null check (line_number > 0),
  signed_minor    bigint generated always as (debit_minor - credit_minor) stored,
  unique (journal_id, line_number),
  foreign key (organisation_id, journal_id)
    references journals (organisation_id, id) on delete restrict,
  foreign key (organisation_id, account_id)
    references accounts (organisation_id, id) on delete restrict,
  foreign key (organisation_id, lease_id)
    references leases (organisation_id, id) on delete restrict,
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete restrict,
  constraint journal_lines_one_side check (
    (debit_minor > 0 and credit_minor = 0) or (credit_minor > 0 and debit_minor = 0)
  )
);

create index journal_lines_journal_idx on journal_lines (journal_id);
create index journal_lines_account_idx on journal_lines (organisation_id, account_id);
create index journal_lines_lease_idx on journal_lines (organisation_id, lease_id);

-- Balance enforcement. DEFERRABLE INITIALLY DEFERRED so lines may be inserted in
-- any order, but the check runs before the posting transaction can commit. A
-- journal that does not balance, in every currency it touches, cannot commit.
create or replace function app.assert_journal_balanced()
returns trigger
language plpgsql
as $$
declare
  v_journal uuid := coalesce(new.journal_id, old.journal_id);
  v_bad record;
  v_line_count integer;
begin
  select count(*) into v_line_count from journal_lines where journal_id = v_journal;
  -- A journal whose lines were all removed is only valid if the journal itself
  -- is gone too (which cannot happen: posted journals are immutable).
  if v_line_count = 0 then
    if exists (select 1 from journals where id = v_journal) then
      raise exception 'journal % has no lines', v_journal
        using errcode = '23514', hint = 'A posted journal must contain at least two lines.';
    end if;
    return null;
  end if;

  if v_line_count < 2 then
    raise exception 'journal % must contain at least two lines', v_journal
      using errcode = '23514';
  end if;

  for v_bad in
    select currency_code, sum(signed_minor) as net
    from journal_lines
    where journal_id = v_journal
    group by currency_code
    having sum(signed_minor) <> 0
  loop
    raise exception
      'journal % does not balance in %: debits minus credits = % minor units',
      v_journal, v_bad.currency_code, v_bad.net
      using errcode = '23514';
  end loop;

  -- Every line must share the journal's currency and book.
  if exists (
    select 1 from journal_lines jl
    join journals j on j.id = jl.journal_id
    join accounts a on a.id = jl.account_id
    where jl.journal_id = v_journal
      and (jl.currency_code <> j.currency_code or a.book_id <> j.book_id)
  ) then
    raise exception 'journal % mixes currencies or books across its lines', v_journal
      using errcode = '23514';
  end if;

  return null;
end;
$$;

create constraint trigger journal_lines_balance_check
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row
  execute function app.assert_journal_balanced();

-- Immutability. Posted financial history is corrected with linked reversals, not
-- edited. This blocks the ordinary application roles; migrations run as the
-- owner and are reviewed separately.
create or replace function app.block_financial_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'posted financial records are immutable: % on % is not permitted',
    tg_op, tg_table_name
    using errcode = '42501',
          hint = 'Correct posted history with a linked credit, adjustment or reversal.';
end;
$$;

create trigger journals_immutable
  before update or delete on journals
  for each row execute function app.block_financial_mutation();

create trigger journal_lines_immutable
  before update or delete on journal_lines
  for each row execute function app.block_financial_mutation();

-- Posting into a locked period requires an explicit reopen with an audit event.
create or replace function app.assert_period_open()
returns trigger
language plpgsql
as $$
begin
  if app.period_is_locked(new.book_id, new.posting_date) then
    raise exception 'accounting period containing % is locked for book %',
      new.posting_date, new.book_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger journals_period_lock
  before insert on journals
  for each row execute function app.assert_period_open();
