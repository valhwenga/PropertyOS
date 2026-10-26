# 0022 — Support that can act

**Status:** accepted · 2026-10-26

## The problem

Support sessions were read-only from the day they were built. That was the
right default and the wrong end state. A landlord who writes *"the ticket for
12B is on the wrong unit, please move it"* could not be helped: Spike could see
the mistake and not touch it, so the answer was a list of instructions for the
customer to carry out on their own screen. That is not support, and the gap was
not a missing button — no policy in the schema let a support session write
anything.

## What we decided

A session can act, under four conditions, none of them optional:

1. the customer authorised it, in advance or in answer to a request;
2. the customer chose **what** it may do, from named scopes they can read;
3. it expires, and they can end it at any moment;
4. everything done under it is attributed to it in the audit trail.

Three scopes, worded for the person ticking the box: **Maintenance**,
**Property and lease records** ("cannot end a tenancy"), **Documents**
("identity documents stay closed"). Unticked is the default and is exactly the
old behaviour.

## Where the limits live

**Scopes are data with an allowlist in front of them.** A scope is a row
joining a customer permission to a thing a landlord recognises.
`app.support_grantable_permission` is an **allowlist**, so a permission
invented by a later migration is forbidden to support sessions until somebody
deliberately adds it. A denylist would have the opposite default, and the
opposite failure mode. A `CHECK` on `support_scope_permissions` enforces it, so
"support can move money" cannot be introduced by a one-line insert.

**Money and governance are not scopes and have no policy.** Nothing reaches
bank accounts, receipts, allocations, reversals, deposits, expenses, period
locks, memberships, support access itself, the bulk export, or identity
documents. Not "a scope nobody is given" — no policy on those tables mentions
support sessions at all, so the write is refused by the row whatever any code
believes. Redirecting rent and granting yourself permanent access are the two
attacks a support channel invites, and the schema cannot express them.

**The customer decides at approval, not the operator at request.** An
operator's `scopes` are honoured only against a window the customer already
opened carrying them, and narrowed to it — ask for three, hold a window for
one, get one. With no window, a request is read-only whatever was asked for,
and the person approving ticks what they are willing to give. The request text
is a sentence they read, not an entitlement.

**A session cannot widen after approval.** The guard from 0066 now covers
`scopes` too: they may move only in the same transition as the approval, by
somebody holding the customer's `support.access.manage`, and never afterwards.
Narrowing later is refused as well — ending the session is the way, because it
leaves a better record of what happened.

**The writes are a separate policy per table.** The alternative was editing
twenty existing policies to OR in a support clause, and the first draft of 0073
showed what that costs: conditions get dropped in the rewrite. Policies are
OR-ed anyway, so a `*_support_*` policy beside each existing one is the same
grant, visible on its own and removable on its own, leaving the membership path
untouched.

**Attribution is a trigger, not a convention.** `audit_events` has carried
`support_session_id` since the first migration and it was filled only where a
command remembered to pass it. Under sessions that can change records, "which
support session did this" must not depend on remembering, so the row stamps
itself.

## Two places the domain layer had to change

`requirePermission` gained a second way to hold a permission: a live approved
session carrying a scope that includes it. That one change is what lets every
existing command work under a session — nothing in `createTicket` knows what a
support session is.

`requirePropertyScope` likewise. What the customer authorises is access to
their *organisation* for a few hours, not to a list of properties: there is no
screen on which they could assign one, and no meaning to "Spike is assigned to
12B". The support write policies omit the property condition for the same
reason. The scope is still the limit — this says nothing about *what* may be
done.

## What this does not do

It does not give Spike standing access to anything. With no window open and no
approval, a session reaches nothing — unchanged. It also does not yet give the
operator a way to *use* this from the customer's own screens: `requireOperator`
still resolves organisations from membership, so the landlord console is not
reachable under a session. That is the next piece, and until it lands this
capability is reachable through the domain layer only.
