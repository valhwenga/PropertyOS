-- ---------------------------------------------------------------------------
-- 0066  Only the customer can approve a support session
-- ---------------------------------------------------------------------------
--
-- 0065 made an unapproved session reach nothing, and left a way to approve one.
--
-- `support_sessions_platform_update` exists so that an operator can revoke the
-- session they opened, and it admits any update to their own row — including
-- setting `approved_at` and `authorised_by`. So Spike could ask, approve
-- itself, and read. 0065's own closing comment asserted the opposite, on the
-- grounds that the OTHER update policy requires the customer's permission;
-- that reasoning was wrong, because policies are OR-ed. A test that approved a
-- session as the operator who opened it found this, and it is the whole of the
-- control.
--
-- Row-level security cannot express it: a policy sees the new row, never which
-- column changed, so "may revoke but may not approve" is not a WITH CHECK —
-- forbidding `approved_at is not null` there would also stop an operator
-- revoking a session that IS approved, which is the one thing they should
-- always be able to do.
--
-- A trigger can. It compares old with new and lets the approval columns move
-- only for somebody holding the customer's own `support.access.manage`, and
-- only in the direction of approving: an approval cannot be withdrawn by
-- editing it away either, because ending a session is `revoked_at`, which
-- keeps the record of what happened.

create or replace function app.support_session_approval_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.approved_at is distinct from old.approved_at
     or new.authorised_by is distinct from old.authorised_by
     or new.approved_via_grant_id is distinct from old.approved_via_grant_id
  then
    -- Approving: only the customer, and only forwards.
    if old.approved_at is not null then
      raise exception 'A support session approval cannot be changed once given (session %).', old.id
        using errcode = 'check_violation';
    end if;
    if new.approved_at is null then
      raise exception 'A support session approval cannot be removed; end the session instead (session %).', old.id
        using errcode = 'check_violation';
    end if;
    if not app.has_permission(old.organisation_id, 'support.access.manage') then
      raise exception 'Only an administrator of this organisation can approve Spike support access.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

comment on function app.support_session_approval_guard() is
  'Lets the approval columns of a support session move only for a holder of '
  'the customer''s support.access.manage, and only from unapproved to '
  'approved. The operator who asked cannot answer for them.';

create trigger support_sessions_approval_guard
  before update on support_sessions
  for each row
  execute function app.support_session_approval_guard();

-- The INSERT path is the other half, and it is already closed: a session is
-- inserted by `app.is_platform_operator()` under
-- `support_sessions_platform_insert`, and the only path that writes
-- `approved_at` on insert is `openSupportSession` finding a window the customer
-- opened. A window is inserted under `support.access.manage` with
-- `authorised_by = auth.uid()`, so an operator cannot manufacture one: they
-- hold no customer permission. Tested from both sides.

select app.assert_table_privileges();
