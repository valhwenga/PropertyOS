-- 0010_resident_property_scope.sql
-- A resident is not an organisation member, so the property-scoped policies on
-- `properties` and `units` correctly denied them. But a resident must be able to
-- see the name and unit code of the home THEY rent, otherwise their own
-- statement cannot even be labelled.
--
-- These policies grant read access to exactly the property and unit behind a
-- lease the resident holds a live portal link for, and nothing else: a resident
-- never sees a neighbouring unit, the rest of the block, or any other property
-- in the organisation.

create policy properties_resident_select on properties
  for select
  using (
    exists (
      select 1 from leases l
      where l.property_id = properties.id
        and l.organisation_id = properties.organisation_id
        and app.can_access_lease_as_resident(l.id)
    )
  );

create policy units_resident_select on units
  for select
  using (
    exists (
      select 1 from leases l
      where l.unit_id = units.id
        and l.organisation_id = units.organisation_id
        and app.can_access_lease_as_resident(l.id)
    )
  );

-- Likewise an owner viewer, who is a member but is scoped to the properties
-- their party owns rather than to a manager assignment.
create or replace function app.owns_property(p_org uuid, p_property uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.owner_links ol
    join public.property_ownerships po
      on po.party_id = ol.party_id and po.organisation_id = ol.organisation_id
    where ol.auth_user_id = auth.uid()
      and ol.organisation_id = p_org
      and po.property_id = p_property
  );
$$;

grant execute on function app.owns_property(uuid, uuid) to propertyos_app, propertyos_worker;

create policy properties_owner_select on properties
  for select
  using (app.owns_property(organisation_id, id));

create policy units_owner_select on units
  for select
  using (app.owns_property(organisation_id, property_id));
