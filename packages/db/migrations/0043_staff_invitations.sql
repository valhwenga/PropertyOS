-- ---------------------------------------------------------------------------
-- 0043  Staff invitations
-- ---------------------------------------------------------------------------
--
-- Roles, permissions and the per-role MFA requirement have existed since 0008.
-- There was no way to add a colleague: no command, no screen, nothing. An
-- organisation was created with exactly one member, and every test that needed
-- a second one inserted the rows with a privileged connection. So the
-- separation of duties the whole system is built around — a preparer who is
-- not the approver, an inspector who is not the person who signs off the
-- deduction — could not be set up by the customer at all.
--
-- An invitation is modelled like the resident portal link that already works:
-- a single-use token, stored only as a hash, with an expiry. The plain token
-- is returned once to the person who issued it and never stored, so a leaked
-- database does not hand over a way in.

create table staff_invitations (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  invited_email   citext not null,
  -- What to call them before they have an account of their own.
  full_name       text not null check (length(btrim(full_name)) between 2 and 160),
  -- The roles the invitation confers, applied when it is accepted rather than
  -- before: a pending invitation grants nothing.
  roles           text[] not null check (cardinality(roles) between 1 and 8),
  scope_type      text not null default 'organisation'
                  check (scope_type in ('organisation', 'portfolio', 'property')),
  property_id     uuid,
  portfolio_id    uuid,
  -- sha256 of the token. Cleared when the invitation is accepted, so it cannot
  -- be replayed to attach a second account.
  invite_token_hash bytea,
  status          text not null default 'invited'
                  check (status in ('invited', 'accepted', 'revoked', 'expired')),
  invited_by      uuid references auth.users (id),
  invited_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  accepted_user_id uuid references auth.users (id),
  revoked_at      timestamptz,
  revoked_by      uuid references auth.users (id),
  revoke_reason   text,
  unique (organisation_id, id),
  foreign key (organisation_id, property_id)
    references properties (organisation_id, id) on delete cascade,
  foreign key (organisation_id, portfolio_id)
    references portfolios (organisation_id, id) on delete cascade,
  -- A scope has to be coherent, or the member lands with access to nothing or
  -- to everything by accident.
  constraint staff_invitations_scope check (
    (scope_type = 'organisation' and property_id is null and portfolio_id is null)
    or (scope_type = 'property' and property_id is not null and portfolio_id is null)
    or (scope_type = 'portfolio' and portfolio_id is not null and property_id is null)
  ),
  -- Only an open invitation holds a usable token.
  constraint staff_invitations_token check (
    (status = 'invited') = (invite_token_hash is not null)
  ),
  constraint staff_invitations_accepted check (
    status <> 'accepted'
    or (accepted_at is not null and accepted_user_id is not null)
  ),
  constraint staff_invitations_revoked check (
    status <> 'revoked'
    or (revoked_at is not null and length(btrim(coalesce(revoke_reason, ''))) >= 5)
  )
);

-- One OPEN invitation per address per organisation. A second one would mean two
-- live tokens for the same person and no way to tell which was revoked.
create unique index staff_invitations_one_open
  on staff_invitations (organisation_id, invited_email)
  where status = 'invited';

create index staff_invitations_org_idx
  on staff_invitations (organisation_id, invited_at desc);

comment on table staff_invitations is
  'A pending invitation to join an organisation as staff. Grants nothing until '
  'it is accepted: the roles are applied at acceptance, not before.';

alter table staff_invitations enable row level security;

create policy staff_invitations_select on staff_invitations
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );

create policy staff_invitations_insert on staff_invitations
  for insert with check (app.is_org_member(organisation_id));

create policy staff_invitations_update on staff_invitations
  for update using (app.is_org_member(organisation_id));

-- No delete policy and no delete privilege: an invitation that was revoked is
-- part of the record of who was offered access and taken off it again.
grant select, insert, update on staff_invitations to propertyos_app, propertyos_worker;

-- The token hash is reachable only by the pre-session acceptance path, which
-- runs on its own connection: the signed-in application role can read the
-- invitation but has no business reading the material that redeems it.
revoke select (invite_token_hash) on staff_invitations
  from propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- Guard: the substance of an invitation is immutable
-- ---------------------------------------------------------------------------
--
-- Changing the roles or the address after it is sent would mean the thing
-- accepted is not the thing offered. Revoke it and issue another.

create or replace function app.guard_staff_invitation_update()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if new.invited_email <> old.invited_email
     or new.roles <> old.roles
     or new.scope_type <> old.scope_type
     or coalesce(new.property_id, '00000000-0000-0000-0000-000000000000'::uuid)
        <> coalesce(old.property_id, '00000000-0000-0000-0000-000000000000'::uuid)
     or coalesce(new.portfolio_id, '00000000-0000-0000-0000-000000000000'::uuid)
        <> coalesce(old.portfolio_id, '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception 'The substance of an invitation is immutable. Revoke it and issue another.'
      using errcode = '23514';
  end if;
  if old.status <> 'invited' and new.status <> old.status then
    raise exception 'An invitation that is already % cannot change state.', old.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger staff_invitations_guard
  before update on staff_invitations
  for each row execute function app.guard_staff_invitation_update();

create trigger staff_invitations_immutable
  before delete on staff_invitations
  for each row execute function app.block_financial_mutation();

-- ---------------------------------------------------------------------------
-- Which roles may be conferred on staff
-- ---------------------------------------------------------------------------
--
-- Declared in the database rather than only in the application, because the
-- consequence of getting it wrong is somebody holding a role the product never
-- meant to hand out. `spike_operator` is Spike's own and must never be
-- assignable by a customer; `resident` and `contractor` are portal roles that
-- arrive by their own invitations.

alter table roles add column assignable_to_staff boolean not null default false;

update roles set assignable_to_staff = true
 where key in ('org_admin', 'portfolio_manager', 'property_manager',
               'finance_preparer', 'finance_approver', 'owner_viewer');

comment on column roles.assignable_to_staff is
  'Whether an organisation administrator may confer this role on a colleague. '
  'False for Spike''s own role and for the portal roles, which arrive by their '
  'own invitations.';
