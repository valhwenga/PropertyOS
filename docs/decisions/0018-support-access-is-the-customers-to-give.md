# ADR 0018 — Support access is the customer's to give

**Status:** accepted
**Date:** 2026-10-21

## Context

The product has said, since the first migration, that Spike reaching a
customer's records "requires an authorised, time-limited, audited support
session". `app.support_organisation_ids()` was even commented as returning the
organisations the caller "holds a live, **authorised** support session for".

Two of the three were true. A session was time limited and audited, and it was
authorised by nobody: an operator inserted a row for themselves and read the
customer's records at once. `support_sessions.authorised_by` existed, was
nullable, and was set by no path in the codebase — so the customer's own screen
rendered the honest consequence, "Not authorised by you", against every session
there had ever been. ADR 0017 named this and the operator console says it.

## Decision

**An unapproved session reaches nothing.** The condition moves into the place
that decides every read: `app.support_organisation_ids()` and
`app.has_support_access()` now require `approved_at is not null`. Not a
filtered subset of the customer's records — nothing, because the set function
returns no organisation and every read policy is keyed on it. The test asserts
it on the read rather than on a flag: the same operator, the same session,
reads zero residents before the approval and the real set after it.

**Approval comes from the customer, two ways.** Either an administrator
approves that session, having seen who asked and why; or they opened a window
in advance (`support_access_grants`) and the session is approved on arrival,
recording which window admitted it. The window exists because a rule support
cannot work under gets worked around rather than followed: the case it serves
is "I am about to raise a ticket, come and look now" rather than a customer
sitting waiting to click approve. It is bounded in hours, attributed to the
person who opened it, revocable in one action, and **a session can never
outlast the window that approved it** — the expiry is the earlier of the two.

**There is no break-glass path.** An operator who can admit themselves in an
emergency can admit themselves at any time, and the product would be back where
it started with a longer comment. If nobody at the customer is available, Spike
waits or telephones them.

**Closing a window does not silently end the sessions opened under it.** Those
are separate records with their own expiry and their own revoke, and the screen
says how many are still live when the window closes. Ending them quietly would
mean the customer could not tell, from the window alone, what access they had
just taken away.

**Declining and ending are the same act on the same record.** A declined
request is a revoked session, so the history still shows that Spike asked, who
asked, and what for. Nothing erases a request.

### The part row-level security could not express

Migration 0065 made an unapproved session useless and left a way to approve
one. `support_sessions_platform_update` exists so an operator can revoke the
session they opened, it admits any update to their own row, and **policies are
OR-ed** — so an operator could ask, approve themselves, and read. 0065's own
closing comment asserted the opposite, reasoning from the other policy's
`WITH CHECK`; that reasoning was wrong, and a test which approved a session as
the operator who opened it found it.

It cannot be fixed with a policy. A `WITH CHECK` sees the new row and never
which column changed, so "may revoke but may not approve" is inexpressible:
forbidding `approved_at is not null` there would also stop an operator revoking
an approved session, which is the one thing they should always be able to do.

Migration 0066 uses a `before update` trigger, which can compare old with new.
The approval columns move only for a holder of the customer's own
`support.access.manage`, and only from unapproved to approved: an approval
cannot be edited away either, because ending a session is `revoked_at`, which
keeps the record. The insert side is closed by the window's own policy — a
window requires the customer's permission **and** `authorised_by = auth.uid()`,
and an operator can satisfy neither half. Both halves are tested.

## Consequences

* Existing sessions are **not** backfilled as approved. Backfilling would be a
  migration asserting a customer approval that never happened. They keep their
  history and lose their access, which costs nothing: this product has never
  been deployed and every session in existence belongs to a demo or a test.
* Support is slower by design. An operator opening a session now waits for a
  person, and the console says so plainly rather than showing a session that
  looks open and reads nothing.
* `supportAccessHistory` and the customer's half of this moved to
  `packages/domain/src/support-access.ts`. `platform.ts` is Spike asking; this
  is the customer deciding, and nothing in the new module consults whether the
  caller is a Spike operator — an operator holds no customer permission, so
  every function there refuses them by the ordinary route.
* A member without `support.access.manage` is told a window does **not exist**
  rather than that they may not touch it: the window's select policy is the
  same permission, and naming a record they cannot see would be the leak.
