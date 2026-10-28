-- ---------------------------------------------------------------------------
-- 0084  A mandate to collect
-- ---------------------------------------------------------------------------
--
-- 0083 let a customer pay an invoice by pressing a button. That is not how a
-- subscription business is paid in South Africa: it is paid by debit order,
-- against a mandate the payer authenticated through their own bank. Without
-- one, somebody has to remember to press the button every month, and the first
-- month they forget is the month Spike is funding them.
--
-- This migration is the MANDATE, and nothing else. Collections against it are
-- the next piece of work: an instruction that moves money needs the sponsoring
-- bank relationship and a provider's own specification, and the authorisation
-- record is the thing that must exist first and must be impossible to
-- fabricate afterwards.
--
-- Still ADR 0004's second money flow: Spike collecting its own subscription
-- fees. A tenant's debit order to a landlord is the first money flow and stays
-- disabled, for the six reasons listed there.
--
-- Five decisions.
--
-- **The authorisation is the point, so it is explicit and it is capped.** A
-- mandate names a maximum amount, a day of the month and a date it starts
-- from. The maximum is not decoration: a later collection may not exceed what
-- the payer agreed to, and when collections are built that is the invariant
-- they will be checked against.
--
-- **The terms are immutable.** Changing what a payer agreed to is not an edit.
-- Under DebiCheck an amendment is itself authenticated by the payer, so until
-- that flow is modelled properly the only honest path is to cancel this
-- mandate and request another — which is what the screens offer, and which
-- leaves both records in place.
--
-- **Only a verified provider event may authenticate one**, exactly as with a
-- payment in 0083 and for the same reason: a page saying "thanks, that's
-- authorised" proves nothing about what the payer's bank actually did. Check
-- constraint and trigger, and no UPDATE policy for the application role.
--
-- **The account number is sealed, and the last four are not.** The same
-- treatment `bank_accounts` and the lease refund account already get: a screen
-- needs to say which account without opening the seal, and nothing needs to
-- read the whole number except the instruction that will one day be submitted.
--
-- **The payer may end it at any time, and that is a different act from Spike
-- ending it.** Both are recorded, and which of them it was is a column rather
-- than an inference from a reason somebody typed.

create table subscription_mandates (
  id                       uuid primary key default gen_random_uuid(),
  organisation_id          uuid not null references organisations (id) on delete cascade,
  provider                 text not null,
  reference                text not null unique,
  provider_reference       text,
  status                   text not null default 'requested',

  -- What the payer authorised. The cap, the day, and from when.
  authorised_amount_minor  bigint not null,
  currency_code            text not null,
  collection_day           smallint not null,
  first_collection_on      date not null,
  frequency                text not null default 'monthly',

  -- Which account, sealed the way every other account number here is.
  account_holder           text not null,
  bank_name                text not null,
  branch_code              text not null,
  account_type             text not null,
  account_number_cipher    bytea not null,
  account_number_last4     text not null,

  requested_by             uuid references auth.users (id),
  requested_at             timestamptz not null default now(),
  authenticated_at         timestamptz,
  authentication_event_id  uuid references webhook_events (id),
  rejection_reason         text,

  suspended_at             timestamptz,
  suspension_reason        text,

  cancelled_at             timestamptz,
  cancelled_by             uuid references auth.users (id),
  cancellation_reason      text,
  -- Whose decision it was. A payer withdrawing authority and Spike ending a
  -- facility are different events with different consequences, and guessing
  -- from the reason text is not good enough for an authorisation record.
  cancelled_by_payer       boolean,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint mandate_amount_is_positive check (authorised_amount_minor > 0),
  constraint mandate_day_is_real check (collection_day between 1 and 31),
  constraint mandate_status_is_known
    check (status in ('requested', 'authenticated', 'suspended', 'cancelled', 'rejected')),
  constraint mandate_frequency_is_known check (frequency in ('monthly')),
  constraint mandate_account_type_is_known
    check (account_type in ('cheque', 'savings', 'transmission')),
  constraint mandate_last4_is_four check (account_number_last4 ~ '^[0-9]{4}$'),
  -- The same rule as a confirmed payment: authority comes from the payer's
  -- bank by way of a verified event, or it does not exist.
  constraint authentication_needs_a_verified_event check (
    status <> 'authenticated'
    or (authenticated_at is not null and authentication_event_id is not null)
  ),
  constraint cancellation_is_whole check (
    (cancelled_at is null and cancelled_by_payer is null)
    or (cancelled_at is not null and cancelled_by_payer is not null
        and length(btrim(coalesce(cancellation_reason, ''))) >= 5)
  )
);

