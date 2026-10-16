-- ---------------------------------------------------------------------------
-- 0045  Enrolling a second factor, and recovering from a lost one
-- ---------------------------------------------------------------------------
--
-- 0015 built the assurance machinery: a role can require a second factor, a
-- session carries its assurance level, and `app.has_permission` withholds an
-- elevated permission from a single-factor session. What it did not build was
-- any way for a person to enrol one. The only path was `pnpm db:mfa enrol`,
-- a developer command run against the database — so a colleague invited as a
-- finance approver could sign in, correctly see almost nothing, and have no
-- way out of that state without somebody with database access.
--
-- Recovery matters as much as enrolment. An authenticator lives on one phone.
-- When that phone is lost, an organisation whose only administrator held the
-- factor is locked out of its own records, and the alternative to recovery
-- codes is Spike reaching into a customer's account to reset it — which is
-- exactly the kind of access the rest of this schema works to make impossible.

create table auth_mfa_recovery_codes (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null references auth.users (id) on delete cascade,
  -- sha256 of the code. The codes are shown once, at generation, and never
  -- again: a stolen database must not yield a way past somebody's second
  -- factor.
  code_hash     bytea not null,
  created_at    timestamptz not null default now(),
  used_at       timestamptz,
  -- Which sign-in spent it, for the person asking "was that me?".
  used_ip_hash  text,
  unique (auth_user_id, code_hash)
);

create index auth_mfa_recovery_codes_unused_idx
  on auth_mfa_recovery_codes (auth_user_id) where used_at is null;

comment on table auth_mfa_recovery_codes is
  'Single-use codes that stand in for the authenticator when the device is '
  'lost. Stored as hashes; shown to the person once at generation.';

-- The same treatment as the factor table itself: reachable only by the
-- pre-session authentication path, on its own narrowly scoped connection. No
-- application policy at all, and the privileges revoked rather than merely
-- withheld by policy.
alter table auth_mfa_recovery_codes enable row level security;
create policy auth_mfa_recovery_codes_none on auth_mfa_recovery_codes
  for select using (false);
revoke all on auth_mfa_recovery_codes from propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- How much recovery is left
-- ---------------------------------------------------------------------------
--
-- A person needs to know they are down to their last code before they are
-- down to none. This returns a COUNT and nothing else: the codes themselves
-- stay unreachable, exactly as `app.has_verified_mfa` returns only the fact of
-- enrolment.

create or replace function app.unused_recovery_code_count(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    -- Only ever about yourself. A count is small, but "how much recovery does
    -- that administrator have left" is not a question one colleague should be
    -- able to ask about another.
    when auth.uid() = p_user then (
      select count(*)::int from public.auth_mfa_recovery_codes c
       where c.auth_user_id = p_user and c.used_at is null
    )
    else 0
  end;
$$;

grant execute on function app.unused_recovery_code_count(uuid)
  to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- Keeping the profile flag honest
-- ---------------------------------------------------------------------------
--
-- `user_profiles.mfa_enrolled` has existed since 0001 and nothing maintained
-- it, so it read false for everybody including accounts with a verified
-- factor. A flag that is always wrong is worse than no flag: somebody will
-- eventually trust it. It is now maintained by the factor table itself rather
-- than by whichever code path happens to remember.

create or replace function app.sync_mfa_enrolled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target uuid := coalesce(new.auth_user_id, old.auth_user_id);
begin
  update user_profiles p
     set mfa_enrolled = exists (
           select 1 from auth_mfa_factors f
            where f.auth_user_id = target and f.verified_at is not null
         ),
         updated_at = now()
   where p.auth_user_id = target;
  return null;
end;
$$;

create trigger auth_mfa_factors_sync_profile
  after insert or update or delete on auth_mfa_factors
  for each row execute function app.sync_mfa_enrolled();

-- Correct the rows that were never maintained.
update user_profiles p
   set mfa_enrolled = exists (
         select 1 from auth_mfa_factors f
          where f.auth_user_id = p.auth_user_id and f.verified_at is not null
       )
 where p.mfa_enrolled <> exists (
         select 1 from auth_mfa_factors f
          where f.auth_user_id = p.auth_user_id and f.verified_at is not null
       );
