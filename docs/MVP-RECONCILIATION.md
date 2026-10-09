# Blueprint reconciliation and MVP completion checklist

Reconciles *PropertyOS Product and Technology Blueprint v0.1* (3 October 2026)
against the implementation, and tracks what remains. Maintained as work lands —
a row moves only when the evidence named in it exists.

Blueprint §34 is the standard this document is held to: *"A feature that
displays mock totals is not complete finance functionality"*, and *"Do not
permit a coding assistant to declare the whole product production ready merely
because the pages render."*

## Completion scale

Every row carries one of four states. They are not degrees of confidence; they
are different kinds of evidence.

| State | Means |
|---|---|
| **Tested** | Implemented, with automated tests over the business rule, run and passing. |
| **Exercised** | Also driven through the running application by a person or a browser test, not only through its domain function. |
| **External** | Also exercised against the real third-party service it will use in production. |
| **Open** | Not built, or built without the evidence above. The note says which. |

A module at **Tested** is not finished. Three of the defects found in this
project — dead links to pages that were never built, an email path that silently
reached nobody, a PDF that rendered a fallback — all passed their domain tests.

## 1. Conflicts between the blueprint and the implementation

Points where the two genuinely disagree, and what was done.

| # | Blueprint | Implementation | Resolution |
|---|---|---|---|
| C1 | §14 *Rent billed: posted rent charges less rent credits.* *Current period collection: receipts allocated to current period rent over net rent billed.* | The overview divided allocations against **all** charges by **rent** billed; the collection report filtered neither side. | **Resolved.** One shared definition in `packages/domain/src/collection-metrics.ts`; both screens read it, two labelled measures, neither blended. |
| C2 | §14 *A management snapshot should be reproducible from the underlying records.* | Reports had no cut-off; reversals carried only a system timestamp, so a closed month restated when an allocation was corrected later. | **Resolved.** Business-date cut-off throughout; migration 0036 adds `allocated_on`/`reversed_on`. |
| C3 | §8 *Keep recurring charge schedules separate from issued charge documents. Preview a billing period before posting.* | Schedules, runs and previews exist in the domain and database. No screen posts a billing run. | **Open — §5 below.** The blueprint's first deliverable requires posting one charge through the interface. |
| C4 | §9 *Reconciliation has three distinct steps… An operator can split a receipt across several charges.* | Confirm, suggest, allocate, reverse and suspense all existed and were tested, with no screen performing any of them. The middle step had no command at all: money in suspense could only leave by being reversed. Reviewing a resident's proof of payment had no command either. | **Resolved.** `identifySuspenseReceipt` and `reviewPaymentEvidence` added; the whole workflow is driven through `/reconciliation` and verified in the browser. |
| C8 | §9 *Store bank account references securely, show verified banking details in the portal and require fresh authentication plus an audit trail for changes.* | `bank_accounts` carried `verified_at`/`verified_by` with nothing to say what "verified" meant, no change history, no screen, and no fresh-authentication mechanism existed anywhere. | **Resolved.** Migrations 0037–0038: a database-resolved freshness check, `verification_method` recorded and displayed in words, and an append-only `bank_account_changes`. |
| C9 | §7 *Activation requires… an attached executed contract or documented exception.* | The merge catalogue marked ten fields `essential` and **nothing read the flag**. An agreement missing the tenant's identity number, the rent or the commencement date could be generated *and shared with the resident*. | **Resolved.** Migration 0039 records the essential subset per generation; sharing refuses while it is non-empty. Drafting an incomplete agreement stays possible — it is how the gaps are seen. |
| C5 | §3 *Ownership is separate from organisation membership… A property may have several owners.* | No owner, ownership-interest or management-agreement tables. | **Open.** Blueprint puts the owner portal in Phase 2, but §18 lists the tables in the MVP schema. Deferred deliberately; recorded here rather than silently dropped. |
| C6 | §11 *Phase 2 meter readings…* and §24 *Bank feeds: Phase 2.* | Not built. | **Agrees.** Correctly out of MVP scope. |
| C7 | §29 Pricing, §28 budgets. | Plans and entitlements exist; no prices are published anywhere in the product. | **Agrees.** Blueprint calls these "pricing experiments, not validated competitive rates". Nothing should display them yet. |

