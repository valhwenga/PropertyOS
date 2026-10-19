# ADR 0013 — A policy decides once, not once per row

**Status:** accepted · **Date:** 2026-10-19

## Why

Two screens missed §26's one-second target, and `docs/performance.md` recorded
a guess about why: that the collection metrics query had the wrong shape. The
guess was wrong, and the measurement that settled it is the reason this ADR
exists.

The same statement, on the same data, in the same second:

| Run as | Time |
| --- | ---: |
| the database owner (no Row Level Security) | 27ms |
| the application role | 1,300ms |

The data work was 2% of the cost. The other 98% was deciding, for each of six
thousand rows, whether the reader was allowed to see it.

## The rule

**A policy predicate must be a membership test against a set, never a function
call on the row.**

```sql
-- No. STABLE, but the argument changes per row, so it runs per row.
using (app.is_org_member(organisation_id))

-- Yes. Uncorrelated, so Postgres evaluates it once and hashes it.
using (organisation_id in (select app.member_organisation_ids()))
```

The same applies to resident access (`lease_id in (select
app.resident_lease_ids())`) and to the policies that used to reach a second
table through a correlated EXISTS: those became id-set functions of their own —
`app.resident_charge_line_ids()`, `app.resident_ticket_ids()`, and so on — which
also stops one table's policy dragging another table's policies in behind it.

Each set function is `stable security definer`, for the same reason the boolean
helpers were: the membership and portal tables have policies of their own, and
a policy that must consult a policy is where the per-row cost began.

The boolean helpers stay. `app.is_org_member` is still the right thing to call
from a security-definer function checking one row.

## What it was worth

| | Before | After |
| --- | ---: | ---: |
| 94 allocations joined to their charge lines | 878ms | 38ms |
| `collectionTotals` under the app role | 1,699ms | 217ms |
| Collection report, end to end | 3,003ms | 427ms |
| Overview, end to end | 2,532ms | 948ms |

All ten measured screens now meet the target. No query was rewritten and the
one index this work was expected to need was built, measured, found unused and
dropped.

## How it is kept

Migration 0057 converted the policies that existed — eight by hand, because
their shape changed, and the rest by a transformation that the migration then
asserts was complete. `tests/db/schema-invariants.test.ts` fails if any policy
calls one of the three helpers on a row, so the next one cannot be written the
old way without the suite saying so.

**What did not change is who can see what.** Every predicate resolves to the
same rows for the same caller: the membership must still be active, the support
session still live and held by a platform operator, the portal link still
unexpired. The isolation suites were not touched, and they pass — which is the
only reason a mechanical rewrite of 237 policies was a safe thing to do.
