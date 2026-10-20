-- ---------------------------------------------------------------------------
-- 0063  A replaced logo appears immediately in the portal too
-- ---------------------------------------------------------------------------
--
-- The console asks for `/app/<slug>/brand-logo?v=<when it changed>` and so sees
-- a new mark the moment it is uploaded. The resident portal asks for
-- `/portal/<lease>/brand-logo` with no version at all, and that route is served
-- with `Cache-Control: private, max-age=300` — correctly, because it is one
-- customer's asset on a page a resident opens repeatedly.
--
-- The two together mean a landlord who replaces their logo sees the new one in
-- their own console and the OLD one in their tenants' portal, for five minutes
-- or for however long the browser decides to keep the tab icon. The reasonable
-- conclusion from that is that the upload did not work.
--
-- So the resident read gains the same version the operator read has. It is a
-- timestamp of the organisation's own logo and nothing else: no name, no
-- identity, nothing a resident could not already see by looking at the mark.
drop function if exists app.resident_branding(uuid);

create function app.resident_branding(p_lease uuid)
returns table (
  accent text,
  typeface text,
  has_logo boolean,
  invoice_template text,
  logo_version text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.accent, b.typeface, b.logo_bytes is not null, b.invoice_template,
         to_char(b.logo_updated_at, 'YYYYMMDDHH24MISS')
  from public.leases l
  join public.organisation_branding b on b.organisation_id = l.organisation_id
  where l.id = p_lease
    and app.can_access_lease_as_resident(p_lease)
  limit 1;
$$;

comment on function app.resident_branding(uuid) is
  'The accent, typeface, invoice design and whether a logo exists, for a '
  'resident of this lease, with the moment the logo last changed so a replaced '
  'one is not served from a cache.';

grant execute on function app.resident_branding(uuid) to propertyos_app, propertyos_worker;

select app.assert_table_privileges();
