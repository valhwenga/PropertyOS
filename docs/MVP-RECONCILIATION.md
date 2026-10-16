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
| C25 | §4 *Separation of duties*, §34 *a figure is never read bare.* | The overview's **pending approvals** tile counted `deposit_events` where `approved_at is null` — a row the database forbids, because `deposit_events_refund_controls` requires an approver on every deduction and refund. The term was always zero. C13 fixed the approvals *queue* when payout requests got their own table and left the *count* behind, which is the worse half: a clerk raises a payout, the queue shows it, and the dashboard an approver actually looks at says there is nothing to do. Separately the **arrears** tile had always linked to the ageing report with `overdue=true`, which the report ignored — the number counted money past its due date and the page it opened listed every unpaid charge, this morning's invoice included. | **Resolved.** The count reads `deposit_payout_requests`, with a test that fails on the old query. `arrearsAgeing` honours `overdueOnly`, the flag appears as a control on the report, and the qualification says what was left out. Three queues that existed in the data and on no screen were added: a supplier cost approved and unpaid, a file nothing has scanned, and a lease signed off that nobody activated — which bills nobody. The expenses screen is paged and filtered by status, and a status asked for from the dashboard shows the whole queue whatever its date: a payables queue narrowed to this month is not a payables queue. |
| C24 | §26 *Target ordinary page data reads under one second against 50 organisations, 5,000 units and five years of charges.* §34 on screens that mislead. | Leases, residents and maintenance read **every row in the organisation** and filtered in JavaScript, on screens a letting agent keeps open all day. The documents list cut itself off at the most recent 200 and said nothing, which on screen is indistinguishable from having 200 documents; the expenses list did the same at 500. None of the four had a search box, a filter or a page. An archived resident could not be reached from anywhere in the product: the query excluded them unconditionally and nothing could ask. | **Resolved.** Filtering, searching and paging moved into SQL for all four, with `count(*) over ()` returning the size of the filtered set in the same round trip, so the line under each list says what it is showing out of what exists. Archived residents are behind a filter rather than behind nothing. The quarantine banner on Documents counts **every** held file, not the ones on this page: a safety statement that silently narrows to the current page is worse than none. Search terms are escaped, so a search for `100%` is a search for `100%` and not for everything. The expenses screen keeps its cap for now and states it. |
| C23 | §14 *A management snapshot should be reproducible from the underlying records.* §34 *A figure is never read bare.* | Every report read `from` and `to` from the URL and offered **no control that could set them**, so the period was whichever calendar month the server was in and the page never said which. The CSV route then parsed the query string a second time on its own and called five of the eight reports with **no filters at all**: a file downloaded from a narrowed screen could quietly contain everything, filed under a name claiming a period it never had. `ReportFilters.propertyIds` was honoured by four reports and offered by none. A malformed date reached PostgreSQL as `'banana'::date` and answered 500. | **Resolved.** One resolver and one runner (`apps/web/src/lib/report-shapes.ts`, `reports.ts`) used by both the screen and the export, so they cannot answer differently. Each report declares its shape — a range, an as-at date, a forward horizon, or a position that only exists now — and **only the controls it honours are rendered**: the arrears ageing is computed against the records as they stand, so it is offered no date to accept and discard, and journal lines are never narrowed by property because a bank receipt belongs to no single property and the extract would stop balancing. The report says so on its face. Property narrowing added to the deposit register, lease expiry and occupancy; the horizon and the property names now travel into the exported file in words, beside the exact JSON. An unreadable date falls back to the default **and says it did**. Also fixed: the default month was the server's UTC month, not the customer's. |
| C22 | The MVP brief's own order of work: *navigation grouped into Portfolio, Finance, Operations and Administration.* §4 *Separation of duties: a preparer cannot approve their own.* | Sixteen equal sections down the sidebar, every one of them shown to every member. A property manager was offered Billing, Deposits, Expenses, Approvals, Reports, Import and Settings; all seven refuse them, five after a page load. A menu that is wrong seven times out of sixteen teaches a new colleague that the product is mostly closed to them. | **Resolved.** Four groups, and each section keyed to the permissions that make it worth offering, resolved by `app.has_permission` in one query per page. Hiding is a **courtesy, not a control** — the server refuses exactly as it did, and a test follows a hidden link to prove it. The harder case was the opposite one: `org_admin` requires a second factor, so an administrator who has not enrolled holds everything and resolves nothing, and filtering alone would have left them an empty sidebar with no hint of the way out. `app.permission_needs_mfa` distinguishes "your roles do not include this" from "this session has only a password", and the second case is counted on the screen with a link to enrolment. Found while building it: the demo quotation document was registered with no bytes behind it, so its download link answered 404 from behind a correctly signed URL. |
| C21 | §24 *A customer organisation is provisioned with its own administrator.* | `createOrganisationWithOwner` has existed since the first migration with no screen, so every organisation in existence was created by the seed or by a test. | **Resolved.** `provisionCustomer` in `packages/domain/src/platform.ts` and a screen at `/platform/new`. The design decision is what Spike does **not** get: the obvious implementation makes the operator the founding administrator and expects somebody to remove them later, which is a Spike account inside customer data. A provisioned organisation starts with nobody in it instead. Two things this needed: `createOrganisationShell`, split out of `createOrganisationWithOwner` so an organisation can exist before it has a member; and `withPrivilegedActor`, a transaction that lifts row-level **filtering** while still carrying the caller's verified identity, so `requirePlatformOperator` — second factor included — runs in SQL rather than the privilege being its own authorisation. A test asserts a non-operator is refused on that privileged connection, since that is the one that can write. |
| C20 | §8 *Show the lease and recipient during invite review — an administrator linking an email to the wrong resident is a security incident risk.* | The review payload existed and **nothing rendered it**: `prepareInvitation`, `issueInvitation`, `acceptInvitation` and `revokePortalAccess` all had no screen, so the resident portal was unreachable by any real resident. | **Resolved.** A portal-access panel on the lease, and `/tenancy/<token>` to redeem. The recipient's name is restated before sending and verified server-side. Two defects found while building it: the acceptance page was first put under `/portal`, whose layout calls `requireViewer` — every first-time resident would have been bounced to a sign-in page for an account they cannot have; and `revalidatePath` after issuing re-rendered the panel into its revoke branch, **destroying the once-only token card before the operator could read the link**. |
| C19 | §19 *Require MFA for finance approvers and Spike administrators.* | 0015 built the whole assurance machinery — a role can require a second factor, a session carries its level, an elevated permission is withheld from a single-factor session — and **nothing let a person enrol one**. The only path was a developer command run against the database. There was also no recovery: an authenticator lives on one phone, and the alternative to recovery codes is Spike resetting a customer's factor, which is exactly the access the rest of the schema works to make impossible. | **Resolved.** Migration 0045 adds recovery codes (hashed, single use) and fixes `user_profiles.mfa_enrolled`, which had existed since 0001 maintained by nothing and read false for everybody. `apps/web/src/lib/mfa.ts` holds the logic, beside sign-in because the factor tables are unreadable by the application role. A screen at `/account/security`; a recovery option on the sign-in form. Found while building it: the second-factor step silently refused to submit because the password field clears between the two steps and is `required` — a user typed the code, clicked, and nothing happened. The step now says so. |
| C18 | §4 *Separation of duties: a preparer cannot approve their own.* §19 on roles. | Roles, permissions and the per-role MFA requirement have existed since 0008, and **nothing could add a member**. An organisation was created with one member and stayed that way; every test needing a second one inserted the rows on a privileged connection. So the control the rest of the product is built around could not be configured by the customer at all. | **Resolved.** Migrations 0043 and 0044, `packages/domain/src/staff.ts`, a Colleagues screen under Settings and a `/join/<token>` page that creates the account. An invitation grants nothing until accepted; the token is returned once and stored only as a hash; nobody may change their own roles, scope or access; the last active administrator cannot be stripped or suspended. Three defects found while building it, all mine: a staff query read `auth_mfa_factors` directly, which 0015 deliberately revokes from the application role (replaced with a function returning only the fact of enrolment); accepting with an existing account minted a session without checking the password, which was account takeover by invitation link; and marking an invitation expired inside the transaction that then threw discarded the write — the resident portal path had the identical bug and is fixed too. |
| C17 | §4 *Every privileged action is recorded with actor, time and reason.* §30 on evidence. | `recordAudit` wrote an entry for every command from the first migration, and **no code path could read one**. The trail was write-only: answering "who changed this, when, and why" needed database access, so the record that exists for a dispute could not be produced in one. | **Resolved.** Migration 0042 adds `audit.read` and an organisation-scope test; `packages/domain/src/audit-history.ts` reads the trail; the viewer lives under Settings. Reading is administrator-only, a property-scoped member is refused with the reason rather than shown a partial trail, and the entries stay append-only — the privilege to update them is revoked from the application role, so a reader cannot rewrite what they are reading. |
| C16 | §5 *Units can be retired without deleting history.* The MVP brief: *do not silently retire occupied units.* | Nothing could edit or retire anything. `createProperty` and `createUnit` existed, and `createUnit` had no screen either, so a property kept whatever units it was born with and an apartment block that gained a flat could never record it. A typo in a unit code needed database access. | **Resolved.** Edit screens for a property and a unit, adding a unit, retiring and reinstating, archiving. Retiring refuses while a lease on the unit is live — a draft included, because a draft is somebody's work in progress and orphaning it silently is the same fault — and the unit page states the refusal before the operator fills anything in. Two defects found while building it: a partial update recorded an omitted optional field as blanked in the audit while the SQL correctly left the column alone, and two forms on one page shared element ids so a label bound to the wrong input. |
| C15 | §9 *Import a bank statement and reconcile it.* §14. | The `bank_imports` and `bank_transactions` tables, and the two unique indexes that exist specifically to stop an overlapping statement being imported twice, had **no command that could write to them**. So the one task a landlord performs every month — sit down with the statement and work out who paid — had no support at all, and the reconciliation screen said bank import "is not built" while the schema was waiting for it. | **Resolved.** `packages/domain/src/bank-import.ts`, and the Bank statements screen under Reconciliation. The fingerprint carries an occurrence number counted across what the account already holds plus the rows before it in the file, which is what makes an overlapping statement idempotent while keeping two genuinely separate identical payments. |
| C12 | §4 *A preparer cannot approve their own.* §11 *Expenses… approval and payment status.* | `completeWorkOrder` wrote the expense with status **`approved`** for any invoice within the approved ceiling. Three things were wrong at once: no journal was posted, so the books carried an approved cost that was not in them; no approver was recorded, so "approved" named nobody; and the command requires only `expense.record`, so somebody who may record costs but not approve them could produce an approved one. The ticket page then displayed it as "Approved". | **Resolved.** The expense is always a draft. The ceiling authorised the spend; posting the cost is a separate act with its own permission and its own approver's name. An integration test that asserted `status: 'approved'` was asserting the defect and has been corrected. |
| C13 | §10 *Require documentary evidence, approval and a refund reference.* §4, on segregation of duties. | The approvals queue listed deposit movements "awaiting approval" by reading `deposit_events` where `approved_at is null`. The database **forbids** such a row: `deposit_events_refund_controls` requires an approver, evidence and a reason on every deduction, refund and transfer. The section could never show anything, and there was no request step at all — the approver had to enter every detail and name their own counterparty from a dropdown, which makes the second pair of eyes the clerk. | **Resolved.** Migration 0041 adds `deposit_payout_requests`. A pending request holds nothing, because the held balance is the sum of `deposit_events` and nothing is written there until approval. The requester's name comes from the stored request, never the approver's form. Browser-verified with two accounts. |
| C14 | §12 *A quote, its approval and the work order are separate steps.* | `recordQuote`, `approveQuoteAndIssueWorkOrder` and `completeWorkOrder` existed with **no screen anywhere in the product**, so maintenance spending could not happen at all, and the approvals queue listed submitted quotations with nothing to do about them. There was also no way to decline one, so a queue had only one exit. | **Resolved.** Quotation, approval into a work order with a ceiling, decline with a reason, and the supplier's invoice against completed work — all on the ticket page, with the three permissions kept distinct. `declineQuote` added. |
| C1 | §14 *Rent billed: posted rent charges less rent credits.* *Current period collection: receipts allocated to current period rent over net rent billed.* | The overview divided allocations against **all** charges by **rent** billed; the collection report filtered neither side. | **Resolved.** One shared definition in `packages/domain/src/collection-metrics.ts`; both screens read it, two labelled measures, neither blended. |
| C2 | §14 *A management snapshot should be reproducible from the underlying records.* | Reports had no cut-off; reversals carried only a system timestamp, so a closed month restated when an allocation was corrected later. | **Resolved.** Business-date cut-off throughout; migration 0036 adds `allocated_on`/`reversed_on`. |
| C3 | §8 *Keep recurring charge schedules separate from issued charge documents. Preview a billing period before posting.* | Schedules, runs, previews, version guards and idempotent posting all existed; the Billing screen was read-only and carried a note saying posting was not wired up. | **Resolved.** Preview → prepare → validation report → approve and post → batch summary, all through the interface. |
| C4 | §9 *Reconciliation has three distinct steps… An operator can split a receipt across several charges.* | Confirm, suggest, allocate, reverse and suspense all existed and were tested, with no screen performing any of them. The middle step had no command at all: money in suspense could only leave by being reversed. Reviewing a resident's proof of payment had no command either. | **Resolved.** `identifySuspenseReceipt` and `reviewPaymentEvidence` added; the whole workflow is driven through `/reconciliation` and verified in the browser. |
| C8 | §9 *Store bank account references securely, show verified banking details in the portal and require fresh authentication plus an audit trail for changes.* | `bank_accounts` carried `verified_at`/`verified_by` with nothing to say what "verified" meant, no change history, no screen, and no fresh-authentication mechanism existed anywhere. | **Resolved.** Migrations 0037–0038: a database-resolved freshness check, `verification_method` recorded and displayed in words, and an append-only `bank_account_changes`. |
| C11 | §11 *Expenses contain payee, property, category, amount, dates, invoice, approval and payment status… A receipt must not be counted twice because it is attached to both a maintenance ticket and an expense.* | No expenses domain module. `approved` and `paid` were separate statuses with no account to hold the difference, so an approved-but-unpaid cost had nowhere correct to post. Nothing stopped the same invoice being expensed twice. | **Resolved.** Migration 0040 adds accounts payable and a unique index on the invoice document; `packages/domain/src/expenses.ts` carries the commands. **Still open:** §11's split of one cost across several properties — the schema holds a single `property_id`. |
| C10 | §10 *Deposit records include holder, evidence, deductions and refunds… Require documentary evidence, approval and a refund reference.* §4 *A preparer cannot approve their own restricted refunds.* | The schema carried every control and there was **no deposits domain module at all** — no command to record a deposit, credit interest, deduct, refund or close. An earlier version of this document called the module "tested"; what was tested was the table, through direct SQL inserts. | **Resolved.** `packages/domain/src/deposits.ts` with commands for each, and screens for all of them. |
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
| M12 | §15 *Billing needs draft preview, validation report, approval, post and downloadable batch summary.* | **Exercised.** The batch summary is a CSV carrying who prepared the run, who posted it, the preview version, and the caveat that posted charges are immutable. Only a posted run has one: a preview is not a batch. |
| M11 | §9 *A suggested match is not automatically final.* | **Exercised.** Suggesting and applying are separate actions; the suggestion fills the form and the operator confirms or changes it. The stored policy records `manual` whenever a person confirmed the amounts, because the applied policy affects arrears ageing. |
| M10 | §19 *Require MFA for Spike administrators and finance approvers.* | **Exercised**, and a person can now enrol one themselves: the only path used to be `pnpm db:mfa enrol` against the database, so an invited finance approver could sign in, correctly see almost nothing, and have no way out. Enrolment is confirmed with a code before anything is switched on, recovery codes are issued at that moment and shown once, and a recovery code signs somebody in at full assurance so they can enrol a replacement. There is no administrator reset and no Spike reset — anybody who could clear a colleague's factor could take over their account. Also stronger: §4's *"exceptional actions require fresh authentication and an audit reason"* is enforced in the database for banking changes. Re-verification is implemented for the local auth provider only; on Supabase it refuses honestly rather than pretending. |

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
| Portfolio | Exercised | Properties, units, standalone houses; create, detail and **edit** screens. A property or unit can be corrected, a unit added to a property that already exists (`createUnit` had no screen at all, so a block could never gain a flat), and a unit or property taken out of use. Retiring refuses while any lease on the unit is live — including a draft — and says which lease is in the way; archiving a property refuses while any unit is active. Reinstating a property does not revive its units. Browser-verified. |
| Residents | Exercised | Profiles, lease parties, invitations, detail screen, editing and sealed identity capture, all driven through the interface. Archiving rather than deletion. |
| Leasing | Exercised | Draft, activate, renew, terminate, notices with honest delivery reporting, agreement generation and preview. An agreement missing essential terms is a draft that cannot be sent. |
| Bank statements | Exercised | A CSV the operator exported themselves is previewed, then imported. `bank_imports` and `bank_transactions` had existed since the schema was written, with two unique indexes against double-importing an overlapping statement, and **nothing could write a row to either**. An imported line creates no receipt, posts no journal and moves no balance. Two identical payments on one day both survive; the same line in two overlapping statements is imported once; the bank's own identifier wins over column matching when the file has one. A suggested payer states its reason in words and is never applied automatically, even when exactly one lease matches. **There is no bank feed and no provider** — nothing here contacts a bank. |
| Rent and receivables | Exercised | Recording money received, holding it in suspense, identifying the payer, suggested matching, operator-overridden partial allocation, unapplied credit and controlled reversal — all driven through the interface. Reviewing a resident's payment claim records a decision and moves no balance. |
| Billing | Exercised | Period preview, preparing a run, a validation report that explains each exception, confirmation before posting, and a downloadable batch summary. Preparing needs `billing.preview`; posting needs `billing.post`. |
| Deposits | Exercised | Receipts, interest from evidence, deductions, refunds, transfers and closure — all through the interface. A payout is now **requested by one person and decided by another**: a pending request holds nothing, the requester is refused the approval of their own, and the requester's name comes from the stored request rather than the approver's form. Browser-verified with two real accounts. |
| Utilities | Tested | Fixed and manual line items via charges. No dedicated screen. |
| Expenses | Exercised | Suppliers, drafts, approval, payment and voiding through the interface. Approving and paying post to different accounts, so net operating income and cash surplus are different figures. **Missing:** splitting one cost across properties (§11). |
| Maintenance | Exercised | Report, triage, assign, comment, resolve — through the interface, including the resident portal. **Spending now has an interface at all**: record a quotation, approve it into a work order with a ceiling, decline it with a reason, and record the supplier's invoice against completed work as a draft expense. Approving spending is a permission separate from managing a request. |
| Inspections | **Exercised** | Checklist published, inspection performed against a version, findings recorded, finalised, corrected by superseding. Fair wear and tear kept distinct from damage. Browser-verified. Photographs are not yet attachable to an item. |
| Documents | Exercised | Private storage, quarantine, type and size limits, authorised download, in-browser preview of generated PDFs only. **Malware scanning is not configured and is not claimed.** |
| Resident portal access | Exercised | `prepareInvitation`, `issueInvitation`, `acceptInvitation` and `revokePortalAccess` have existed since §8 and **not one of them had a screen** — so the portal could not be reached by any resident a customer actually had. A panel on the lease shows every party, whether they have access and whether they would see the money; the resident's name is restated at the moment of sending and checked server-side, which is the mis-link §8 calls a security incident risk. The link is shown once, no email is claimed, a resident with no account sets a password and lands on their own statement, and revoking touches the portal and not the tenancy. Browser-verified. |
| Communications | Exercised | In-app inbox and email behind an adapter that never reports a message delivered when it was not sent. **No provider configured (M5).** |
| Analytics | Exercised | Collection, arrears ageing, occupancy, expenses, rent roll, deposits, lease expiry, journal lines; every headline reconciles to its rows, asserted in tests. |
| Audit trail | Exercised | Every command has always written an entry in the same transaction as the change it describes, and **nothing could read one back** — the trail existed for a dispute nobody could open. A viewer under Settings reads it with filters built from the data itself, shows what each entry changed rather than two JSON blobs, and one record's own history is reachable from the record. `audit.read` is a permission of its own, held by the organisation administrator only. A property-scoped member is **refused rather than shown a filtered trail**: an entry records the resource it changed, not the property that resource belongs to, so there is no honest filter and a partial trail would look complete. Nothing can unredact — a sensitive value was replaced before it was written. Browser-verified. |
| Approvals queue | Exercised | Every waiting item — billing run, deposit payout, maintenance quotation, draft expense — now opens where the decision is made and recorded, and says what the decision does. The decision itself is not duplicated in the queue. The old deposit section read a row the database forbids and could never show anything. |
| Staff | Exercised | Invite a colleague, change their roles and scope, suspend and restore access. There was **no command to add a member at all** — every test needing a second one inserted rows on a privileged connection, so the separation of duties the rest of the product insists on could not be set up by the customer. An invitation grants nothing until accepted, the token is shown once and stored only as a hash, nobody can change their own roles or scope, and the last active administrator cannot be stripped or suspended. Only roles marked assignable are offered: Spike's own role and the portal roles are not. **No email is sent and none is claimed** — the link is handed over. Browser-verified end to end, including a brand-new colleague with no account. |
| AI | Agrees | None, by design. §23: *the launch does not require AI.* |
| Spike administration | Exercised | Customers, plans, entitlements, support sessions, platform lease templates, and **provisioning a new customer** — which had no screen, so every organisation in existence was created by the seed or a test. A provisioned organisation starts with **nobody in it**: its founding administrator arrives by accepting an invitation, so there is never a Spike account inside customer data for anybody to forget to remove. Spike reads only account metadata; customer records still require an authorised, time-limited, audited support session. Browser-verified. |

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
4. ~~Monthly billing workflow through the interface~~ — **done**. Preview,
   exceptions, validation report, approval with confirmation, posting and the
   batch summary export. Closes C3.
