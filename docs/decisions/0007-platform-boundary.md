# ADR 0007 — The Spike platform boundary

**Status:** accepted · **Date:** 2026-10-03

## The question this answers

Spike needs to run the platform: see which customers exist, what plan they are
on, how many units they are billed for, whether the queue is healthy. Spike must
**not** be able to browse residents, leases, balances or documents.

Those two requirements pull in opposite directions, so the line has to be drawn
explicitly rather than left to whoever writes the next query.

## The line

**Account metadata is open to a platform operator. Customer content is not.**

| Open to an operator | Closed without a support session |
| --- | --- |
| Organisation name, slug, status, country, currency, time zone | Residents, lease parties, contacts |
| Plan, subscription status | Leases, charges, receipts, allocations |
| Counts: units, staff, active leases, document bytes | Journals and journal lines |
| Job queue and outbox health | Documents, maintenance, inspections |
| Support sessions they themselves opened | The customer's own audit trail |

This was not the original posture. Milestone 1 denied operators the
`organisations` row entirely, and an isolation test asserted that. Building the
platform console forced the question, and the test was **changed deliberately**
to assert the boundary above — and simultaneously strengthened, so it now checks
that ten different customer-content tables return nothing for an operator, each
queried with a valid id the operator knows.

## How it is enforced

* `app.is_platform_operator()` gates policies on `organisations`,
  `subscriptions` and `support_sessions` only (migration 0013).
* **Usage counts come from `app.platform_customer_usage()`**, a `SECURITY
  DEFINER` function returning scalars. It spans tables the operator cannot read,
  and there is no column in its result through which a name, an amount or a
  record identifier could escape. An operator can learn that a customer has 37
  units; they cannot learn anything about one.
* A support session is the only route to customer content, and the policy makes
  two abuses impossible rather than merely discouraged:
  * `operator_user_id = auth.uid()` — an operator cannot grant access to a
    colleague;
  * `read_only = true` — a writable session cannot be created at all.
* Audit and outbox inserts are permitted so a platform action cannot commit
  without the record that explains it. Reading stays closed, except for the
  operator's own actions.

## Transparency is part of the boundary

A support log that says "an operator" accessed your data is not accountability.
Migration 0014 lets a customer read the profile of a platform operator who holds
a support session **for their organisation** — scoped to exactly those operators,
exposing nothing about Spike staff who never touched the account.

The customer-facing page shows who, when, why, for how long, how many actions
were recorded, whether the session was read-only, and whether the customer
authorised it. A session opened without customer authorisation is shown as such,
flagged, rather than hidden.

## Entitlements never damage billing correctness

A plan limit shapes what a customer may **add**. It never hides or deletes what
they already have. A customer over their unit allowance cannot create unit 11,
but all ten existing units stay fully visible, rent keeps posting and statements
stay correct. Commercial pressure must never be applied by breaking the ledger.
