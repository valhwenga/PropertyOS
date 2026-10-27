-- ---------------------------------------------------------------------------
-- 0081  A way back in
-- ---------------------------------------------------------------------------
--
-- There was none. Multi-factor authentication is enforced, recovery codes are
-- issued once at enrolment, and there is deliberately no administrator reset
-- and no Spike reset — on the sound grounds that anybody who can clear a
-- colleague's second factor can take over their account. There is also no
-- password reset anywhere in this product.
--
-- So a landlord who forgets their password, or loses the phone with their
-- authenticator and cannot find the codes they were shown once, is locked out
-- of their own tenancy records permanently. The only fix in the product today
-- is a developer running `pnpm db:mfa` against the database, which is not a
-- product and does not survive a pilot.
--
-- What this adds is a recovery REQUEST: an asking, decided by somebody else.
--
-- **The customer's own administrator decides it, where there is one.** The
-- person who can tell whether this is really Thandiwe is the colleague who
-- works with her, not Spike. `membership.manage` already names that person —
-- it is the permission that invites and removes staff — and approving a
-- recovery is the same kind of act.
--
-- **Spike decides it only when nobody else can.** A solo landlord has no
-- colleague, and for them Spike must be able to act or the product is
-- unusable. That route is therefore enforced, not advised: the policies hide
-- the request from Spike entirely while another administrator exists.
--
-- **Spike's route waits, and says so first.** An approval by Spike takes
-- effect after a delay (a platform setting, 24 hours by default) during which
-- the notice goes to the address on the account, and the person themselves can
-- cancel it with a link that works while they are still locked out. A Spike
-- operator therefore cannot quietly take over an account: the owner is told
-- before it works, and can stop it. The customer's own route needs no delay,
-- because the approver is the customer.
--
-- **Approval is not entry.** It issues a single-use link, shown to whoever
-- approved it so they can hand it over the way they already hand over staff
-- invitations, and queued as a message for when there is a mail provider.
-- Approving and delivering are separate acts by separate people.
--
-- **The link does only what was lost.** A forgotten password does not clear a
-- second factor: resetting the password still leaves the authenticator in the
-- way, which is the whole point of having one.

insert into platform_permissions (key, description) values
  ('platform.customers.recover',
   'Approve a recovery for somebody whose organisation has nobody else who can');

-- Administrators only. It is the one permission that can put a person back
-- into an account they cannot otherwise reach.
insert into platform_role_permissions (role_key, permission_key) values
  ('platform_admin', 'platform.customers.recover');

insert into platform_settings (
  key, name, description, value_type, default_value, min_value, max_value,
  per_organisation, customer_visible, sort
) values
  ('recovery.spike_delay_hours', 'Wait before a Spike recovery takes effect',
   'Hours between Spike approving a recovery and the link working, during which '
   || 'the account holder is told and can cancel it. This is what stops an operator '
   || 'quietly taking over an account, so shortening it to zero removes the only '
   || 'protection the account holder has. It does not apply when the customer''s own '
   || 'administrator approves.',
   'integer', '24', 0, 168, false, false, 21);

-- ---------------------------------------------------------------------------
-- The request
-- ---------------------------------------------------------------------------

create table recovery_requests (
  id                  uuid primary key default gen_random_uuid(),
  -- As typed. There is deliberately no foreign key here: a request for an
  -- address with no account is still recorded, so the rate limit and the
  -- evidence exist, and nothing anywhere confirms to the person asking
  -- whether that address has an account at all.
  email               text not null,
  auth_user_id        uuid references auth.users (id) on delete cascade,
  lost                text not null,
  -- What the person said happened, in their words.
  note                text,
  ip_hash             text,
  created_at          timestamptz not null default now(),
  status              text not null default 'open',
  decided_route       text,
  decided_by          uuid references auth.users (id),
  decided_at          timestamptz,
  decision_reason     text,
  -- When the link starts working. Now, for the customer's own administrator;
  -- later, for Spike.
  effective_at        timestamptz,
  token_hash          bytea,
  token_expires_at    timestamptz,
  -- A cancel link that works while the person is still locked out, which is
  -- the only reason the delay protects anybody.
  cancel_token_hash   bytea,
  cancelled_at        timestamptz,
  cancelled_by        uuid references auth.users (id),
  cancellation_reason text,
  completed_at        timestamptz,
  constraint recovery_lost_is_known check (lost in ('password', 'second_factor', 'both')),
  constraint recovery_status_is_known
    check (status in ('open', 'approved', 'cancelled', 'completed')),
  constraint recovery_route_is_known
    check (decided_route is null or decided_route in ('organisation', 'spike')),
  -- A decision is all of its parts: a route and a time and a person, or none
  -- of them.
  constraint recovery_decision_is_whole check (
    (decided_at is null and decided_by is null and decided_route is null)
    or (decided_at is not null and decided_by is not null and decided_route is not null)
  ),
  constraint recovery_approval_has_a_window check (
    status <> 'approved' or (effective_at is not null and token_expires_at is not null)
  )
);

comment on table recovery_requests is
  'Somebody asking for a way back into their own account, and the decision '
  'somebody else made about it. Approval issues a single-use link rather than '
  'granting anything itself.';

-- One open request per address: a person clicking the form six times should
-- not produce six things for an administrator to decide.
create unique index recovery_requests_one_open_idx
  on recovery_requests (lower(email)) where status = 'open';

