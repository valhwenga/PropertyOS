-- 0022_resident_lease_terms.sql
-- A resident may read the agreement terms of their own lease.
--
-- The portal began showing the lease term, notice period and renewal option so
-- a tenant asking "when does this end?" does not have to ask a person. The term
-- and notice period live on `leases`, which residents can already read, but the
-- renewal option lives on `lease_agreement_terms`, whose only select policy
-- required organisation membership. A resident is not a member of the
-- landlord's organisation, so the join silently returned nothing and the
-- renewal line never appeared — no error, just a missing fact.
--
-- Scoped to the leases the resident is actually a party to, through the same
-- helper every other resident policy uses. This is not widened to the
-- organisation: a resident has no business reading the schedule of anyone
-- else's lease.
create policy lease_agreement_terms_resident_select on lease_agreement_terms
  for select
  using (app.can_access_lease_as_resident(lease_id));

select app.assert_table_privileges();
