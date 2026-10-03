# ADR 0001 — Organisation isolation

**Status:** accepted · **Date:** 2026-10-03

## Context

Weak organisation isolation is the top risk in the blueprint's register. A single
missed `WHERE organisation_id = ?` in one query would expose another landlord's
residents, bank references and financial history.

## Decision

Isolation is enforced at **three** independent layers.

1. **Structural.** Every organisation-owned table declares a unique
   `(organisation_id, id)` key, and every foreign key between customer tables is
   composite and carries `organisation_id`:

   ```sql
   foreign key (organisation_id, unit_id)
     references units (organisation_id, id)
   ```

   A lease in Organisation A therefore *cannot* reference a unit in
   Organisation B. This is a structural impossibility, not a policy that could
   be mis-written.

2. **Row Level Security.** Enabled on every customer table. Policies key only on
   `auth.uid()`, resolved from JWT claims the server sets after verifying the
   session. Helper functions (`app.is_org_member`, `app.can_access_property`,
   `app.can_access_lease_as_resident`) are `SECURITY DEFINER` with
   `search_path = ''` so the access tables can themselves carry RLS without the
   policies recursing.

3. **Command authorisation.** Each domain command calls `requirePermission` and,
   where relevant, `requirePropertyScope`, resolved against current membership.

## Consequences

* A client-supplied organisation id cannot widen access; it only filters.
* The application connects as a non-owner, non-superuser role, so RLS is always
  in force. The app asserts this at startup and refuses to run otherwise.
* Views are created `WITH (security_invoker = true)`; without it a view would run
  with the owner's privileges and become an isolation hole.
* Residents are not organisation members, so they needed narrowly scoped
  additive policies (migrations 0009 and 0010) to see their own home, their own
  statement, and nothing else. This was found by a failing test, not by review.
