/**
 * Schema-level invariants.
 *
 * These assert properties of the SCHEMA ITSELF rather than of any one feature,
 * so a table or view added in a future migration cannot quietly break a
 * guarantee the rest of the system depends on. Each failure message says what to
 * do about it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { closeOwner, ownerSql } from '../support/factories.js';

describe('Schema invariants', () => {
  afterAll(async () => { await closeOwner(); });

  it('every table has Row Level Security enabled', async () => {
    const rows = await ownerSql()<{ relname: string }[]>`
      select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
      order by c.relname
    `;
    // A table without RLS is readable by any authenticated session that has the
    // table privilege, regardless of organisation.
    expect(
      rows.map((r) => r.relname),
      'These tables have no Row Level Security. Add policies, or state in the ' +
        'migration why the table is deliberately global.',
    ).toEqual([]);
  });

  it('every table with RLS has at least one policy', async () => {
    const rows = await ownerSql()<{ relname: string }[]>`
      select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
      order by c.relname
    `;
    // RLS with no policy denies everything, which is safe but is almost always
    // an oversight rather than a decision.
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('every view runs with the invoker’s permissions', async () => {
    const rows = await ownerSql()<{ relname: string }[]>`
      select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
        and coalesce(
          (select option_value from pg_options_to_table(c.reloptions)
           where option_name = 'security_invoker'), 'false') <> 'true'
      order by c.relname
    `;
    // Without security_invoker a view runs as its OWNER, bypassing the Row
    // Level Security on the tables beneath it. That is a tenant isolation hole.
    expect(
      rows.map((r) => r.relname),
      'These views would bypass Row Level Security. Create them WITH (security_invoker = true).',
    ).toEqual([]);
  });

  it('every organisation-owned table carries organisation_id', async () => {
    const rows = await ownerSql()<{ relname: string }[]>`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname not in (
          -- Platform-level or reference tables, by design.
          'organisations', 'plans', 'plan_entitlements', 'roles', 'permissions',
          'role_permissions', 'user_profiles', 'memberships', 'membership_roles',
          'support_sessions', 'subscriptions', 'notification_templates',
          'schema_migrations', 'webhook_events', 'job_attempts',
          'auth_mfa_factors', 'auth_mfa_used_codes', 'auth_attempts',
          'app_privilege_exemptions', 'inspection_photos'
        )
        and not exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'organisation_id' and a.attnum > 0 and not a.attisdropped
        )
      order by c.relname
    `;
    expect(
      rows.map((r) => r.relname),
      'These tables hold customer data but have no organisation_id, so they ' +
        'cannot be isolated by the standard policies.',
    ).toEqual([]);
  });

  it('the application role cannot bypass Row Level Security', async () => {
    const [row] = await ownerSql()<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'propertyos_app'
    `;
    expect(row).toBeDefined();
    expect(row!.rolsuper).toBe(false);
    expect(row!.rolbypassrls).toBe(false);
  });

  it('posted financial history cannot be updated or deleted by the application role', async () => {
    const checks = await ownerSql()<
      { table_name: string; can_update: boolean; can_delete: boolean }[]
    >`
      select t.table_name,
             has_table_privilege('propertyos_app', t.table_name, 'UPDATE') as can_update,
             has_table_privilege('propertyos_app', t.table_name, 'DELETE') as can_delete
      from (values ('journals'), ('journal_lines')) as t(table_name)
    `;
    for (const check of checks) {
      expect(check.can_update, `${check.table_name} must not be updatable`).toBe(false);
      expect(check.can_delete, `${check.table_name} must not be deletable`).toBe(false);
    }
  });

  it('every stored monetary column is an exact integer type, never floating point', async () => {
    const rows = await ownerSql()<{ table_name: string; column_name: string; data_type: string }[]>`
      select c.table_name, c.column_name, c.data_type
      from information_schema.columns c
      join pg_class cl on cl.relname = c.table_name
      join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
      where c.table_schema = 'public'
        -- Base tables only. A view's sum(bigint) is numeric, which is exact;
        -- that behaviour is pinned by the next test instead.
        and cl.relkind = 'r'
        and (c.column_name like '%_minor' or c.column_name like '%amount%' or c.column_name like '%price%')
        and c.data_type <> 'bigint'
        -- Rates, shares and measurements legitimately use numeric with an
        -- explicit scale, and are never money.
        and c.column_name not in ('share_percent', 'escalation_percent', 'bathrooms', 'floor_area_sqm')
      order by c.table_name, c.column_name
    `;
    expect(
      rows.map((r) => `${r.table_name}.${r.column_name} (${r.data_type})`),
      'Money must be STORED as bigint minor units, never as floating point and ' +
        'never as unconstrained numeric.',
    ).toEqual([]);
  });

  it('view aggregates round-trip through BigInt without losing precision', async () => {
    // Postgres returns sum(bigint) as `numeric`, which is exact arbitrary
    // precision, and the driver hands it back as a string with no decimal point.
    // That is why the balance views are safe despite not being bigint. If a
    // driver upgrade ever started returning these as JS numbers, or with a
    // scale, this test is what notices.
    const [row] = await ownerSql()<{ total: string; pg_type: string }[]>`
      select sum(x) as total, pg_typeof(sum(x))::text as pg_type
      from (values (9007199254740993::bigint), (1::bigint)) v(x)
    `;
    expect(row!.pg_type).toBe('numeric');
    expect(typeof row!.total).toBe('string');
    expect(row!.total).not.toContain('.');
    expect(BigInt(row!.total)).toBe(9007199254740994n);
  });

  it('the schema can be rebuilt from empty, which this run already proved', async () => {
    const [row] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from schema_migrations
    `;
    // The test harness drops and recreates the database on every run, so a
    // green suite is itself the proof. This asserts the migrations actually ran.
    expect(Number(row!.count)).toBeGreaterThanOrEqual(18);
  });
});
