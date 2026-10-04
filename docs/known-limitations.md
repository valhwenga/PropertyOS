# Known limitations and unresolved configuration

This document is deliberately blunt. The interface rendering is not evidence
that the product is finished.

## Not production ready

PropertyOS has **not** completed: an independent financial reconciliation, a
penetration test, a rehearsed restore from backup into an isolated environment,
a privacy/POPIA review, or a pilot acceptance sign-off. Do not invite real
residents until those are done.

## Unimplemented in this build

| Area | State | Consequence |
| --- | --- | --- |
| SMTP email delivery | **Implemented** | A dependency-free SMTP client with STARTTLS, AUTH PLAIN/LOGIN, dot-stuffing and RFC 2047 header encoding. `sent` is written only when the server issued a 2xx to the final DATA terminator. 8 tests against a real in-process SMTP server. Not yet exercised against a commercial provider, and there is no bounce or complaint handling. |
| Malware scanning | **Client implemented, no daemon deployed** | A ClamAV INSTREAM client, tested against a mock daemon for every documented reply shape. With `MALWARE_SCANNER` unset (the default) uploads are recorded `skipped_not_configured` and stay **quarantined**; a quarantined file cannot be shared, enforced by a database check constraint. A failed or timed-out scan is never treated as clean. **No clamd instance is deployed**, and the client has not been run against a real daemon. |
| Supabase Auth sign-in | **Implemented, not verified against a live project** | The adapter signs in and verifies MFA challenges over Supabase's REST API and reads the `aal` claim rather than assuming it. No code path has run against a real Supabase project, so password policy, breach detection and account recovery are unexercised. |
| Multi-factor authentication | **Enforced** | Part of permission resolution in the database (`app.has_permission` requires `aal2` for MFA-gated roles), so application code cannot bypass it. The local provider implements RFC 6238 TOTP with replay protection; Supabase owns verification in production. 13 tests. |
| MFA enrolment UI | Not built | Factors can be created programmatically; there is no screen for a user to enrol or to view recovery codes. Recovery codes are not implemented at all. |
| Session revocation | Time-based only | No server-side session store, so a stolen cookie is valid until it expires (8 hours). Membership and portal-link revocation take effect on the next request, which limits the blast radius. |
| Supabase Storage | **Implemented, not run against a real bucket** | Upload, read, signed-URL and delete against a private bucket, using the service role key server-side only. The local filesystem adapter is fully exercised end to end (15 HTTP checks). The Supabase path has never run against a live project. |
| Bank CSV import UI | Schema, deduplication and matching constraints complete | The import screen and mapping preview are not built. Duplicate protection is enforced at database level and covered by tests. |
| Content Security Policy | Permits `'unsafe-inline'` for scripts | Required by Next's inline hydration bootstrap. Tightening to a nonce-based policy is outstanding. |
| Rent payment provider | **Deliberately disabled** | See `docs/decisions/0004-money-flow.md`. Not to be enabled before merchant ownership and settlement are confirmed in writing. |
| Contractor portal | Schema and assignment model only | Phase 2 per the blueprint. Contractor-visible comments and attachments are already separated in the data model and enforced by RLS, ready for that portal. |
| Document upload UI | **Built for operators** | Upload with validation, scanning and quarantine; share control; authorised download. The resident photo attachment on a maintenance request is still not built. |
| Inspection capture UI | Commands, versioning and resident response complete | The inspector's item-by-item capture screen and photo attachment are not built. |
| Owner portal | Scope functions and policies exist | Phase 2 per the blueprint. `app.owns_property` and the owner read policies are in place. |
| Customer provisioning UI | `createOrganisationWithOwner` and the platform console exist | Self-service sign-up and the operator "provision a customer" form are not built; organisations are currently created by the seed script or programmatically. |
| CSV onboarding import | **Built** | Seven import kinds in the blueprint's order, with downloadable templates, row-and-field validation that writes nothing, and all-or-nothing commits. Opening balances require a cut-off date, source reference and approval. See `docs/runbooks/onboarding.md`. Document import (step 8 in the blueprint) is still not built, and there is no bulk portal-invitation step. |
| PDF statement export | Not built | Statements export as CSV. The blueprint also asks for PDF. |
| Utilities (meters, tariffs) | Phase 2 | MVP supports reviewed, manually entered utility charges only. |

## Business rules that need named human decisions

These are **configuration pending review**, not bugs. Each is implemented in a
way that fails safe until someone with the relevant authority decides.

1. **Deposit interest.** The system never calculates or accrues interest. A
   deposit interest credit requires an attached evidence document, enforced by a
   check constraint. An assumed rate must never be presented as earned interest.
   *Needs: legal and banking confirmation of the applicable basis.*
2. **Deposit refund deadlines.** No statutory deadline is hardcoded. Rental
   Housing Act timelines vary by circumstance and province.
   *Needs: legal review producing a versioned, configurable rule pack.*
3. **Late fees and penalties.** Not implemented, and not applied automatically.
   *Needs: legal and contract review before any penalty can be charged.*
4. **Allocation order.** Defaults to oldest due date first; the applied policy is
   recorded on every allocation row because the order changes arrears ageing.
   *Needs: operator and accountant confirmation.*
5. **Proration convention.** Defaults to actual occupied days ÷ days in the
   billing month, persisted with numerator and denominator on each line.
   *Needs: accountant sign-off before the first live cycle.*
6. **Opening balances.** Imported as explicit `opening_balance` charge documents
   with a source reference. They must be signed off by the operator and their
   accountant before the first billing cycle.
7. **Tax treatment.** Charges carry a `tax_classification`, defaulted to
   `residential_rent_exempt`. *Needs: confirmation of VAT treatment per
   customer segment.*

## Known behaviours that are correct but surprising

* **Independent rounding can lose a cent across three or more shares.** Three
  equal shares of R10.00 round to R3.33 each, totalling R9.99. Proration is
  per lease and a month is never split three ways between leases on one unit,
  so this does not arise in the billing path; it is recorded because it would
  if a future feature split one charge several ways.
* **Balance views return `numeric`, not `bigint`.** `sum(bigint)` is `numeric`
  in PostgreSQL. It is exact arbitrary precision and the driver returns it as an
  integer string, so no precision is lost. Pinned by
  `tests/db/schema-invariants.test.ts`.

## Operational gaps

* **Backups are not configured by this repository.** Supabase database backups
  do **not** include Storage object bytes; object backup must be arranged
  separately and both must be restore-tested together.
* **No uptime, error or performance monitoring is wired up.** The web app and
  worker emit structured JSON logs with correlation ids, and `/healthz` reports
  liveness plus the tenant-isolation self-check; nothing consumes any of it yet.
* **Rate limiting covers sign-in only** (per email and per client address).
  Uploads, exports, statement generation and invitation acceptance are
  unthrottled.
* **Recovery targets in the blueprint are targets, not capabilities.** A restore
  exercise HAS now been run and verified (see `docs/runbooks/recovery.md`), but
  against a 448 KB development dataset on a local machine. That measures the
  procedure, not a production recovery time.
* **No load or capacity testing.** Performance under realistic volume is unknown.
* **No dependency CVE scanning or SAST in CI**, and no independent penetration
  test. See `docs/security-review.md`.
