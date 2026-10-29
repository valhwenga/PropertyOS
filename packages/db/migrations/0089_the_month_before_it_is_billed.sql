-- ---------------------------------------------------------------------------
-- 0089  The month, before it is billed
-- ---------------------------------------------------------------------------
--
-- A landlord bills water, refuse and sewerage every month, and the product
-- made them do it one lease at a time. Open a lease, open the charges panel,
-- type the readings, post. Forty tenancies is forty visits, and each posting
-- produced its OWN invoice — so a tenant with water and refuse received three
-- documents in a month, one for each thing, none of which could be corrected
-- afterwards because a posted charge document is immutable by trigger.
--
-- The immutability is right and is not what this changes. What it changes is
-- where the typing happens: before posting rather than after, in one pass over
-- every lease, with the figures sitting in a table that can be edited, checked
-- and corrected until somebody approves the run.
--
-- So: a captured line is a draft. It carries the reading, the rate and the
-- arithmetic; it is not in the ledger, it is not a document, nobody has been
-- billed, and deleting one is just deleting a draft. The billing run picks
-- them up, groups a lease's captured lines into ONE utility invoice, and from
-- there the existing path takes over — mark ready, send all.
--
-- **What it deliberately does not do:** it does not put rent and water on the
-- same document. Double billing is prevented by a unique index on
-- `(schedule_id, period_start, document_type)`, which is per-schedule by
-- construction, and the one thing this product must never do is bill somebody
-- twice. Rent keeps its invoice, the month's utilities become one more, and a
-- tenant goes from "one per charge" to "two". Collapsing them needs a
-- different guarantee than the one in place and is not worth inventing while
-- the money is real.
-- ---------------------------------------------------------------------------

create table pending_charges (
  id                  uuid primary key default gen_random_uuid(),
  organisation_id     uuid not null references organisations (id) on delete cascade,
  lease_id            uuid not null,
  -- The billing month this belongs to, always the first of the month, matching
  -- how a billing run is keyed.
  period_start        date not null,
  category            text not null,
  description         text not null,
  -- The arithmetic, kept so the invoice can show it and an operator can check
  -- it: 41 kl at R27.30 reads very differently from "R1,119.30".
  quantity            numeric(14, 3),
  unit                text,
  unit_rate_minor     bigint,
  meter_previous      numeric(14, 3),
  meter_current       numeric(14, 3),
  amount_minor        bigint not null,
  currency_code       char(3) not null default 'ZAR',
  note                text,
  created_at          timestamptz not null default now(),
  created_by          uuid not null references auth.users (id),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id),
  -- Set when a billing run turns it into a real line. From then on it is
  -- history: the document is the record, and this row says which one.
  posted_at           timestamptz,
  billing_run_id      uuid references billing_runs (id),
  charge_document_id  uuid references charge_documents (id),

  constraint pending_charge_period_is_a_month_start check (
    extract(day from period_start) = 1
  ),
  constraint pending_charge_is_positive check (amount_minor > 0),
  -- A reading that goes backwards is a typo or a replaced meter, and either
  -- way it is not a bill. Caught here rather than in a form, because the form
  -- is not the only way in.
  constraint pending_charge_meter_moves_forward check (
    meter_previous is null or meter_current is null or meter_current >= meter_previous
  ),
  constraint pending_charge_posting_is_complete check (
    (posted_at is null and charge_document_id is null)
    or (posted_at is not null and charge_document_id is not null)
  ),
  foreign key (organisation_id, lease_id) references leases (organisation_id, id)
    on delete cascade
);

comment on table pending_charges is
  'Charges typed for a month and not yet billed. A draft: not in the ledger, '
  'not a document, editable until the run posts it.';

-- One water line per lease per month, one refuse line, and so on. Typing the
-- same thing twice is a correction, not a second charge — the capture updates
-- the row rather than adding another, and this index is what makes that true
-- rather than merely intended.
create unique index pending_charges_one_per_category_idx
  on pending_charges (lease_id, period_start, category)
  where posted_at is null;

create index pending_charges_period_idx
  on pending_charges (organisation_id, period_start) where posted_at is null;

alter table pending_charges enable row level security;

grant select, insert, update, delete on pending_charges to propertyos_app;

-- Preparing the run is who captures: the same permission that produces a
-- preview, because that is what this is — part of the preview, typed instead
-- of derived. Posting it is still `billing.post`, on the run.
create policy pending_charges_select on pending_charges
  for select using (app.has_permission(organisation_id, 'billing.preview'));

create policy pending_charges_insert on pending_charges
  for insert with check (app.has_permission(organisation_id, 'billing.preview'));

create policy pending_charges_update on pending_charges
  for update using (app.has_permission(organisation_id, 'billing.preview'))
  with check (app.has_permission(organisation_id, 'billing.preview'));

-- Deleting is deleting a draft, so it is allowed — but only before it has been
-- billed. Once a run has turned it into a document the row is the audit trail
-- of where that line came from, and the correction for a document is a credit
-- note, not an erased draft.
create policy pending_charges_delete on pending_charges
  for delete using (
    app.has_permission(organisation_id, 'billing.preview') and posted_at is null
  );

-- And the same rule where RLS does not reach, because a privileged connection
-- is a connection too.
create or replace function app.pending_charge_stays_once_billed()
returns trigger language plpgsql as $$
begin
  if old.posted_at is not null then
    raise exception 'A captured charge that has been billed cannot be %: the document '
      'is the record, and a correction is a credit note.',
      case tg_op when 'DELETE' then 'deleted' else 'changed' end
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return case tg_op when 'DELETE' then old else new end;
end $$;

create trigger pending_charges_immutable_once_billed
  before update or delete on pending_charges
  for each row execute function app.pending_charge_stays_once_billed();
