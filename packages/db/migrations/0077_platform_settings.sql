-- ---------------------------------------------------------------------------
-- 0077  Settings, and the flags that are settings
-- ---------------------------------------------------------------------------
--
-- Things the product decides are spread between environment variables, SQL
-- constants and numbers typed into `if` statements. A support session may last
-- "between 1 and 24 hours" because 24 is written in `openSupportSession`; a
-- customer who wants their resident portal switched off cannot have it,
-- because nothing switches it off. Changing either means a deploy.
--
-- One mechanism rather than two. A feature flag is a setting whose type is
-- boolean, and the only thing that distinguishes it from the support-session
-- hour limit is where it may be overridden. Two parallel systems with one
-- resolution order between them is how a flag and a setting end up disagreeing
-- about which wins.
--
-- Three decisions.
--
-- **Settings are declared in migrations, never invented in the console.** A
-- row here exists because code reads it. The alternative — a console that can
-- create a flag — produces flags nothing reads, which are worse than no flags:
-- somebody turns one off, nothing happens, and the next person cannot tell
-- whether the feature is broken or the flag is fiction. Every setting below is
-- read by code in this same commit.
--
-- **The default is in the registry, and the registry is the floor.** A setting
-- with no global value and no customer override resolves to its default, so
-- deleting a value is always safe and always returns the shipped behaviour.
-- There is no state in which a setting resolves to nothing.
--
-- **Resolution is one function, security definer.** The public rental
-- application form runs with no actor at all, so a flag that gates it has to
-- be readable without a session. Making the resolution a definer function
-- keeps every caller — anonymous, resident, member, operator — reading the
-- same answer, rather than each one's row-level visibility quietly producing
-- a different one.

create table platform_settings (
  key              text primary key,
  name             text not null,
  -- Written for the operator deciding, not for us.
  description      text not null,
  value_type       text not null check (value_type in ('boolean', 'integer')),
  default_value    text not null,
  min_value        integer,
  max_value        integer,
  -- Whether a single customer may have a different answer.
  per_organisation boolean not null default false,
  -- Whether the customer is told about it on their own settings screen. A
  -- feature switched off for somebody who cannot see that it is switched off
  -- is indistinguishable from a product that is broken.
  customer_visible boolean not null default false,
  sort             integer not null default 0
);

insert into platform_settings (
  key, name, description, value_type, default_value, min_value, max_value,
  per_organisation, customer_visible, sort
) values
  ('resident.portal', 'Resident portal',
   'Residents can sign in to see their own lease, statement and documents. '
   || 'Switching it off closes the portal for this customer''s residents; it changes '
   || 'nothing about the records themselves.',
   'boolean', 'true', null, null, true, true, 1),

  ('resident.maintenance_requests', 'Residents can raise maintenance requests',
   'Residents can log a request from their portal. With this off they can still see '
   || 'requests raised for them, and the landlord logs new ones.',
   'boolean', 'true', null, null, true, true, 2),

  ('public.application_links', 'Public application links',
   'The public rental application form, reached by a link the landlord shares. '
   || 'With this off an existing link stops working and says nothing about why.',
   'boolean', 'true', null, null, true, true, 3),

  ('support.session.max_hours', 'Longest support session',
   'The most hours a Spike operator may ask for in one support session. The customer '
   || 'can always end it sooner, and a session can never outlast the window that '
   || 'approved it.',
   'integer', '24', 1, 72, false, false, 10),

  ('support.window.max_hours', 'Longest support window',
   'The most hours a customer may leave support access open for in advance.',
   'integer', '72', 1, 168, false, false, 11);

-- A global value, where Spike has decided something other than the default.
create table platform_setting_values (
  key     text primary key references platform_settings (key) on delete cascade,
  value   text not null,
  reason  text not null check (length(btrim(reason)) between 5 and 500),
  set_by  uuid not null references auth.users (id),
  set_at  timestamptz not null default now()
);

-- And one customer's own answer, where the setting allows it.
create table organisation_setting_values (
  organisation_id uuid not null references organisations (id) on delete cascade,
  key             text not null references platform_settings (key) on delete cascade,
  value           text not null,
  reason          text not null check (length(btrim(reason)) between 5 and 500),
  set_by          uuid not null references auth.users (id),
  set_at          timestamptz not null default now(),
  primary key (organisation_id, key)
);

create index organisation_setting_values_key_idx on organisation_setting_values (key);

-- ---------------------------------------------------------------------------
-- A value has to be the thing it says it is
-- ---------------------------------------------------------------------------
create or replace function app.setting_value_is_valid()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  s platform_settings%rowtype;
  n integer;
begin
  select * into s from platform_settings where key = new.key;
  if s.key is null then
    raise exception 'There is no setting called "%".', new.key
      using errcode = 'invalid_parameter_value';
  end if;

  if s.value_type = 'boolean' then
    if new.value not in ('true', 'false') then
      raise exception '"%" is on or off, so its value must be true or false.', s.name
        using errcode = 'invalid_parameter_value';
    end if;
  elsif s.value_type = 'integer' then
    begin
      n := new.value::integer;
    exception when others then
      raise exception '"%" is a number, and "%" is not one.', s.name, new.value
        using errcode = 'invalid_parameter_value';
    end;
    if s.min_value is not null and n < s.min_value then
      raise exception '"%" cannot be less than %.', s.name, s.min_value
        using errcode = 'invalid_parameter_value';
    end if;
    if s.max_value is not null and n > s.max_value then
      raise exception '"%" cannot be more than %.', s.name, s.max_value
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  return new;
end;
$$;

