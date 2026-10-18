-- ---------------------------------------------------------------------------
-- 0050  Taking your own data with you
-- ---------------------------------------------------------------------------
--
-- §24 asks for a documented customer export: properties, units, parties,
-- leases, charges, receipts, allocations, deposits, expenses and an attachment
-- manifest. Per-report CSV existed; there was no way to get the whole tenancy
-- history out, which makes leaving this product a negotiation rather than a
-- decision.
--
-- It is a permission of its own rather than a corner of settings management.
-- One file carrying every resident, every lease and every amount is a
-- different thing from changing an organisation's name, and the person who may
-- do the second is not automatically the person who should be able to walk out
-- with the first.

insert into permissions (key, description) values
  ('customer.export', 'Export the organisation''s own records as a documented archive')
on conflict (key) do nothing;

-- The organisation administrator only, and `org_admin` requires a second
-- factor, so the export is behind one without any further machinery: a
-- password alone does not produce this file.
insert into role_permissions (role_key, permission_key) values
  ('org_admin', 'customer.export')
on conflict do nothing;

select app.assert_table_privileges();
