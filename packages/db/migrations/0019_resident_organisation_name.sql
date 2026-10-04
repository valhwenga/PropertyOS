-- 0019_resident_organisation_name.sql
-- A resident could not read the organisation row for the lease they hold, so
-- their own statement could not name their landlord — it rendered "Your
-- landlord" instead. A statement a resident keeps, forwards to their bank, or
-- takes to an advice office is much less useful if it does not say who issued
-- it or who to pay.
--
-- This grants read access to exactly the organisations a resident holds a live
-- portal link in, and nothing else. It exposes the trading name, country,
-- currency and time zone, which are on the lease agreement the resident already
-- signed. It exposes no other customer, and no operational data.

create policy organisations_resident_select on organisations
  for select
  using (app.is_resident_of_organisation(id));

comment on policy organisations_resident_select on organisations is
  'Lets a resident see the name of the organisation they rent from, so their statement can identify their landlord. Scoped to organisations they hold a live portal link in.';

select app.assert_table_privileges();
