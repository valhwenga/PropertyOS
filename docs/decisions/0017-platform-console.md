# ADR 0017 — What a Spike operator may do, and what suspension means

**Status:** accepted
**Date:** 2026-10-21

## Context

The platform side of the product had a console with one page. `changePlan`,
`setAccountStatus`, `openSupportSession` and `closeSupportSession` existed in
`packages/domain/src/platform.ts`, were tested, and were reachable from no
screen in the application: the commercial operation of the business — moving a
customer up a plan, suspending one that is not paying, opening a bounded
session to answer a support ticket — could be performed only by somebody with a
database connection.

Three further things were found while building the screen, and each was worse
than the missing screen:

1. **Suspension did nothing.** `setAccountStatus` writes
   `organisations.status`, its own comment says "Suspension stops access", and
   nothing anywhere read the column — no policy, no permission function, no
   guard. A suspended customer's staff carried on working normally.

2. **The plan allowance was never enforced.** `requireEntitlement` was written
   and tested and called from nowhere, so every plan in the price list was
   unlimited in practice. A customer on the ten-unit plan could add five
   hundred.

3. **The customer could not revoke support access**, although their own screen
   said "You can revoke access at any time". The permission, the row-level
   policy and the domain function all existed; the button did not. Worse,
   `closeSupportSession` ran an `UPDATE` whose row-level policy makes a refusal
   affect zero rows rather than raise — so a member without
   `support.access.manage` would have been told their revoke succeeded while
   Spike's access continued.

## Decision

### The operator console shows Spike's conduct, not the customer's records

`/platform/customers/<slug>` carries account metadata, usage counts, the plan
and its allowances, the support sessions opened against the customer, and the
`platform.*` audit trail. Usage comes from `app.platform_customer_usage()`,
which returns counts and a byte total; the tables underneath remain closed to
an operator, so counting `units` directly on that connection would read zero
rows and the console would show an empty customer — correct row-level security
and a silently wrong number. A test asserts both halves of that: the direct
count is zero and the reported count is right.

Migration 0064 widens exactly three reads, all of them Spike's own conduct:
support sessions by any operator, `platform.%` audit entries, and the names of
other platform operators. Without the third, a session or a plan change made by
a colleague rendered with no name, and a review that cannot name who acted is
not a review. Everything else stays shut: a customer's own audit history, their
records, their staff's profiles.

### Suspension stops the console and nothing else

The check lives in `requireOperator`, which every console page and every Server
Action passes through — not in the layout, because the client router can serve
a cached layout while a new page loads, and a suspension that is only cosmetic
is worse than none. Suspended or closed staff arrive at
`/account-suspended/<slug>`, which sits outside the `/app/[org]` segment so the
guard cannot redirect to a page it guards.

What suspension deliberately does **not** touch:

* **the records.** Nothing is deleted, hidden or archived. The blueprint says
  not to treat suspension as deletion of properties, contracts or financial
  records, and the page says so to the person reading it.
* **the resident portal.** It is reached through a lease, not through
  `requireOperator`. A landlord's dispute with Spike is not a reason to take a
  tenant's statements away from them.
* **the billing run and the worker.** Rent keeps accruing. A suspended account
  that silently stopped charging rent would hand the customer a reconciliation
  problem on top of a commercial one.

### An allowance is enforced where the record is created

`requireEntitlement` is now called in `createUnit` and `inviteStaff`, after the
permission check so that somebody who may not perform the action at all is told
that rather than told to upgrade. Entitlements moved to
`packages/domain/src/entitlements.ts`: the enforcement points are in customer
code, and importing Spike's administration module from the portfolio would tie
the two together for no reason.

Counting pending invitations against the staff allowance is part of the
decision, not an implementation detail. The original query counted
`memberships` with `status in ('active', 'invited')`, and a membership row is
only written when an invitation is accepted — so no membership is ever
`invited`, a pending invitation counted as nothing, and an administrator at the
cap could invite as many colleagues as they liked and let each one walk through
it. An expired or revoked invitation grants nobody anything and is not counted.

Accepting an invitation that was validly issued is **not** re-checked. The seat
was given away when the invitation was issued, under a check; refusing the
person holding the link would punish them for their employer's plan.

### A refused revoke fails loudly

`closeSupportSession` now reads the `UPDATE`'s `returning` and raises
`forbidden` when it affected nothing. Revoking is the single control the whole
support-session design rests on, and a quiet failure there is the worst
available outcome — the customer believes they have ended access and has not.

## Consequences

* The demo organisation moves from the starter plan to portfolio. It seeds three
  staff and starter includes exactly three, so with the allowance enforced the
  demo would have refused its own invitation flow on the first click.
* A support session still records **no link to a customer approval**, because
  there is no screen on the customer's side that grants access in advance. The
  operator's form says so, and the customer's history shows "Not authorised by
  you". That gap is named rather than papered over; a customer-initiated
  authorisation flow is the obvious next piece of work.
* Nothing here invoices a customer. Spike has plans, prices, usage and an
  overage rate, and the console does the arithmetic an operator would otherwise
  do on paper — but no subscription invoice, payment or dunning exists anywhere
  in this product, and the page says that where somebody might assume otherwise.
