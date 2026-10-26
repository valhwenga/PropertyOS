# 0021 — Spike's own permissions

**Status:** accepted · 2026-10-26

## The problem

"Platform operator" was one boolean on `user_profiles`. Every operator could
do everything the console offers — change any customer's plan, suspend any
account, issue Spike's invoices, edit the system lease templates every customer
inherits — and the only way to make somebody an operator at all was an `UPDATE`
typed into psql. `platform.admin` existed in the customer permission catalogue
and was granted to nobody and checked nowhere.

A product that insists a landlord's own staff hold scoped, named, revocable
roles cannot run its own staff on a flag.

## What we decided

Platform authority becomes what customer authority already is: named
permissions, collected into roles, granted to a person, resolved on every call
against current grants.

- `platform_permissions` — eleven keys, each a thing the console can do.
- `platform_roles` — administrator, support, billing, read-only, with
  `is_admin` marking the one that can grant roles.
- `platform_operator_roles` — who holds what, with who granted it and when.
- `platform_operator_invitations` — how a colleague gets in at all.
- `app.platform_permission(key)` — the condition, used by both the domain
  layer and the policies.

### The boolean stays, and keeps its meaning

`is_platform_operator` is the door into the console and the condition inside
`app.is_platform_operator()`, which appears in policies across the schema and
carries the second-factor requirement. Redefining the most security-sensitive
function in the product would have been a rewrite for no gain. It now means
"may enter the console"; a role says what you may do once inside.
`app.platform_permission` is built **on** it, so a narrower role can never be a
way around the console door or the second factor.

### Every existing operator was backfilled to administrator

Otherwise the migration locks Spike out of its own product the moment the
checks land in code. Nothing about today's behaviour changes on deploy; scoping
begins when somebody is given a narrower role. The test fixtures follow the
same rule — an operator made by flipping the boolean holds everything — so the
existing suite keeps testing what it was written to test.

### The database agrees with the console

Giving the code a permission check is a check in one place. Migration 0073
restates every platform **write** policy in terms of the permission it is
really about, so a path that forgets the domain function is still refused by
the row. Reads stay broad on purpose: an operator in the console may see the
accounts, and the sensitive reads are counts-only — customer records still need
a support session, which none of this changes.

That rewrite is also where this work nearly introduced a hole. The first draft
of 0073 replaced

```sql
with check (app.is_platform_operator() and operator_user_id = auth.uid() and read_only)
```

with the permission alone — dropping the two conditions that make a support
session incapable of writing and incapable of being opened in a colleague's
name. `tests/db/isolation.test.ts` failed on both. The conditions are now
spelled out in 0073 with a comment saying why, rather than left to whoever
reads 0013.

### Two things the schema refuses outright

- **The last administrator cannot be removed.** A console nobody can administer
  is unrecoverable without a database connection, so a trigger refuses the
  revoke rather than trusting every caller to remember.
- **A role cannot be granted to somebody who is not an operator.** A grant left
  behind on a revoked operator is exactly what comes back when they are
  reinstated years later for an unrelated reason.

And one the domain refuses: **you cannot remove your own console access.** It
is the single change that cannot be undone from inside the console.

### Inviting a colleague

Spike staff belong to no organisation, so no existing invitation path could
reach them — there is nothing to be a member of. `/join-operator/<token>`
mirrors the staff invitation exactly: 32 random bytes, stored only as a
sha256, returned once, consumed on use, expiring in seven days. It is the only
path in the product that may set `is_platform_operator`, and it admits the one
address the invitation was issued to.

If that address already has an account, its password is required. An
invitation is authority over a role, never over an identity: without that
check, anybody holding the link could become that person and walk away with the
most privileged session in the product.

A new operator is sent to enrol an authenticator rather than into the console,
which refuses single-factor sessions — landing there would read as a broken
invitation.

## What this does not do

It does not let Spike into a customer's records. That remains a support session
the customer authorised, time-limited, read-only and audited. Making those
sessions capable of acting when a landlord asks is the next piece of work and
gets its own decision record.
