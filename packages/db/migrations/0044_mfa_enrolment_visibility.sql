-- ---------------------------------------------------------------------------
-- 0044  Whether a colleague has enrolled a second factor
-- ---------------------------------------------------------------------------
--
-- The staff screen has to be able to say "this role needs a second factor and
-- this person has not enrolled one", because until they do the permissions are
-- withheld and the member looks fully set up while being unable to do their
-- job.
--
-- The first attempt at that read `auth_mfa_factors` directly from the staff
-- query, which broke a boundary 0015 set deliberately: that table holds TOTP
-- secrets and is reachable only by the pre-session authentication path, on its
-- own narrowly scoped connection. The privilege is revoked from the
-- application role and must stay revoked.
--
-- So the question is answered by a function that returns a BOOLEAN and nothing
-- else. The secret stays unreachable; only the fact of enrolment crosses.

create or replace function app.has_verified_mfa(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.auth_mfa_factors f
     where f.auth_user_id = p_user
       and f.verified_at is not null
  )
  -- Only about somebody the caller shares an organisation with. Otherwise this
  -- would answer "does this account exist and has it enrolled" for any user id
  -- anybody cared to try.
  and exists (
    select 1
      from public.memberships mine
      join public.memberships theirs
        on theirs.organisation_id = mine.organisation_id
     where mine.auth_user_id = auth.uid()
       and mine.status = 'active'
       and theirs.auth_user_id = p_user
  );
$$;

grant execute on function app.has_verified_mfa(uuid) to propertyos_app, propertyos_worker;

comment on function app.has_verified_mfa(uuid) is
  'Whether this user has a verified second factor. Returns only the fact, never '
  'the secret: auth_mfa_factors stays unreadable by the application role.';
