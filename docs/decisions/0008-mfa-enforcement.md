# ADR 0008 — MFA as part of permission resolution

**Status:** accepted · **Date:** 2026-10-04

## Context

The blueprint requires multi-factor authentication for Spike administrators and
finance approvers. The obvious implementation is a check in the sign-in flow and
a guard in the UI.

That is not good enough. This codebase has several paths to a privileged action —
Server Actions, route handlers, the worker, and direct SQL in a migration or a
support session. A guard in one of them is a guard in one of them.

## Decision

**The assurance level is part of permission resolution itself.**

`app.has_permission(org, permission)` grants a permission only through a role
that is either not MFA-gated, or is MFA-gated **and** the session carries
`aal2`. A finance approver on a password-only session therefore does not hold
`billing.post` — not "is blocked from using it", does not hold it. The same
applies to `app.is_platform_operator()`, which gates the entire Spike console.

Consequences that follow for free:

* Row Level Security policies that call these functions inherit the rule. A
  single-factor platform operator sees **zero rows** in `organisations`, not an
  error page.
* A new command that forgets an MFA check still cannot perform an MFA-gated
  action, because the permission it needs is not granted.
* The rule is testable without a browser, and is covered by 13 tests.

## The claim

`aal1`/`aal2` follows Supabase's convention, read from the JWT. Two deliberate
choices:

1. **A missing claim means `aal1`.** The weaker state, never the stronger one.
   An old cookie, a bug in claim propagation, or a direct connection that forgets
   to set it all degrade to single factor rather than silently granting
   everything.
2. **Only the auth provider may declare `aal2`.** `supabaseVerifyMfa` re-reads
   the claim from the token Supabase returned and refuses if Supabase did not
   say `aal2`. The application never promotes its own session.

## Why TOTP is implemented locally

Production uses Supabase Auth, which owns enrolment and verification. But a
security control that can only be exercised against a live hosted project cannot
be tested in CI — and an untested MFA gate is indistinguishable from no gate.

So the local development provider implements RFC 6238 itself: real HMAC-SHA1
codes, a one-step drift window, constant-time comparison, and replay protection
through a unique key on (user, time step). Secrets live in a table that the
application role has **no privilege on at all**, reachable only by the
pre-session authentication path.

This is not a replacement for Supabase Auth. It is what makes the enforcement
above provable.

## What this does not give us

MFA enforcement is not MFA verification. Blocker 1 in
`docs/pilot-readiness.md` stands: the Supabase sign-in and challenge adapters
have never run against a live project. Password policy, breach detection,
account recovery and enrolment UI are all still Supabase's or still missing.
Recovery codes are not implemented.
