# 0025 — Settings, and the flags that are settings

**Status:** accepted · 2026-10-27

## The problem

Things the product decides were spread between environment variables, SQL
constants and numbers typed into `if` statements. A support session lasted
"between 1 and 24 hours" because `24` was written in `openSupportSession`. A
customer who wanted their resident portal switched off could not have it,
because nothing switched it off. Either change meant a deploy.

## What we decided

One mechanism. A **setting** has a declared type, a shipped default, optional
bounds, and may or may not be overridable for a single customer. A **feature
flag** is a setting whose type is boolean. There is no second system.

Two parallel systems would need a resolution order between them, and that is
exactly where a flag and a setting end up disagreeing about which wins.

Resolution is one security-definer function, `app.setting(org, key)`: the
customer's own value, then Spike's global one, then the shipped default. It is
a definer function because the public rental-application form runs with no
actor at all — every caller, anonymous to operator, has to read the same
answer, rather than each one's row visibility quietly producing a different
one.

## Three rules

**Settings are declared in migrations, never invented in the console.** A row
exists because code reads it. A console that could create a flag produces flags
nothing reads, which are worse than no flags: somebody switches one off,
nothing happens, and the next person cannot tell a broken feature from a
fictional one. Every setting shipped here is read by code in the same commit —
`/platform/settings` says so on the page, and that claim is only worth making
because it is true.

**The default is the floor.** A setting with no global value and no customer
override resolves to its default, so clearing a value always returns the
shipped behaviour and there is no state in which a setting resolves to nothing.
An *unknown* key reads as off rather than on: a typo in a flag name should
withhold a feature, not open one.

**The customer sees what was switched off.** Their settings screen names each
switched-off feature, the reason, and who at Spike did it. A feature switched
off for somebody who cannot see that it is switched off is indistinguishable
from a product that is broken, and they would open a support ticket about a
decision somebody already made.

## What shipped, and what reads it

| Setting | Read by |
| --- | --- |
| `resident.portal` | the query resolving a resident's leases in `getViewer` — one condition closes every portal screen and action |
| `resident.maintenance_requests` | `createTicket` on the resident path; the landlord's own staff are unaffected |
| `public.application_links` | both halves of the public form: the details function behind the page and the submission itself |
| `support.session.max_hours` | `openSupportSession`, where 24 used to be written |
| `support.window.max_hours` | `grantSupportAccess`, where 72 used to be written |

The public form is gated in **both** halves deliberately. A form that renders
and then refuses on submit is a worse version of the same refusal, and the
submission is the half that writes. A switched-off link gives the same sentence
as a dead one, so a stranger holding it is not told whether the landlord
switched the feature off.

## What the work found

**Rewriting a SQL function from memory changes it.** Gating the public form
meant editing two existing security-definer functions. The first draft wrote
them out by hand: it joined `buildings` where the real one joins `properties`,
and its notification insert went to every active member rather than to
administrators and managers only. Neither would have failed a test. Both
functions in the migration are now the live definitions with one condition
spliced in, built programmatically from `pg_get_functiondef` rather than
retyped, and the migration says so.

**Backticks in a SQL comment inside a tagged template are a parse error** —
third time in `tests/db/schema-invariants.test.ts` in this project, and the
second time in this session.

**Two portal browser specs failed and it was not this change.** The demo
database had drifted: an earlier run of the receipt-reversal spec left the
seeded R7,500 receipt reversed, so the statement no longer showed the R1,850
the spec expects. Confirmed by reseeding and re-running — twelve of twelve
pass. Worth recording because "my change broke the portal" was the obvious
reading and the wrong one.

## What this does not do

It has no per-customer *limits* — only features are overridable — because a
limit that differs per customer is a plan entitlement, and those already exist.
It has no scheduling, no gradual rollout and no targeting beyond one customer:
a flag that is on for 10% of somebody's residents is not something this product
has any use for yet, and the mechanism is easier to extend than to un-build.