create index recovery_requests_person_idx
  on recovery_requests (auth_user_id) where status in ('open', 'approved');

alter table recovery_requests enable row level security;

grant select, update on recovery_requests to propertyos_app;
-- No INSERT grant, deliberately. Asking goes through
-- `app.request_account_recovery`, which rate limits by address and by network
-- and never tells the caller whether the account exists. An application role
-- that could insert directly could be driven into doing both.

-- ---------------------------------------------------------------------------
-- Who may decide one
-- ---------------------------------------------------------------------------
--
-- "Another administrator" means another active member, of an organisation this
-- person belongs to, holding `membership.manage` — through their roles or
-- through a permission this customer was given on top. The MFA condition in
-- `app.has_permission` is deliberately absent: the question is whether such a
-- person EXISTS, not whether they are holding a verified session right now.
--
-- What it cannot know is whether that person can actually sign in. Two
-- administrators who lose their phones in the same week are a support call,
-- and the console says so rather than pretending otherwise.

create or replace function app.recovery_other_admin_exists(p_auth_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships other
      on other.organisation_id = mine.organisation_id
     and other.auth_user_id <> mine.auth_user_id
     and other.status = 'active'
    join public.membership_roles mr on mr.membership_id = other.id
    where mine.auth_user_id = p_auth_user_id
      and mine.status = 'active'
      and (
        exists (
          select 1 from public.role_permissions rp
          where rp.role_key = mr.role_key and rp.permission_key = 'membership.manage'
        )
        or exists (
          select 1 from public.organisation_role_permissions orp
          where orp.organisation_id = other.organisation_id
            and orp.role_key = mr.role_key
            and orp.permission_key = 'membership.manage'
        )
      )
  );
$$;

comment on function app.recovery_other_admin_exists(uuid) is
  'Whether somebody else could put this person back into their account: an '
  'active colleague holding membership.manage. Decides whether Spike is even '
  'shown the request.';

grant execute on function app.recovery_other_admin_exists(uuid) to propertyos_app;

-- The customer's own administrator: the colleague who can tell whether this
-- really is the person asking.
create policy recovery_requests_org_admin_select on recovery_requests
  for select using (
    auth_user_id is not null
    and exists (
      select 1 from memberships m
      where m.auth_user_id = recovery_requests.auth_user_id
        and m.status = 'active'
        and app.has_permission(m.organisation_id, 'membership.manage')
    )
  );

create policy recovery_requests_org_admin_update on recovery_requests
  for update using (
    auth_user_id is not null
    and exists (
      select 1 from memberships m
      where m.auth_user_id = recovery_requests.auth_user_id
        and m.status = 'active'
        and app.has_permission(m.organisation_id, 'membership.manage')
    )
  ) with check (
    auth_user_id is not null
    and exists (
      select 1 from memberships m
      where m.auth_user_id = recovery_requests.auth_user_id
        and m.status = 'active'
        and app.has_permission(m.organisation_id, 'membership.manage')
    )
  );

-- Spike, and only where nobody else can. Not a guideline in a comment: while
-- another administrator exists, the row is not selectable by an operator at
-- all, so there is nothing to approve and nothing to read.
create policy recovery_requests_platform_select on recovery_requests
  for select using (
    app.platform_permission('platform.customers.recover')
    and (auth_user_id is null or not app.recovery_other_admin_exists(auth_user_id))
  );

create policy recovery_requests_platform_update on recovery_requests
  for update using (
    app.platform_permission('platform.customers.recover')
    and (auth_user_id is null or not app.recovery_other_admin_exists(auth_user_id))
  ) with check (
    app.platform_permission('platform.customers.recover')
    and (auth_user_id is null or not app.recovery_other_admin_exists(auth_user_id))
  );

-- ---------------------------------------------------------------------------
-- Asking
-- ---------------------------------------------------------------------------
--
-- Returns nothing. Not the request's id, not whether the address is known, not
-- whether one was already open — the screen says the same sentence either way,
-- because a form that answers differently for a real address is an account
-- enumeration tool with a helpful tone.

create or replace function app.request_account_recovery(
  p_email   text,
  p_lost    text,
  p_note    text,
  p_ip_hash text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_recent integer;
begin
  if p_lost not in ('password', 'second_factor', 'both') then
    raise exception 'Unknown kind of loss' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_email, ''))) < 3 then
    raise exception 'An email address is needed' using errcode = 'check_violation';
  end if;

  -- The same ceiling the public application form uses, and for the same
  -- reason: the form is reachable by anybody with the address of the site.
  if p_ip_hash is not null then
    select count(*) into v_recent
    from public.recovery_requests r
    where r.ip_hash = p_ip_hash and r.created_at > now() - interval '24 hours';
    if v_recent >= 5 then
      raise exception 'Too many recovery requests from this network today'
        using errcode = 'too_many_connections';
    end if;
  end if;

  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));

  insert into public.recovery_requests (email, auth_user_id, lost, note, ip_hash)
  values (btrim(p_email), v_user, p_lost, nullif(btrim(coalesce(p_note, '')), ''), p_ip_hash)
  on conflict (lower(email)) where status = 'open' do nothing;
end;
$$;

comment on function app.request_account_recovery(text, text, text, text) is
  'Records somebody asking for a way back into their account. Returns nothing '
  'at all: the screen says the same sentence whether or not the address has an '
  'account, so the form cannot be used to find out who has one.';

grant execute on function
  app.request_account_recovery(text, text, text, text) to propertyos_app;