5. ~~Deposits~~ — **done**. Receipt, interest from evidence, deduction, refund,
   transfer and closure, with two-person approval.
6. ~~Expenses~~ — **done**. Suppliers, drafts, approval, payment, voiding.
7. ~~Inspections~~ — **done**. Checklist versions, findings, finalising,
   correction by superseding.
8. ~~Approvals that act~~ — **done**. Maintenance spending (quotation,
   approval into a work order with a ceiling, decline with a reason, invoice
   against completed work) had no interface at all; deposit payouts had no
   request step, so the approver had to be the clerk. Every queue row now
   reaches a decision.
9. ~~Bank statement import~~ — **done**. Preview before commit, overlapping
   statements, suggested payers that stay suggestions, lines set aside with a
   reason.
10. ~~Portfolio and unit editing~~ — **done**. Corrections with a before-and-after
   audit entry, adding a unit, retiring and reinstating, archiving a property.
11. ~~Audit history viewer~~ — **done**. Filters from the data, per-record
   history, an honest refusal for a property-scoped reader.
12. ~~Staff invitations~~ — **done**. Invitation with a single-use token, roles
   applied at acceptance, scope, suspension, and the last-administrator guard.
13. ~~MFA enrolment and recovery~~ — **done**. Enrol, confirm with a code,
   recovery codes at enrolment, re-issue, remove, and sign in with a recovery
   code.
