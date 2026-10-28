-- ---------------------------------------------------------------------------
-- 0083  Spike can be paid
-- ---------------------------------------------------------------------------
--
-- `recordSubscriptionPayment` has always said what it is: an operator reads
-- Spike's bank statement and types in what arrived. So "outstanding" on the
-- billing screen means "not yet recorded as received" rather than "unpaid",
-- every screen says so, and nothing in the product can take a payment.
--
-- This is the collection side of ADR 0004's second money flow — Spike's own
-- revenue, which that decision deliberately keeps separate from any customer
-- financial book. Rent collection stays off, and stays off for the reasons
-- listed there.
--
-- Four decisions.
--
-- **An attempt is a record, not a result.** A customer pressing Pay creates a
-- row that means "somebody set out to pay this invoice". It is not a payment.
-- The provider decides whether money moved, and says so out of band.
--
-- **Only a verified provider event may confirm one, and the schema enforces
-- that rather than trusting the code.** ADR 0004 says "browser redirects prove
-- nothing" and until now that was a sentence in a document: `confirmed`
-- requires a `webhook_event_id`, and a trigger refuses the row unless that
-- event's signature was verified. A redirect back from a provider cannot reach
-- the state that marks an invoice paid, because there is no column it could
-- write to do it.
--
-- **The customer's side can start a payment and can change nothing.** There is
-- no UPDATE policy for the application role at all. Advancing an attempt
-- happens on the privileged connection, from the notification endpoint, which
-- is the only place that has verified anything.
--
-- **Short payments behave exactly as the manual path already does.** A
-- confirmed R400 against a R500 invoice records R400 and leaves the invoice
-- issued. Marking it settled would make the figure an operator trusts quietly
-- wrong, which is the rule `recordSubscriptionPayment` was written around.

create table subscription_payment_attempts (
  id                     uuid primary key default gen_random_uuid(),
  invoice_id             uuid not null references subscription_invoices (id) on delete cascade,
  -- Carried rather than read through the invoice: every policy in this schema
  -- is keyed on it, and the one table where a customer may insert is not the
  -- place to make an exception.
  organisation_id        uuid not null references organisations (id) on delete cascade,
  provider               text not null,
  -- Ours, sent to the provider and echoed back by it. The provider's own id
  -- arrives later and is not available when the attempt is created.
  reference              text not null unique,
  amount_minor           bigint not null,
  currency_code          text not null,
  status                 text not null default 'created',
  started_by             uuid references auth.users (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  provider_reference     text,
  confirmed_at           timestamptz,
  amount_confirmed_minor bigint,
  -- What the provider kept, and what Spike actually received. ADR 0004's rule
  -- about fees applies to rent; for Spike's own invoices the fee is Spike's
  -- cost of collecting and the customer still paid the gross.
  fee_minor              bigint,
  net_minor              bigint,
  failure_reason         text,
  webhook_event_id       uuid references webhook_events (id),
  constraint attempt_amount_is_positive check (amount_minor > 0),
  constraint attempt_status_is_known
    check (status in ('created', 'pending', 'confirmed', 'failed', 'cancelled')),
  -- The whole of "a redirect proves nothing", in one constraint.
  constraint confirmation_needs_a_verified_event check (
    status <> 'confirmed'
    or (confirmed_at is not null and amount_confirmed_minor is not null
        and webhook_event_id is not null)
  )
);

comment on table subscription_payment_attempts is
  'Somebody setting out to pay one of Spike''s invoices, and what the provider '
  'said about it. An attempt is not a payment: only a verified provider event '
  'can confirm one.';

create index subscription_payment_attempts_invoice_idx
  on subscription_payment_attempts (invoice_id, created_at desc);

create index subscription_payment_attempts_open_idx
  on subscription_payment_attempts (status) where status in ('created', 'pending');

-- The constraint above can see that an event is referenced. It cannot see
-- whether that event was trusted, because that is a column on another table —
-- so the rule that actually matters needs a trigger.
create or replace function app.attempt_confirmation_is_verified()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verified boolean;
begin
  if new.status <> 'confirmed' then
    return new;
  end if;

  select signature_verified into v_verified
  from public.webhook_events where id = new.webhook_event_id;

  if v_verified is not true then
    raise exception
      'A payment may only be confirmed by a provider event whose signature was verified'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger subscription_payment_attempts_verified_confirmation
  before insert or update on subscription_payment_attempts
  for each row execute function app.attempt_confirmation_is_verified();

comment on function app.attempt_confirmation_is_verified() is
  'Refuses to let a payment attempt reach confirmed unless the provider event '
  'behind it had its signature verified. ADR 0004: a browser redirect proves '
  'nothing.';

alter table subscription_payment_attempts enable row level security;

-- Select, insert. No update and no delete for the application role, by
-- omission and on purpose: the only thing that may advance an attempt is the
-- notification endpoint, on the privileged connection, having verified
-- something.
grant select, insert on subscription_payment_attempts to propertyos_app;
grant select, insert, update on subscription_payment_attempts to propertyos_worker;

-- The customer's own administrator: the same permission that already lets them
-- read the invoice they are being asked to pay.
create policy subscription_payment_attempts_customer_select on subscription_payment_attempts
  for select using (app.has_permission(organisation_id, 'organisation.settings.manage'));

create policy subscription_payment_attempts_customer_insert on subscription_payment_attempts
  for insert with check (
    app.has_permission(organisation_id, 'organisation.settings.manage')
    -- Starting a payment is all they may do: a row that arrives already
    -- confirmed, or pointing at an event, is refused here as well as by the
    -- trigger.
    and status = 'created'
    and webhook_event_id is null
    and confirmed_at is null
    and started_by = auth.uid()
    and exists (
      select 1 from subscription_invoices i
      where i.id = invoice_id
        and i.organisation_id = subscription_payment_attempts.organisation_id
        and i.status = 'issued'
    )
  );

create policy subscription_payment_attempts_platform_select on subscription_payment_attempts
  for select using (app.is_platform_operator());

-- An operator may start one on a customer's behalf — the "they are on the
-- phone and cannot find the email" case — and no more than that.
create policy subscription_payment_attempts_platform_insert on subscription_payment_attempts
  for insert with check (
    app.platform_permission('platform.billing.manage')
    and status = 'created'
    and webhook_event_id is null
    and confirmed_at is null
  );

-- ---------------------------------------------------------------------------
-- The provider's own word
-- ---------------------------------------------------------------------------
--
-- `webhook_events` has had its (provider, provider_event_id) uniqueness since
-- 0004 and nothing has ever written to it: the dedupe was built for the
-- provider that did not exist yet. The worker and the notification endpoint
-- write it now; the application role still reads nothing, because a raw
-- provider payload is not customer-readable and a landlord has no business
-- reading another's.

grant select, insert, update on webhook_events to propertyos_worker;
