-- ---------------------------------------------------------------------------
-- 0085  Collecting on the mandate
-- ---------------------------------------------------------------------------
--
-- 0084 recorded the authority. This is the instruction that uses it: on the
-- day the payer agreed to, for what they owe, never more than they authorised.
--
-- The single most important rule in this file, and the reason most of it
-- exists: **a collection may never exceed the mandate's authorised amount.**
-- A debit order that takes more than the payer agreed to is the one failure in
-- this product that would be somebody's rent money gone, and it is enforced by
-- a trigger that reads the mandate rather than by the code that prepares the
-- instruction.
--
-- Four more decisions.
--
-- **An instruction is prepared, and separately submitted.** Preparing is
-- arithmetic over invoices and mandates and can be done again safely.
-- Submitting hands an instruction to a bank. Keeping them apart means the
-- monthly run can be looked at before anything leaves, which is what anybody
-- actually wants on the first of the month.
--
-- **Nothing is submitted on a timer.** The run prepares; a person submits. A
-- scheduled submission is the right shape eventually and the wrong shape
-- first, because the first bug in the preparation would be discovered by the
-- customers it debited.
--
-- **Only a verified provider event may mark one successful**, exactly as with
-- a payment and a mandate. The money moving is the bank's statement, not ours.
--
-- **A dispute is the undoing of a settlement that did not happen.** A payer
-- can dispute a debit and have it reversed; the invoice then owes what it
-- always owed. That is a reversal of received funds rather than a credit note,
-- and the collection keeps the reason.

create table subscription_collections (
  id                     uuid primary key default gen_random_uuid(),
  mandate_id             uuid not null references subscription_mandates (id) on delete restrict,
  organisation_id        uuid not null references organisations (id) on delete cascade,
  invoice_id             uuid not null references subscription_invoices (id) on delete cascade,
  reference              text not null unique,
  provider               text not null,
  provider_reference     text,

  amount_minor           bigint not null,
  currency_code          text not null,
  -- The day the money is taken. Never before the mandate starts.
  action_date            date not null,

  status                 text not null default 'prepared',
  prepared_at            timestamptz not null default now(),
  prepared_by            uuid references auth.users (id),
  submitted_at           timestamptz,
  submitted_by           uuid references auth.users (id),

  outcome_at             timestamptz,
  unpaid_reason          text,
  dispute_reason         text,
  abandoned_reason       text,
  webhook_event_id       uuid references webhook_events (id),

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint collection_amount_is_positive check (amount_minor > 0),
  constraint collection_status_is_known check (
    status in ('prepared', 'submitted', 'successful', 'unpaid', 'disputed', 'abandoned')
  ),
  -- The same discipline as a confirmed payment and an authenticated mandate.
  constraint success_needs_a_verified_event check (
    status <> 'successful' or (outcome_at is not null and webhook_event_id is not null)
  ),
  constraint abandonment_has_a_reason check (
    status <> 'abandoned' or length(btrim(coalesce(abandoned_reason, ''))) >= 5
  )
);

comment on table subscription_collections is
  'One debit order instruction against a mandate: what will be taken, on what '
  'day, and what the bank said about it. Prepared and submitted are separate '
  'acts, and nothing may exceed what the payer authorised.';

create index subscription_collections_invoice_idx
  on subscription_collections (invoice_id, prepared_at desc);
create index subscription_collections_due_idx
  on subscription_collections (action_date) where status in ('prepared', 'submitted');

-- One live instruction per invoice. Two instructions is two debits for one
-- debt, and the customer's recourse is a dispute we caused.
create unique index subscription_collections_one_live_per_invoice_idx
  on subscription_collections (invoice_id)
  where status in ('prepared', 'submitted', 'successful');

-- ---------------------------------------------------------------------------
-- Never more than the payer authorised
-- ---------------------------------------------------------------------------

create or replace function app.collection_is_within_its_mandate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mandate public.subscription_mandates;
begin
  select * into v_mandate
  from public.subscription_mandates where id = new.mandate_id;

  if not found then
    raise exception 'A collection needs a mandate' using errcode = 'foreign_key_violation';
  end if;

  if v_mandate.organisation_id <> new.organisation_id then
    raise exception 'That mandate belongs to another customer'
      using errcode = 'check_violation';
  end if;

  -- The rule. Read from the mandate every time rather than trusted from the
  -- caller, because the caller is the thing most likely to be wrong.
  if new.amount_minor > v_mandate.authorised_amount_minor then
    raise exception
      'A collection of % exceeds the % this payer authorised. The mandate is the limit.',
      new.amount_minor, v_mandate.authorised_amount_minor
      using errcode = 'check_violation';
  end if;

  if new.action_date < v_mandate.first_collection_on then
    raise exception 'A collection cannot be taken before % , when the mandate starts',
      v_mandate.first_collection_on
      using errcode = 'check_violation';
  end if;

  -- Preparing against an authority that does not exist yet, or no longer
  -- exists, is how a cancelled mandate still gets debited.
  if tg_op = 'INSERT' and v_mandate.status <> 'authenticated' then
    raise exception 'That mandate is %, so nothing may be collected against it',
      v_mandate.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger subscription_collections_within_mandate
  before insert or update on subscription_collections
  for each row execute function app.collection_is_within_its_mandate();

comment on function app.collection_is_within_its_mandate() is
  'Refuses a collection that exceeds what the payer authorised, starts before '
  'the mandate does, belongs to another customer, or stands against a mandate '
  'that is not authenticated.';

create or replace function app.collection_success_is_verified()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verified boolean;
begin
  if new.status <> 'successful' then
    return new;
  end if;
  select signature_verified into v_verified
  from public.webhook_events where id = new.webhook_event_id;
  if v_verified is not true then
    raise exception
      'A collection may only succeed on a provider event whose signature was verified'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger subscription_collections_verified_success
  before insert or update on subscription_collections
  for each row execute function app.collection_success_is_verified();

alter table subscription_collections enable row level security;

-- The customer reads them. They do not prepare, submit or change them: a
-- collection is Spike's instruction against an authority the customer gave,
-- and the authority is the thing that was theirs to give.
grant select on subscription_collections to propertyos_app;
grant select, insert, update on subscription_collections to propertyos_worker;

create policy subscription_collections_customer_select on subscription_collections
  for select using (app.has_permission(organisation_id, 'organisation.settings.manage'));

create policy subscription_collections_platform_select on subscription_collections
  for select using (app.is_platform_operator());

-- Preparing and submitting run on the privileged connection, from a command
-- that checked `platform.billing.manage` in SQL first. There is deliberately
-- no insert or update policy for the application role at all: an instruction
-- to take money out of somebody's account is not something a web request
-- should be able to write under its own authority.