14. ~~Resident portal invitations~~ — **done**. Issue from the lease with the
   recipient confirmed, redeem at `/tenancy/<token>`, revoke.
15. ~~Customer provisioning~~ — **done**. Spike creates the organisation and
   invites its first administrator, and is a member of nothing it creates.
16. ~~Navigation grouped into Portfolio, Finance, Operations and
   Administration~~ — **done**, with each section offered only to the members
   whose roles can use it, and loading boundaries for the console and the
   portal. Still open from this item: filters, reporting dates and actionable
   exception queues.
17. ~~Reporting dates and report filters~~ — **done**. Every report states the
   period it covers in words, takes a new one, and narrows to chosen
   properties; the export answers the same question as the screen.
18. ~~List filters, search and paging~~ — **done** for leases, residents,
   documents and maintenance: filtered in the database, with the count of the
   whole set under the list. The expenses screen states its 500-row cap rather
   than stopping in silence; it is paged with the exception queues below,
   because its draft and unpaid sections are two of them.
19. ~~Actionable exception queues~~ — **done**. Every tile on the overview
   opens the records it counted, with the same filter applied; the expenses
   screen is paged and its two queues are links into themselves.
20. Pilot readiness: production-intended adapters exercised in isolated staging,
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
- **No legal review** of the lease, notices, deposit rules or money flow. This
  matters most for deposits: PropertyOS records who approved a deduction and on
  what evidence, and deliberately encodes no rule about which deductions,
  interest treatment or refund deadlines are lawful. §21 requires counsel to
  settle those before the feature is relied on.
- **No accountant has validated the chart of accounts or posting model.** §10
  requires it before the financial model is used commercially. Migration 0040
  added an accounts payable account on that same unreviewed basis.
- **No load testing.** §26's targets are untested.

Until these are closed, this product is at the stage the blueprint calls a
controlled pilot candidate — and not yet that, because the rent workflow in
§5 cannot be completed through the interface.
