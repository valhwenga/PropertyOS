-- ---------------------------------------------------------------------------
-- 0049  The privilege guard had drifted
-- ---------------------------------------------------------------------------
--
-- 0017 added `app.assert_table_privileges()` so that a new table is either
-- granted to the application role or consciously exempted, and said it should
-- be run at the end of every migration that adds a table. Nothing made that
-- happen, so it stopped happening: `auth_mfa_recovery_codes` arrived in 0045
-- with its privileges deliberately revoked, like the factor table beside it,
-- but with no exemption row to say so.
--
-- Found by a restore rehearsal, not by a migration: once a restored archive
-- carried its grants, the guard was the natural post-restore check, and it
-- failed on a table that had been in this state since 0045.
--
-- The omission was documentation, not access: the revoke in 0045 is correct and
-- stays. What was missing was the record of why.

insert into app_privilege_exemptions (table_name, reason) values
  ('auth_mfa_recovery_codes',
   'Single-use codes that stand in for a lost authenticator. Pre-session '
   'authentication path only, on the privileged connection — the same '
   'treatment as auth_mfa_factors.')
on conflict (table_name) do nothing;

-- Prove the schema is consistent again as of this migration.
select app.assert_table_privileges();
