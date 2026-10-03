# ADR 0003 — Authentication as an adapter

**Status:** accepted · **Date:** 2026-10-03

## Context

The blueprint specifies Supabase Auth. But a schema whose Row Level Security can
only be exercised against a live Supabase project cannot be tested in CI or
developed offline — and untested RLS is indistinguishable from no RLS.

## Decision

Migrations create the `auth` schema, `auth.users` and `auth.uid()` **only if they
do not already exist**. On Supabase these are Supabase's own objects and the
migration is a no-op; on a plain PostgreSQL cluster it creates equivalents with
the same shape and the same `auth.uid()` semantics.

Consequently **every RLS policy in this repository is byte-for-byte identical in
both environments**, and the full isolation suite runs against a real database on
every test run.

Sign-in is an adapter:

* `AUTH_PROVIDER=supabase` — Supabase Auth owns credentials, sessions and MFA.
* `AUTH_PROVIDER=local` — development only; scrypt-hashed credentials in
  `auth.users`, no MFA, and the sign-in screen says so prominently.

## Consequences

* RLS is genuinely tested rather than assumed.
* The Supabase sign-in route is **not yet implemented** (see known limitations);
  it refuses with an explicit message rather than silently falling back.
* MFA enforcement for elevated roles is pending that integration. The
  `roles.requires_mfa` flag is modelled and seeded.