create trigger platform_setting_values_valid
  before insert or update on platform_setting_values
  for each row execute function app.setting_value_is_valid();

create or replace function app.organisation_setting_is_allowed()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if not exists (
    select 1 from platform_settings where key = new.key and per_organisation
  ) then
    raise exception
      'The setting "%" is the same for every customer and cannot be set for one.', new.key
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end;
$$;

create trigger organisation_setting_values_allowed
  before insert or update on organisation_setting_values
  for each row execute function app.organisation_setting_is_allowed();
create trigger organisation_setting_values_valid
  before insert or update on organisation_setting_values
  for each row execute function app.setting_value_is_valid();

-- ---------------------------------------------------------------------------
-- Reading one
-- ---------------------------------------------------------------------------
--
-- Definer, so the anonymous caller reaching a public application link and the
-- operator looking at the console get the same answer. The order is the
-- customer's own value, then Spike's global one, then the shipped default —
-- and the default means there is no state in which this returns nothing.
create or replace function app.setting(p_org uuid, p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select v.value from public.organisation_setting_values v
      where v.organisation_id = p_org and v.key = p_key),
    (select v.value from public.platform_setting_values v where v.key = p_key),
    (select s.default_value from public.platform_settings s where s.key = p_key)
  );
$$;

create or replace function app.setting_enabled(p_org uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- An unknown key reads as OFF rather than ON. A typo in a flag name should
  -- withhold a feature, not quietly open one.
  select coalesce(app.setting(p_org, p_key) = 'true', false);
$$;

create or replace function app.setting_number(p_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select app.setting(null, p_key)::integer;
$$;

comment on function app.setting(uuid, text) is
  'The value of a setting for this organisation: their own, else Spike''s '
  'global one, else the shipped default. Never null for a declared setting.';

grant execute on function
  app.setting(uuid, text), app.setting_enabled(uuid, text), app.setting_number(text)
  to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- Who may read and change them
-- ---------------------------------------------------------------------------
alter table platform_settings enable row level security;
alter table platform_setting_values enable row level security;
alter table organisation_setting_values enable row level security;

-- The registry is a description of what can be configured and carries nobody's
-- data, so it is readable like any other reference table.
create policy platform_settings_read on platform_settings for select using (true);

create policy platform_setting_values_platform_select on platform_setting_values
  for select using (app.is_platform_operator());
create policy platform_setting_values_manage on platform_setting_values
  for all
  using (app.platform_permission('platform.config.manage'))
  with check (app.platform_permission('platform.config.manage'));

-- A customer reads their own, for the same reason they read the permissions
-- Spike granted them: a feature switched off without their knowing reads as a
-- fault in the product.
create policy organisation_setting_values_customer_select on organisation_setting_values
  for select using (organisation_id in (select app.member_organisation_ids()));
create policy organisation_setting_values_platform_select on organisation_setting_values
  for select using (app.is_platform_operator());
create policy organisation_setting_values_manage on organisation_setting_values
  for all
  using (app.platform_permission('platform.config.manage'))
  with check (app.platform_permission('platform.config.manage'));

grant select on platform_settings to propertyos_app, propertyos_worker;
grant select, insert, update, delete on platform_setting_values to propertyos_app;
grant select, insert, update, delete on organisation_setting_values to propertyos_app;
grant select on platform_setting_values, organisation_setting_values to propertyos_worker;

-- ---------------------------------------------------------------------------
-- The public application form reads its flag in SQL
-- ---------------------------------------------------------------------------
--
-- Both halves of the public path are gated, not just the screen: the details
-- function behind the page, and the submission itself. A form that renders and
-- then refuses on submit is a worse version of the same refusal, and the
-- submission is the half that writes.
CREATE OR REPLACE FUNCTION app.submit_rental_application(p_token text, p_full_name text, p_email text, p_phone text, p_current_address text, p_employment text, p_monthly_income_minor bigint, p_occupants integer, p_move_in_date date, p_message text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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

  -- The same sentence as a dead link, deliberately: a stranger holding a link
  -- is not told whether the landlord switched the feature off.
  if not app.setting_enabled(v_link.organisation_id, 'public.application_links') then
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
$function$;

-- And the read behind the page, so a switched-off link is indistinguishable
-- from one that never existed. Both of these are the LIVE definitions with
-- one condition added: rewriting them from memory produced a version that
-- joined the wrong table and notified every member rather than the managers,
-- which is the kind of change a flag migration has no business making.
CREATE OR REPLACE FUNCTION app.application_link_details(p_token text)
 RETURNS TABLE(organisation_name text, label text, unit_label text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  select o.name, al.label,
         case when u.id is null then null else p.name || ' / ' || u.code end
    from application_links al
    join organisations o on o.id = al.organisation_id
    left join units u on u.id = al.unit_id
    left join properties p on p.id = u.property_id
   where al.token = p_token
     and al.active
     and (al.expires_at is null or al.expires_at > now())
     and app.setting_enabled(al.organisation_id, 'public.application_links');
$function$;

select app.assert_table_privileges();
