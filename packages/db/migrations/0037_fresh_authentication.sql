-- 0037_fresh_authentication.sql
-- "Prove it is still you", as a database-resolved fact.
--
-- Assurance (0015) says a second factor was used at some point in this session.
-- Freshness says it was used RECENTLY. The two are not the same, and the
-- difference matters for exactly the operations the blueprint singles out:
-- changing where rent is paid, approving a deposit refund, releasing money.
-- An eight-hour session left open on an unattended machine is still aal2.
--
-- §4: "exceptional actions require fresh authentication and an audit reason."
-- §9: "show verified banking details in the portal and require fresh
-- authentication plus an audit trail for changes."
--
-- This lives in SQL for the same reason assurance does: an application-only
-- check is one forgotten call away from being no check at all, and a direct
-- database path would bypass it entirely.

-- The instant the session's authentication was established, from the JWT.
-- Supabase issues `auth_time`; the local development provider sets the same
-- claim after verifying a TOTP code, so the rule is identical in both.
create or replace function app.session_authenticated_at()
returns timestamptz
language sql
stable
as $$
  select to_timestamp((
    coalesce(
      nullif(current_setting('request.jwt.claim.auth_time', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'auth_time'
    )
  )::numeric)
$$;

comment on function app.session_authenticated_at() is
  'When this session last proved identity, from the auth_time claim. NULL when '
  'the claim is absent, which every caller must treat as stale rather than as '
  'unknown-therefore-fine.';

-- Whether the session proved identity within the given window.
--
-- Three ways to be false, and all of them must be: no second factor, no
-- auth_time claim at all, or an auth_time older than the window. A session that
-- somehow reports a FUTURE auth_time is also refused — a clock that disagrees
-- is not evidence of anything.
create or replace function app.authentication_is_fresh(p_within interval default interval '5 minutes')
returns boolean
language sql
stable
as $$
  select app.session_assurance_level() = 'aal2'
     and app.session_authenticated_at() is not null
     and app.session_authenticated_at() <= now() + interval '1 minute'
     and app.session_authenticated_at() > now() - p_within
$$;

comment on function app.authentication_is_fresh(interval) is
  'True only when a second factor was asserted within the window. Absent or '
  'future-dated claims are stale, never fresh.';

-- Raised as a distinct error code so the interface can offer re-verification
-- instead of the misleading "you do not have access".
create or replace function app.assert_fresh_authentication(
  p_within interval default interval '5 minutes'
)
returns void
language plpgsql
stable
as $$
begin
  if not app.authentication_is_fresh(p_within) then
    raise exception 'this action requires fresh authentication'
      using errcode = '28000',
            hint = 'Confirm your second factor again, then repeat the change.';
  end if;
end;
$$;

grant execute on function app.session_authenticated_at() to public;
grant execute on function app.authentication_is_fresh(interval) to public;
grant execute on function app.assert_fresh_authentication(interval) to public;