## 2. Blueprint requirements the audit did not cover

The implementation audit examined what was built. These are blueprint
requirements it did not reach, and so could not report on.

| # | Requirement | Status |
|---|---|---|
| M1 | §31 *Opening balances need a cut off date, source reference and approval.* | **Open.** Import exists; opening balances have no approval step and no recorded sign-off. The blueprint makes an operator-and-accountant signature a precondition for go-live. |
| M2 | §31 *Import in order: properties, units, residents, leases, schedules, balances and documents. Show errors by row and field before committing.* | **Open.** Row-and-field error reporting is not built. |
| M3 | §22 recovery targets; §30 *Backup restored into isolated environment: journals balance and original documents are accessible.* | **Open.** `scripts/backup.sh` and `scripts/restore-verify.sh` exist; no rehearsed restore has been run or recorded. |
| M4 | §26 *Target ordinary page data reads under one second… Publish findings against the actual plan and dataset.* | **Open.** No load model, no measurements. The blueprint's test dataset is 50 organisations, 5,000 units, five years of charges. |
| M5 | §13 *Authenticate the sending domain with the provider's required DNS records.* | **Open — external.** Email is behind an adapter and honest about non-delivery, but no provider is configured. Requires a purchase and a DNS change: explicit authorisation needed. |
| M6 | §21 legal workstream — every row requires review *before activation*. | **Open — not an engineering task.** The master lease is drafted from the user's own two documents and is unreviewed by counsel. It must not be presented as legally settled. |
| M7 | §24 *Provide a documented customer export containing properties, units, parties, leases, charges, receipts, allocations, deposits, expenses and an attachment manifest.* | **Open.** Per-report CSV export exists; a whole-customer export does not. |
| M8 | §20 *Idempotency keys bind organisation, actor, command and payload hash.* | **Partial.** `idempotency_keys` exists and billing runs use it; ordinary commands do not. |
| M9 | §4 *Offer configurable two person approval for larger customers.* | **Open.** Single-approver only. |
| M11 | §9 *A suggested match is not automatically final.* | **Exercised.** Suggesting and applying are separate actions; the suggestion fills the form and the operator confirms or changes it. The stored policy records `manual` whenever a person confirmed the amounts, because the applied policy affects arrears ageing. |
| M10 | §19 *Require MFA for Spike administrators and finance approvers.* | **Exercised**, and now stronger: §4's *"exceptional actions require fresh authentication and an audit reason"* is enforced in the database for banking changes. Re-verification is implemented for the local auth provider only; on Supabase it refuses honestly rather than pretending. |

## 3. Where the implementation is ahead of the blueprint

Recorded so it is not mistaken for scope creep.

- **Lease agreement generation.** A 19-page master lease, 75 merge fields, PDF
  generation and in-browser preview. The blueprint puts templates in Phase 2
  (§5). Built at the user's explicit request from their own source documents.
- **MFA-aware permissions.** `app.has_permission()` requires `aal2` for gated
  roles, enforced in the database. §19 asks for MFA for administrators and
  finance approvers; this is stricter and enforced lower down.
- **Support access transparency.** Time-limited, audited, with a visible
  history screen. §19 asks for it; §4 does not require the operator-facing view.

## 4. Module checklist

Against the §5 MVP column.

