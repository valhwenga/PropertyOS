-- ---------------------------------------------------------------------------
-- 0047  Who a resident should contact
-- ---------------------------------------------------------------------------
--
-- The portal tells a resident to "tell your landlord" in several places and
-- never says how to reach one. The details exist: `organisation_profiles`
-- holds the letting party's phone and email and the managing agent's contact,
-- because the lease agreement is generated from them.
--
-- They are member-only, correctly: that row also carries the landlord's
-- identity number, sealed, beside the fields a tenant needs. So this returns
-- the contact fields and nothing else, to a resident of a lease in that
-- organisation.
--
-- Nothing here is a disclosure. Every one of these appears on the signed lease
-- the resident already holds; the portal is reuniting them with a copy at the
-- moment they need it, rather than at the bottom of a drawer.

create or replace function app.resident_landlord_contact(p_lease uuid)
returns table (
  trading_name text,
  phone text,
  email text,
  agent_name text,
  agent_contact text
)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(op.trading_name, ''), op.legal_name, o.name) as trading_name,
         op.phone, op.email, op.agent_name, op.agent_contact
  from public.leases l
  join public.organisations o on o.id = l.organisation_id
  left join public.organisation_profiles op on op.organisation_id = l.organisation_id
  where l.id = p_lease
    and app.can_access_lease_as_resident(p_lease)
  limit 1;
$$;

comment on function app.resident_landlord_contact(uuid) is
  'Contact details for the letting party, for a resident of this lease. Never returns identity data.';

grant execute on function app.resident_landlord_contact(uuid) to propertyos_app, propertyos_worker;
