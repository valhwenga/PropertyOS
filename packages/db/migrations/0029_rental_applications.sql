-- 0029_rental_applications.sql
-- Rental applications captured from a link you can put anywhere.
--
-- The hard part is that the applicant is NOT signed in. They have a link and
-- nothing else, so auth.uid() is null and no row-level policy can recognise
-- them. Opening an insert policy to anonymous callers would let anyone write
-- rows for any organisation they could name, so instead a SECURITY DEFINER
-- function validates the token and does the insert. The token is the only
-- credential, which is why it is long, random, revocable and expiring.
--
-- What the public can do is exactly: submit one application against a live
-- link. They cannot read an application back — not even their own — because a
-- link that could read would turn every shared URL into a disclosure of
-- everyone else who applied.

create type app.rental_application_status as enum (
  'received', 'screening', 'approved', 'declined', 'withdrawn'
);

create table application_links (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references organisations(id),
  -- The secret in the URL. Unguessable, and the only thing standing between a
  -- stranger and writing a row, so it is generated with crypto randomness.
  token            text not null unique,
  label            text not null,
  unit_id          uuid,
  active           boolean not null default true,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id),

  constraint application_links_unit_fkey
    foreign key (unit_id, organisation_id) references units (id, organisation_id),
  constraint application_links_token_length check (length(token) >= 32)
);

-- Must exist before rental_applications references it: the composite foreign
-- key below is what makes an application unable to point at another
-- organisation's link.
create unique index application_links_id_org_idx
  on application_links (id, organisation_id);

create table rental_applications (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references organisations(id),
  link_id           uuid not null,
  reference         text not null,
  status            app.rental_application_status not null default 'received',

  full_name         text not null,
  email             text,
  phone             text,
  -- Deliberately NOT an identity number. An application is a first contact; a
  -- full identity number is collected later, under the sealed-field handling
  -- the rest of the product uses, once there is a reason to hold it.
  current_address   text,
  employment        text,
  monthly_income_minor bigint,
  occupants         integer,
  move_in_date      date,
  message           text,

  submitted_at      timestamptz not null default now(),
  reviewed_at       timestamptz,
  reviewed_by       uuid references auth.users(id),
  review_note       text,

  constraint rental_applications_link_fkey
    foreign key (link_id, organisation_id) references application_links (id, organisation_id),
  constraint rental_applications_income_nonnegative
    check (monthly_income_minor is null or monthly_income_minor >= 0),
  unique (organisation_id, reference)
);

create index on rental_applications (organisation_id, submitted_at desc);
create index on application_links (organisation_id, active);

alter table application_links enable row level security;
alter table rental_applications enable row level security;

create policy application_links_select on application_links
  for select using (app.is_org_member(organisation_id) or app.has_support_access(organisation_id));
create policy application_links_write on application_links
  for all using (app.is_org_member(organisation_id)) with check (app.is_org_member(organisation_id));

create policy rental_applications_select on rental_applications
  for select using (app.is_org_member(organisation_id) or app.has_support_access(organisation_id));
create policy rental_applications_update on rental_applications
  for update using (app.is_org_member(organisation_id)) with check (app.is_org_member(organisation_id));

grant select, insert, update, delete on application_links to propertyos_app;
grant select, update on rental_applications to propertyos_app;
-- No INSERT grant for the application role: the only way a row appears is
-- through the function below, which checks the token first.

/**
 * What a link says about itself, to someone holding it and nothing else.
 *
 * Returns the organisation's name and the unit label so the form can say who it
 * is for. It reveals nothing about any other application, and a dead or expired
 * token simply returns no row — the caller cannot tell "never existed" from
 * "revoked", which is the point.
 */
create or replace function app.application_link_details(p_token text)
returns table (organisation_name text, label text, unit_label text)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select o.name, al.label,
         case when u.id is null then null else p.name || ' / ' || u.code end
    from application_links al
    join organisations o on o.id = al.organisation_id
    left join units u on u.id = al.unit_id
    left join properties p on p.id = u.property_id
   where al.token = p_token
     and al.active
     and (al.expires_at is null or al.expires_at > now());
$$;

/**
 * Accepts one application against a live link.
 *
 * SECURITY DEFINER because the applicant has no session. The token is checked
 * here, inside the function, so the public surface is this one call and nothing
 * else. It returns only the reference the applicant can quote; it never returns
 * the row, the organisation id, or anything about other applicants.
 */
create or replace function app.submit_rental_application(
  p_token text,
  p_full_name text,
  p_email text,
  p_phone text,
  p_current_address text,
  p_employment text,
  p_monthly_income_minor bigint,
  p_occupants integer,
  p_move_in_date date,
  p_message text
)
returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_link   application_links%rowtype;
  v_ref    text;
  v_recent integer;
begin
  select * into v_link from application_links
   where token = p_token and active and (expires_at is null or expires_at > now());
  if v_link.id is null then
    raise exception 'This application link is not available.'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(btrim(coalesce(p_full_name, ''))) < 2 then
    raise exception 'Enter the applicant name.' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_email), '') = '' and coalesce(btrim(p_phone), '') = '' then
    raise exception 'Give an email address or a phone number so you can be contacted.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A crude but real brake on someone hammering a public URL. It bounds the
  -- damage rather than preventing it; a link under abuse should be revoked.
  select count(*) into v_recent from rental_applications
   where link_id = v_link.id and submitted_at > now() - interval '1 hour';
  if v_recent >= 50 then
    raise exception 'Too many applications through this link just now. Try again later.'
      using errcode = 'too_many_connections';
  end if;

  v_ref := 'APP-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));

  insert into rental_applications (
    organisation_id, link_id, reference, full_name, email, phone,
    current_address, employment, monthly_income_minor, occupants, move_in_date, message
  ) values (
    v_link.organisation_id, v_link.id, v_ref,
    btrim(p_full_name), nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_current_address, '')), ''),
    nullif(btrim(coalesce(p_employment, '')), ''),
    p_monthly_income_minor, p_occupants, p_move_in_date,
    nullif(btrim(coalesce(p_message, '')), '')
  );

  -- Tell the people who can act on it.
  insert into notifications (
    organisation_id, template_key, channel, recipient_user_id,
    title, subject, body, link_path, status, provider, sent_at
  )
  select distinct v_link.organisation_id, 'rental.application.received', 'in_app', m.auth_user_id,
         'New rental application',
         'New rental application',
         format('%s applied through “%s”. Reference %s.', btrim(p_full_name), v_link.label, v_ref),
         '/account/notifications', 'sent', 'in_app', now()
    from memberships m
    join membership_roles mr on mr.membership_id = m.id
   where m.organisation_id = v_link.organisation_id and m.status = 'active'
     and mr.role_key in ('org_admin', 'portfolio_manager', 'property_manager');

  return v_ref;
end;
$$;

revoke all on function app.application_link_details(text) from public;
revoke all on function app.submit_rental_application(text, text, text, text, text, text, bigint, integer, date, text) from public;
grant execute on function app.application_link_details(text) to propertyos_app;
grant execute on function app.submit_rental_application(text, text, text, text, text, text, bigint, integer, date, text) to propertyos_app;

select app.assert_table_privileges();
