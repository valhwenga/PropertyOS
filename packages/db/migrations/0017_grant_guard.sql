-- 0017_grant_guard.sql
-- Migration 0007 granted table privileges to the application roles for the
-- tables that existed at that moment. Every table added since has had to
-- remember to grant for itself, and `import_batches` did not — which surfaced as
-- "permission denied" at runtime rather than at migration time.
--
-- This migration does two things:
--   1. grants the privileges that were missed;
--   2. adds a guard so the same omission fails the MIGRATION in future, loudly,
--      instead of reaching a user as a 500.

grant select, insert, update, delete on import_batches to propertyos_app, propertyos_worker;

-- Tables the application roles must deliberately NOT reach. Each is reachable
-- only by the pre-session authentication path on the privileged connection.
create table app_privilege_exemptions (
  table_name text primary key,
  reason     text not null
);

insert into app_privilege_exemptions (table_name, reason) values
  ('auth_mfa_factors',   'TOTP secrets. Pre-session authentication path only.'),
  ('auth_mfa_used_codes','TOTP replay guard. Pre-session authentication path only.'),
  ('auth_attempts',      'Sign-in attempt log. Pre-session authentication path only.'),
  ('app_privilege_exemptions', 'This table.');

/**
 * Fails if any table in `public` is neither granted to the application role nor
 * explicitly exempted.
 *
 * Run at the end of every future migration that adds a table. A new table is
 * then either usable or consciously unreachable — never accidentally either.
 */
create or replace function app.assert_table_privileges()
returns void
language plpgsql
as $$
declare
  v_missing text[];
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not exists (
      select 1 from app_privilege_exemptions e where e.table_name = c.relname
    )
    and not has_table_privilege('propertyos_app', c.oid, 'SELECT');

  if array_length(v_missing, 1) > 0 then
    raise exception
      'These tables have no privilege for propertyos_app and are not exempted: %. '
      'Add a GRANT, or add a row to app_privilege_exemptions explaining why the '
      'application must not reach them.',
      array_to_string(v_missing, ', ')
      using errcode = '42501';
  end if;
end;
$$;

-- Prove the schema is consistent as of this migration.
select app.assert_table_privileges();

alter table app_privilege_exemptions enable row level security;
create policy app_privilege_exemptions_none on app_privilege_exemptions for select using (false);
