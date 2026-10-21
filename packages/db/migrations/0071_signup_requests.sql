-- ---------------------------------------------------------------------------
-- 0071  Asking for an account
-- ---------------------------------------------------------------------------
--
-- Until now the only way into the product was for a Spike operator to type a
-- landlord's details into /platform/new. A landlord who found the product had
-- no way to say so, which makes every customer an account somebody at Spike
-- already knew about.
--
-- This is deliberately a REQUEST, not a sign-up. Unattended account creation
-- needs two things this build does not have: an email provider, so that an
-- address can be proved to belong to whoever typed it, and a payment provider,
-- so that an account costs something to open. Without either, "create your
-- account" means anybody can mint organisations at any address, on any plan,
-- for nothing. So the form records an enquiry and Spike turns it into an
-- organisation through the existing provisioning path — the same invitation,
-- the same audit entry, the same operator second-factor check. The only thing
-- that changes is who starts it.
--
-- The table carries no organisation_id until it is approved, because until
-- then there is no organisation. That makes it one of the few tables in the
-- schema not keyed on membership: it is Spike's own queue, so the policy is
-- platform-operator or nobody.

create table signup_requests (
  id                 uuid primary key default gen_random_uuid(),
  organisation_name  text not null,
  contact_name       text not null,
  contact_email      text not null,
  contact_phone      text,
  -- What they say they manage. A number, not a plan: the plan is Spike's to
  -- choose on approval, and a self-declared figure is a sales signal rather
  -- than an entitlement.
  portfolio_size     integer,
  note               text,
  status             text not null default 'requested'
                       check (status in ('requested', 'provisioned', 'declined')),
  decline_reason     text,
  -- The same coarse grouping key the sign-in limiter uses: a hash, never an
  -- address, and only so that one machine cannot fill the queue.
  request_ip_hash    text,
  organisation_id    uuid references organisations(id),
  decided_by         uuid references auth.users (id),
  decided_at         timestamptz,
  created_at         timestamptz not null default now(),

  -- A decided row says what it became; an open one says neither.
  constraint signup_requests_decision_complete check (
    (status = 'requested'   and organisation_id is null and decided_at is null
                            and decline_reason is null)
    or (status = 'provisioned' and organisation_id is not null and decided_at is not null)
    or (status = 'declined'    and organisation_id is null and decided_at is not null)
  )
);

create index signup_requests_open_idx on signup_requests (created_at desc)
  where status = 'requested';
-- One open request per address, so a refreshed form or an impatient second
-- attempt does not become two accounts.
create unique index signup_requests_one_open_per_email
  on signup_requests (lower(contact_email)) where status = 'requested';

comment on table signup_requests is
  'Enquiries from landlords who want an account. Spike approves one by '
  'provisioning an organisation through the ordinary path; nothing here '
  'creates an organisation on its own.';

alter table signup_requests enable row level security;

-- Spike's queue, and only Spike's. There is no customer-side policy because
-- the person who submitted the form has no account to read it with — which is
-- the whole reason the row exists.
create policy signup_requests_platform_all on signup_requests
  for all
  using (app.is_platform_operator())
  with check (app.is_platform_operator());

-- No INSERT grant for the application role: the public form reaches the table
-- only through the security-definer function below, exactly as a rental
-- application does. A missing grant is a far better guarantee than a policy
-- somebody can widen later.
grant select, update on signup_requests to propertyos_app;

-- ---------------------------------------------------------------------------
-- The public write
-- ---------------------------------------------------------------------------
create or replace function app.request_platform_access(
  p_organisation_name text,
  p_contact_name text,
  p_contact_email text,
  p_contact_phone text,
  p_portfolio_size integer,
  p_note text,
  p_ip_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id     uuid;
  v_email  text := lower(btrim(coalesce(p_contact_email, '')));
  v_recent integer;
begin
  if length(btrim(coalesce(p_organisation_name, ''))) < 2 then
    raise exception 'Tell us what your business is called.'
      using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_contact_name, ''))) < 2 then
    raise exception 'Enter your name.' using errcode = 'invalid_parameter_value';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.' using errcode = 'invalid_parameter_value';
  end if;
  if p_portfolio_size is not null and (p_portfolio_size < 0 or p_portfolio_size > 1000000) then
    raise exception 'Enter how many units you manage as a whole number.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A brake rather than a defence, like every rate limit against an
  -- unauthenticated endpoint: it bounds how fast one machine can fill the
  -- queue. Nothing here proves the address is real, which is why a human
  -- reads the row before anything is created.
  if p_ip_hash is not null then
    select count(*) into v_recent from signup_requests
     where request_ip_hash = p_ip_hash and created_at > now() - interval '24 hours';
    if v_recent >= 5 then
      raise exception 'Too many requests from here today. Try again tomorrow.'
        using errcode = 'too_many_connections';
    end if;
  end if;

  insert into signup_requests (
    organisation_name, contact_name, contact_email, contact_phone,
    portfolio_size, note, request_ip_hash
  ) values (
    btrim(p_organisation_name), btrim(p_contact_name), v_email,
    nullif(btrim(coalesce(p_contact_phone, '')), ''),
    p_portfolio_size,
    nullif(btrim(coalesce(p_note, '')), ''),
    p_ip_hash
  )
  returning id into v_id;

  return v_id;
exception
  when unique_violation then
    -- The partial unique index above. Said as the truth rather than as an
    -- error: they already asked, and asking twice changes nothing.
    raise exception 'We already have a request from this address. We will be in touch.'
      using errcode = 'invalid_parameter_value';
end;
$$;

grant execute on function app.request_platform_access(
  text, text, text, text, integer, text, text
) to propertyos_app;
