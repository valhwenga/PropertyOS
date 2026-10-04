# Acceptance traceability — blueprint section 30

Every launch scenario in the blueprint, mapped to the automated test that proves
it. Run `pnpm test` to execute all of them.

| Blueprint scenario | Expected result | Proven by |
| --- | --- | --- |
| Organisation A requests B's lease, export or storage object | Denied without exposing record details | `db/isolation.test.ts` — "denies Organisation B's admin every read", "denies without exposing whether the record exists" |
| Property manager requests an unassigned property | Denied even within the same organisation | `db/isolation.test.ts` — "denies a property manager an unassigned property inside their OWN organisation" |
| Resident changes a lease ID in a request | Only authorised lease access succeeds | `db/isolation.test.ts` — "limits a resident to their own lease, even when they supply another lease id" |
| Two operators activate overlapping exclusive leases | One succeeds; the conflicting operation fails | `db/financial-invariants.test.ts` — "allows two DRAFTS on one unit but lets only one activation succeed" |
| Billing job crashes and retries | One charge per schedule/period and no duplicate journal | `integration/billing-run.test.ts` — "produces no duplicate charges when the same period is run again" |
| Bank imports overlap or repeat | True duplicates flagged; legitimate separate receipts preserved | `integration/acceptance.test.ts` — "Bank imports overlap or repeat" (4 tests, including same-amount same-day preservation) |
| Two allocations consume one receipt concurrently | Total allocation never exceeds the available receipt | `db/financial-invariants.test.ts` — "never lets two concurrent allocations overspend one receipt" |
| Partial payment of older arrears | Remaining balance keeps the correct due-date ageing | `db/financial-invariants.test.ts` — "leaves a partially paid charge in its original due date bucket" |
| Overpayment received | Excess remains credit with a traceable allocation history | `db/financial-invariants.test.ts` — "keeps an overpayment as traceable unapplied credit" |
| Proof uploaded without confirmed bank funds | No reduction of receivable | `integration/rent-workflow.test.ts` — "does NOT move the balance when a resident uploads proof of payment" |
| Provider event duplicates or arrives out of order | No duplicate posting; invalid transition reconciled | `integration/acceptance.test.ts` — "Provider events arrive twice or out of order" |
| Posted charge is wrong | Linked credit/reversal; original history retained | `db/financial-invariants.test.ts` — "corrects a wrong charge with a linked credit note, retaining the original" |
| Deposit refund attempted without evidence/permission | Blocked and logged | `integration/acceptance.test.ts` — "Deposit refund controls" (5 tests) |
| Lease expires but resident remains | Holdover occupancy visible; arrears retained | `db/financial-invariants.test.ts` — "keeps arrears and holdover occupancy after a lease expires" |
| Worker/email provider unavailable | Posted finance stays correct; durable jobs retry | `integration/acceptance.test.ts` — "Failed background jobs" (4 tests), "Email provider is unavailable" |
| Malicious or oversized upload | Rejected or quarantined before sharing | `integration/acceptance.test.ts` — "Malicious or oversized uploads" (6 tests); `integration/operations.test.ts` — quarantine constraint |
| Backup restored into isolated environment | Journals balance and original documents are accessible | `scripts/restore-verify.sh` — see the measured exercise in `docs/runbooks/recovery.md` |
| Portal tested on a small mobile screen | Statements and maintenance usable without horizontal scrolling | `tests/e2e/portal.spec.ts` — "has no horizontal scrolling on a small screen" |
| Private file access | Authorised, expiring, tamper-proof, recorded | `integration/integrations.test.ts` — signed URL tests; plus 15 HTTP checks covering tampered keys, extended expiry, expired links, cross-organisation and quarantined documents |

## Additional assertions beyond the blueprint table

| Area | Proven by |
| --- | --- |
| MFA is enforced for elevated roles, at the database | `db/mfa-enforcement.test.ts` (13 tests) |
| A missing assurance claim is treated as single factor | `db/mfa-enforcement.test.ts` — "treats a session with no assurance claim as single factor" |
| TOTP replay is refused | `db/mfa-enforcement.test.ts` — "reports the matched step so a code can be refused on replay" |
| Spike operators see no customer content without a support session | `db/isolation.test.ts` — ten content tables asserted empty |
| A writable or proxy support session cannot be created | `db/isolation.test.ts` — two tests |
| Dashboard figures reconcile to the records they link to | `integration/reports.test.ts` — "Dashboard metrics reconcile to their records" (5 tests) |
| Internal maintenance notes never reach a resident | `integration/operations.test.ts` — "hides internal comments from the resident" |
| Invitation tokens are hashed, consumed, and non-enumerable | `integration/operations.test.ts` — "resident invitations" (5 tests) |
| Money never passes through a JS float | `unit/money.test.ts`, `db/bigint-fidelity.test.ts` |

| Onboarding import (blueprint section 31) | Errors by row and field before committing; a failed import leaves no partial state | `integration/onboarding.test.ts` (28 tests), plus 20 HTTP checks on templates and the wizard |

| Adversarial review of the financial and isolation paths | Two real defects found and fixed; 52 other probes held | `db/adversarial.test.ts`, `db/adversarial-isolation.test.ts`, `db/adversarial-money.test.ts` (45 tests) · ADR 0010 |
| Schema invariants cannot be broken by a future migration | RLS on every table, security_invoker on every view, money stored as bigint | `db/schema-invariants.test.ts` (9 tests) |

| PDF statements open in a real reader and carry the right figures | Verified by `pdftotext`, an independent parser, not only by our own assertions | `integration/statement-pdf.test.ts` (16 tests) · plus 19 HTTP checks |

## What acceptance does NOT cover

These are honest gaps, not oversights. Each is listed in
[`known-limitations.md`](known-limitations.md):

* **No ClamAV daemon is deployed.** The scanner client is tested against a mock
  daemon for every documented reply shape, but has never spoken to real clamd,
  so no file in this build has been scanned by actual virus definitions.
  Validation and quarantine are the compensating controls.
* **SMTP has never spoken to a commercial provider.** The client is tested
  against a real in-process SMTP server, which proves the protocol but not
  deliverability, sender authentication or bounce handling.
* **Supabase Storage has never run against a live bucket.** The local
  filesystem adapter is exercised end to end over HTTP.
* **Supabase Auth sign-in is implemented but untested against a live project.**
  MFA *enforcement* is fully tested; MFA *verification* via Supabase is not.
* **No storage object backup** is configured, so the restore exercise verifies
  the database only. The script says so explicitly rather than implying files
  were recovered.
* **No load or performance testing** has been done. Capacity is unproven.
* **No independent security review or penetration test.**
