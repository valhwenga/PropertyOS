# Security and isolation model

## Trust boundaries

```
browser ──▶ Next.js server ──▶ propertyos_app_login ──▶ PostgreSQL (RLS enforced)
                   │
                   └────────▶ owner connection ── migrations and worker ONLY
```

1. **Identity comes only from the signed session cookie.** A user id in a URL,
   form field or header is never treated as identity. `src/lib/session.ts` is
   the sole writer of `auth.uid()`.
2. **Every request-scoped query runs as `propertyos_app`**, which is not the
   table owner, not a superuser, and does not hold `BYPASSRLS`. The application
   asserts this at startup (`assertApplicationRoleIsIsolated`) and refuses to
   serve traffic if the assertion fails.
3. **An organisation id supplied by the client is a filter, never a grant.**
   Policies resolve scope from the caller's own membership rows, so claiming
   another organisation's id returns nothing.
4. **The owner connection never serves a web request.** It is reachable only
   from the migration CLI and the worker, and the worker derives organisation
   scope from the stored job row it claimed.

## Layers of enforcement

| Concern | Database | Application |
| --- | --- | --- |
| Tenant isolation | RLS on every customer table; composite foreign keys carrying `organisation_id` | `resolveOrganisation` verifies active membership |
| Property scope | `app.can_access_property` in every property-table policy | `requirePropertyScope` before each command |
| Resident scope | `app.can_access_lease_as_resident`, driven by live portal links | Portal routes resolve leases from the viewer's own links |
| Permissions | Policies on membership and settings tables | `requirePermission` on every command |
| Support access | `app.has_support_access`: authorised, unexpired, read-only | `requireSupportAuthorisation` |
| Journal balance | Deferred constraint trigger, per currency | `postJournal` pre-check for a readable error |
| Immutability | `BEFORE UPDATE/DELETE` triggers; privileges revoked | Corrections issued as linked documents |
| Over-allocation | Trigger with `FOR UPDATE` on receipt then charge | Advisory pre-check only |
| Overlapping leases | GiST exclusion constraint | — |
| Duplicate billing | Unique index on (schedule, period, type) | Duplicates reported as skipped |

The database is the authority. The application layer exists to produce readable
errors, not to be the last line of defence.

## Deliberate "fail closed" behaviours

* A member with no scope assignment sees **no properties**, even in their own
  organisation.
* A revoked portal link removes resident access on the **next request**; there
  are no long-lived role claims in the session.
* Payment evidence has **no accounting effect** and no code path gives it one.
* A quarantined document cannot be shared — a check constraint blocks it.
* Email that was not delivered is never recorded as `sent`.
* A missing `APP_DATABASE_URL` is a startup failure, not a fallback to the
  privileged connection.

## Audit

Every command writes an `audit_events` row in the **same transaction** as the
change, so an action cannot commit without its audit record. Payloads pass
through `redact()`, which strips passwords, tokens, identity numbers, bank
account numbers and storage keys.
