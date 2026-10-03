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
| SMTP email delivery | Adapter exists, client not implemented | Messages are recorded as `development_sink` and are **not delivered**. The UI says so. Nothing is ever reported as sent. |
| Malware scanning | Not configured | Uploads are recorded `skipped_not_configured` and stay **quarantined**. A quarantined file cannot be shared — enforced by a database check constraint, not just by code. |
| Supabase Auth sign-in route | Not implemented | `AUTH_PROVIDER=supabase` currently refuses sign-in with an explicit message. Development uses local credentials, **without MFA**. |
| Multi-factor authentication | Not enforced | The blueprint requires MFA for Spike administrators and finance approvers. The `roles.requires_mfa` flag exists and is seeded; enforcement is pending the Supabase Auth integration. |
| Supabase Storage | Metadata model complete, object transfer not wired | Document rows, visibility, quarantine and access grants work; actual upload/download against a private bucket is not implemented. |
| Bank CSV import UI | Schema, deduplication and matching constraints complete | The import screen and mapping preview are not built. Duplicate protection is enforced at database level and covered by tests. |
| Content Security Policy | Permits `'unsafe-inline'` for scripts | Required by Next's inline hydration bootstrap. Tightening to a nonce-based policy is outstanding. |
| Rent payment provider | **Deliberately disabled** | See `docs/decisions/0004-money-flow.md`. Not to be enabled before merchant ownership and settlement are confirmed in writing. |
| Contractor portal | Schema and assignment model only | Phase 2 per the blueprint. Contractor-visible comments and attachments are already separated in the data model and enforced by RLS, ready for that portal. |
| Document upload UI | Register/share/download commands and policies complete | The operator upload form and the resident photo attachment are not built; documents are currently registered programmatically. |
| Inspection capture UI | Commands, versioning and resident response complete | The inspector's item-by-item capture screen and photo attachment are not built. |
| Owner portal | Scope functions and policies exist | Phase 2 per the blueprint. |
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

## Operational gaps

* **Backups are not configured by this repository.** Supabase database backups
  do **not** include Storage object bytes; object backup must be arranged
  separately and both must be restore-tested together.
* **No uptime, error or performance monitoring is wired up.** The worker emits
  structured JSON logs; nothing consumes them yet.
* **Rate limiting** is not implemented on authentication or upload endpoints.
* **Recovery targets in the blueprint are targets, not capabilities.** An
  ordinary daily backup cannot deliver a one-hour recovery point.
