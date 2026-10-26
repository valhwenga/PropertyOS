# 0024 — What a role can do

**Status:** accepted · 2026-10-26

## The problem

`roles`, `permissions` and `role_permissions` have been reference data since
the first migration: seeded by migrations, written by nothing, shown nowhere.
Two consequences.

Support could not answer *"why can't our portfolio manager approve that?"*
without reading SQL. And a customer who wanted their managers to do one extra
thing had to be told no, because the only lever was a migration that would
change it for every customer at once.

## What we decided

A read-only catalogue at `/platform/permissions`, and one narrow lever: an
extra permission, for one role, in **one** organisation, on the customer's own
page where the operator is already looking at them.

What a role can do stays the same for every customer and is still set by a
migration. A product's permission model is a product decision, and a console
that could redefine `property_manager` for everybody at once would make it an
operational one.

## The three rules that make the lever safe

**Grants only, never revokes.** An override can add a permission to a role and
cannot take one away. That single rule removes the whole class of accident this
feature would otherwise introduce: no combination of rows can lock a customer
out of their own account, strand an organisation with no administrator, or
narrow somebody's access between two page loads. What a customer wants taken
away they do by not assigning the role, which was always theirs to control.
"Remove" on the screen undoes a grant and nothing else, so the floor is the
same before and after.

**An overridden permission always requires a second factor.** MFA is a property
of the **role** in this schema — `roles.requires_mfa`, read by
`app.has_permission` — so granting an elevated permission to a role that does
not require MFA would hand out the permission without the second factor that
accompanies it everywhere else. `property_manager` has `requires_mfa = false`,
and `expense.record` is exactly the kind of thing a customer asks for on it.
The override branch therefore requires aal2 unconditionally: a permission
somebody asked for by email should not be easier to exercise than one the
product shipped.

**The customer sees it.** The policy lets their own members read their
overrides, their staff screen says *"Spike has given one of your roles an extra
permission"* with the role, the reason, the operator's name and the
second-factor condition, and it is audited against their organisation rather
than in a platform-only log beside it. Spike widening what a landlord's own
staff may do, with the landlord unable to see it, would be a back door however
complete the audit trail was.

A migration was needed for the last part: `user_profiles` was readable to a
customer only for an operator who had held a support session with them, so the
customer's screen could say "Spike" and not who. An integration test caught it
by expecting a name and getting null. The new policy is the same shape as the
support-session one, on the grounds that somebody changing what your colleagues
may do is at least as much your business as somebody reading your records.

## Two things the work found

**`platform.admin` is carried by a role.** `spike_operator`, from the original
seed, and nothing in the product checks that permission anywhere. What makes it
harmless is not the grant rules but `roles.assignable_to_staff = false`: no
customer administrator can hand it out, and `inviteStaff` refuses it by name.
The catalogue surfaces assignability for exactly this reason — "why is
`spike_operator` in this list?" is the first question a reader will have — and
the override trigger refuses `platform.admin` regardless, so the latent trap
needs two separate mistakes rather than one.

**The catalogue was already readable.** The first draft of migration 0076 added
`using (true)` policies to `roles`, `permissions` and `role_permissions` on the
assumption that reference data with no screen had no policies either, and
failed on the duplicate. They were readable all along; the screen was the only
thing missing.

## What this does not do

It does not let Spike change the model for everybody, and it does not let Spike
take anything away. It also does not offer per-member exceptions: the unit is a
role, because a permission attached to one person is invisible to whoever
reviews the role later.