comment on table subscription_mandates is
  'A customer''s standing authority for Spike to collect its subscription fees '
  'by debit order: the capped amount, the day, the account, and the evidence '
  'that the payer authenticated it. Terms are immutable; changing them means a '
  'new mandate.';

-- One live mandate per customer. Two live mandates is two authorities over one
-- account, and the second one nobody remembers agreeing to.
create unique index subscription_mandates_one_live_idx
  on subscription_mandates (organisation_id)
  where status in ('requested', 'authenticated', 'suspended');

create index subscription_mandates_collection_day_idx
  on subscription_mandates (collection_day) where status = 'authenticated';

create or replace function app.mandate_authentication_is_verified()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verified boolean;
begin
  if new.status <> 'authenticated' then
    return new;
  end if;

  select signature_verified into v_verified
  from public.webhook_events where id = new.authentication_event_id;

  if v_verified is not true then
    raise exception
      'A mandate may only be authenticated by a provider event whose signature was verified'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger subscription_mandates_verified_authentication
  before insert or update on subscription_mandates
  for each row execute function app.mandate_authentication_is_verified();

comment on function app.mandate_authentication_is_verified() is
  'Refuses to let a mandate reach authenticated unless the provider event '
  'behind it had its signature verified. The same rule 0083 applies to a '
  'confirmed payment.';

-- The terms a payer agreed to cannot be edited. Status, the authentication
-- evidence and the ending of it may change; the amount, the day, the account
-- and the start date may not.
create or replace function app.mandate_terms_are_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.authorised_amount_minor <> old.authorised_amount_minor
     or new.collection_day <> old.collection_day
     or new.first_collection_on <> old.first_collection_on
     or new.frequency <> old.frequency
     or new.account_number_cipher <> old.account_number_cipher
     or new.branch_code <> old.branch_code
     or new.account_type <> old.account_type
     or new.organisation_id <> old.organisation_id then
    raise exception
      'A mandate''s terms cannot be changed. Cancel it and request another, so '
      'that both records survive and the payer authenticates the new one.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger subscription_mandates_immutable_terms
  before update on subscription_mandates
  for each row execute function app.mandate_terms_are_immutable();

alter table subscription_mandates enable row level security;

-- Select and insert only, as with payment attempts. Authenticating, suspending
-- and cancelling happen on the privileged connection — from the notification
-- endpoint, or from a command that has decided who is cancelling and why.
grant select, insert on subscription_mandates to propertyos_app;
grant select, insert, update on subscription_mandates to propertyos_worker;

-- The customer's own administrator: the same permission that reads the invoices
-- this mandate will pay.
create policy subscription_mandates_customer_select on subscription_mandates
  for select using (app.has_permission(organisation_id, 'organisation.settings.manage'));

create policy subscription_mandates_customer_insert on subscription_mandates
  for insert with check (
    app.has_permission(organisation_id, 'organisation.settings.manage')
    -- Requesting is all they may do. A row that arrives authenticated, or
    -- citing an event, is refused here as well as by the trigger.
    and status = 'requested'
    and authenticated_at is null
    and authentication_event_id is null
    and cancelled_at is null
    and requested_by = auth.uid()
  );

create policy subscription_mandates_platform_select on subscription_mandates
  for select using (app.is_platform_operator());

-- An operator may set one up on a customer's behalf — somebody on the phone
-- reading their bank details out — and no more than that. They cannot
-- authenticate it: only the payer's bank can.
create policy subscription_mandates_platform_insert on subscription_mandates
  for insert with check (
    app.platform_permission('platform.billing.manage')
    and status = 'requested'
    and authenticated_at is null
    and authentication_event_id is null
  );