| Module | State | Evidence and what is missing |
|---|---|---|
| Organisation identity and access | Exercised | Sign-in, MFA, memberships, roles, and re-verification for sensitive changes. Isolation suites cover two organisations and several property scopes. **Missing:** staff invitation and MFA enrolment/recovery screens. |
| Banking details | Exercised | Masked numbers, sealed storage, honest verification method, append-only change history, fresh authentication enforced in the database. **No bank is ever contacted** — see §6. |
| Portfolio | Exercised | Properties, units, standalone houses; create and detail screens; every link followed by `tests/e2e/navigation.spec.ts`. **Missing:** editing a property or unit; retiring a unit. |
| Residents | Exercised | Profiles, lease parties, invitations, detail screen, editing and sealed identity capture, all driven through the interface. Archiving rather than deletion. |
| Leasing | Exercised | Draft, activate, renew, terminate, notices with honest delivery reporting, agreement generation and preview. An agreement missing essential terms is a draft that cannot be sent. |
| Rent and receivables | Exercised | Recording money received, holding it in suspense, identifying the payer, suggested matching, operator-overridden partial allocation, unapplied credit and controlled reversal — all driven through the interface. Reviewing a resident's payment claim records a decision and moves no balance. |
| Billing | **Tested, not Exercised** | Schedules, runs, preview, proration, idempotent posting tested. **No screen posts a run.** |
| Deposits | **Tested, not Exercised** | Liability, interest, deductions, refund approval tested. Read-only screen. |
| Utilities | Tested | Fixed and manual line items via charges. No dedicated screen. |
| Expenses | **Tested, not Exercised** | Domain and read-only screen; no capture or approval. |
| Maintenance | Exercised | Report, triage, assign, quote, comment, resolve — through the interface, including the resident portal. |
| Inspections | **Tested, not Exercised** | Templates, items, acknowledgement tested. Read-only screen. |
| Documents | Exercised | Private storage, quarantine, type and size limits, authorised download, in-browser preview of generated PDFs only. **Malware scanning is not configured and is not claimed.** |
| Communications | Exercised | In-app inbox and email behind an adapter that never reports a message delivered when it was not sent. **No provider configured (M5).** |
| Analytics | Exercised | Collection, arrears ageing, occupancy, expenses, rent roll, deposits, lease expiry, journal lines; every headline reconciles to its rows, asserted in tests. |
| Staff | Open | Roles exist; no invitation or assignment screen. |
| AI | Agrees | None, by design. §23: *the launch does not require AI.* |
| Spike administration | Exercised | Customers, plans, entitlements, support sessions, platform lease templates. **Missing:** customer provisioning screen. |

## 5. Remaining order of work

As agreed with the user, and consistent with §34's *"foundation plus one
complete vertical workflow"*.

1. ~~Specification reconciliation and the dashboard metric defect~~ — **done**
   (commit `80cd99d`).
2. ~~Agreement data capture~~ — **done**. Resident editing and sealed identity
   capture; banking details with their own permissions, masked display, change
   history, honest verification status and fresh authentication; essential
   merge fields validated before an agreement can be sent.
3. ~~Receipt and allocation workflow through the interface~~ — **done**.
   Confirmation, suggested matching, partial allocation, unapplied credit,
   suspense identification and controlled reversal. Closes C4.
4. Monthly billing workflow through the interface: preview, exceptions,
   validation, approval, posting. Closes C3.
5. The rest of the MVP: approvals that act, deposits, bank statement import,
   expenses, inspections, portfolio and resident editing, audit history viewer,
   staff invitations, MFA enrolment and recovery, customer provisioning.
6. Navigation grouped into Portfolio, Finance, Operations and Administration;
   filters, loading states, reporting dates, actionable exception queues.
7. Pilot readiness: production-intended adapters exercised in isolated staging,
   missing credentials documented honestly, restore rehearsed (M3).

## 6. What cannot be verified here, and why

Stated plainly, because the blueprint asks for exactly this and the user's
instructions repeat it.

- **No bank feed and no statement import.** Every receipt in the product was
  entered by a person who saw the money in the account. Nothing invents a
  receipt, and nothing turns a resident's claim into one.
- **No external service has ever been contacted.** Email, payment, signature
  and accounting adapters have never run against a real provider. §24's
  qualification column is unanswered for every integration. In particular
  **PropertyOS never contacts a bank**: a bank account marked verified was
  marked so by a person, and the screen says which of the four methods they
  used rather than the bare word "verified".
- **Re-verification is implemented for the local development auth provider
  only.** Under `AUTH_PROVIDER=supabase` it refuses with an explanation rather
  than silently granting freshness. Sensitive changes are therefore unavailable
  on a Supabase deployment until that path is built and tested against the real
  service.
- **No production deployment, and no staging environment exists.** Everything
  below is from a local development container.
- **No restore has been rehearsed**, so the §22 recovery targets are
  aspirations, not measurements.
- **No legal review** of the lease, notices, deposit rules or money flow.
- **No accountant has validated the chart of accounts or posting model.** §10
  requires it before the financial model is used commercially.
- **No load testing.** §26's targets are untested.

Until these are closed, this product is at the stage the blueprint calls a
controlled pilot candidate — and not yet that, because the rent workflow in
§5 cannot be completed through the interface.
