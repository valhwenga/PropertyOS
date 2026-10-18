-- ---------------------------------------------------------------------------
-- 0051  A resident may hold their own idempotency key
-- ---------------------------------------------------------------------------
--
-- 0006 gave `idempotency_keys` member-only policies, which was right while
-- billing runs were the only user of the table. The moment a resident-facing
-- command used one — submitting proof of payment, reporting a broken geyser —
-- the insert was refused: a resident is deliberately not a member of the
-- organisation whose portal they use.
--
-- Found by the browser test for a double tap, which is where it would have
-- been found in production: a resident clicking "Record this payment" twice
-- got "something went wrong" from the guard that exists to make that click
-- harmless.
--
-- The grant is narrow in two ways. It covers residents with LIVE portal access
-- to that organisation, through the same helper every other resident policy
-- uses, and it covers only rows whose actor is themselves — so one resident
-- can neither read nor replay another's key, and nothing here lets a resident
-- see a member's.

drop policy if exists idempotency_keys_select on idempotency_keys;
create policy idempotency_keys_select on idempotency_keys
  for select using (
    app.is_org_member(organisation_id)
    or app.has_support_access(organisation_id)
    or (app.is_resident_of_organisation(organisation_id) and actor_user_id = auth.uid())
  );

drop policy if exists idempotency_keys_insert on idempotency_keys;
create policy idempotency_keys_insert on idempotency_keys
  for insert with check (
    app.is_org_member(organisation_id)
    or (app.is_resident_of_organisation(organisation_id) and actor_user_id = auth.uid())
  );

-- The completing update writes the stored result on the row just claimed.
drop policy if exists idempotency_keys_update on idempotency_keys;
create policy idempotency_keys_update on idempotency_keys
  for update using (
    app.is_org_member(organisation_id)
    or (app.is_resident_of_organisation(organisation_id) and actor_user_id = auth.uid())
  ) with check (
    app.is_org_member(organisation_id)
    or (app.is_resident_of_organisation(organisation_id) and actor_user_id = auth.uid())
  );

-- Deleting stays with members. A resident has no reason to remove the record
-- that stops their own double submission from counting twice.

select app.assert_table_privileges();
