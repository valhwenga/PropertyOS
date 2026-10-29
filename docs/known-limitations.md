# Known limitations and unresolved configuration

This document is deliberately blunt. The interface rendering is not evidence
that the product is finished.

**Last reconciled against the code: 21 October 2026.** Three rows in it had
gone stale in the safe direction — MFA enrolment, customer provisioning and the
bank import UI were all listed as not built and all three exist — which is its
own kind of untrue: a reader cannot tell which half of a document that
understates is also wrong the other way. Where this file and
`docs/MVP-RECONCILIATION.md` disagree, the reconciliation document is the one
kept current per feature; this one is the register of what is **missing**, and
a row here that says "not built" has to still be true.

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
| MFA enrolment UI | **Built** (was wrongly listed here as not built) | `/account/security`: enrol with a confirmation code, recovery codes issued at enrolment and shown once, re-issue, remove, and sign-in with a recovery code. Migration 0045 added the recovery codes, hashed and single-use. There is no administrator reset and no Spike reset, deliberately: anybody who could clear a colleague's factor could take over their account. |
| Account recovery | **Built, local auth provider only** | There was none, and no password reset either: a landlord who forgot a password or lost the phone with their authenticator was locked out of their own records for good, and the only remedy was somebody running `pnpm db:mfa` against the database. Now they ask at `/recover`, and somebody else decides. Their own administrator (`membership.manage`) decides it where there is one, effective at once; Spike decides it **only** where the person has no such colleague — the policies make the request unreadable to an operator otherwise, and that rule is restated in the domain and in the query because some platform pages read with filtering lifted. Spike’s approval waits (24h by default) and the account holder can cancel it without signing in. Approval issues a single-use link, shown once to whoever approved it to hand over, and it does only what was lost — a forgotten password leaves the second factor standing. The form answers identically for an address with no account. See `docs/decisions/0029-a-way-back-in.md`. **Limit: it resets credentials in this database, which Supabase Auth does not read, so with `AUTH_PROVIDER=supabase` the action refuses rather than reporting a reset that did not happen.** |
| Platform alerting | **Built, delivery needs SMTP** | Every signal was a screen somebody had to remember to open. Twelve conditions are now defined once in `app.platform_alert_conditions()` — dead jobs, a worker that stopped, a stuck queue, somebody locked out waiting on Spike, an outbox or message backlog, an unanswered account request, a retention date passed, an overdue invoice, a trial that has run out, a debt whose chasing is waiting on a person, and addresses that started bouncing this week — read by the console, the worker and the tests from the same function. A critical condition raises a banner on **every** console page, not just the home page nobody opened. The worker asks every five minutes and raises one notice per recipient, repeating daily while a condition stays true. An operator holding `platform.operations.manage` can silence one with a reason and an expiry (max 30 days); silenced is greyed in the list with who and why, never hidden. See `docs/decisions/0030-something-tells-somebody.md`. **Limit: nothing is delivered until `EMAIL_PROVIDER` and the SMTP settings are set — until then every notice is recorded `undeliverable` with the reason, and the console shows "0 of 2 delivered" rather than claiming otherwise.** |
| Session revocation | Time-based only | No server-side session store, so a stolen cookie is valid until it expires (8 hours). Membership and portal-link revocation take effect on the next request, which limits the blast radius. |
| Supabase Storage | **Implemented, not run against a real bucket** | Upload, read, signed-URL and delete against a private bucket, using the service role key server-side only. The local filesystem adapter is fully exercised end to end (15 HTTP checks). The Supabase path has never run against a live project. |
| Bank CSV import UI | **Built** (was wrongly listed here as not built) | Preview before commit, overlapping statements, suggested payers that stay suggestions, and lines set aside with a reason. Duplicate protection is enforced at database level and covered by tests. |
| Content Security Policy | Permits `'unsafe-inline'` for scripts | Required by Next's inline hydration bootstrap. Tightening to a nonce-based policy is outstanding. |
| Spike's own payment collection | **Built, sandbox provider only** | `recordSubscriptionPayment` is still there and still honest — an operator reading Spike's bank statement — but a customer can now pay an issued invoice from their subscription settings. An attempt is a record, not a result: `confirmed` requires a `webhook_event_id` whose signature was verified, enforced by a check constraint and a trigger, and there is no UPDATE policy on the attempts table for the application role at all, so nothing the browser touches can settle an invoice. The return page reports the recorded state and never congratulates somebody for arriving. Short payments record what arrived and leave the invoice issued. **Limit: the only working adapter is the sandbox**, which signs and verifies its own notifications so the whole path is exercised locally; `SUBSCRIPTION_PAYMENT_PROVIDER=payfast` resolves to an adapter that refuses, and the worker's preflight refuses to start. See `docs/decisions/0031-spike-can-be-paid.md`. |
| Debit order mandates | **Built, sandbox provider only** | The authority, not the collection: a customer authorises Spike to collect up to a capped amount on a chosen day from a named account, and their own bank authenticates it. The terms are immutable — a trigger refuses any change to the amount, day, start date or account, so changing them means cancelling and authenticating another, with both records kept. Only a verified provider event can authenticate one (check constraint plus trigger, no UPDATE policy for the application role), one live mandate per customer (partial unique index), and the payer can withdraw it here or at their own bank — a withdrawal arriving unprompted is recorded as theirs. The account number is sealed like every other account number here, with four digits in the clear. See `docs/decisions/0032-a-mandate-to-collect.md`. **Limit: nothing is collected against it yet**, and the sandbox stands in for the payer's bank — DebiCheck's real authentication happens in the payer's banking app, which no stand-in can imitate. |
| Debit order collections | **Built, sandbox provider only** | Prepare, submit and the bank's answer are three separate acts: preparing is arithmetic that can be redone, submitting is a person's decision rather than a timer, and only a verified provider event can mark a collection successful. A collection may never exceed the mandate's authorised amount — a trigger reads the mandate — and it is refused again at submission, because a payer can withdraw authority between the 29th and the 1st. The run collects what is outstanding, skips what it cannot collect and names who, one live instruction per invoice is a unique index, and a dispute reverses the settlement because the money never arrived. The customer sees what is about to leave their account. See `docs/decisions/0033-collecting-on-the-mandate.md`. **Limits: nothing is submitted automatically, no provider can actually submit (sandbox only), and there is no retry or representment of an unpaid debit.** |
| Rent payment provider | **Deliberately disabled** | See `docs/decisions/0004-money-flow.md`. Not to be enabled before merchant ownership and settlement are confirmed in writing. |
| Contractor portal | Schema and assignment model only | Phase 2 per the blueprint. Contractor-visible comments and attachments are already separated in the data model and enforced by RLS, ready for that portal. |
| Document upload UI | **Built for operators** | Upload with validation, scanning and quarantine; share control; authorised download. The resident photo attachment on a maintenance request is still not built. |
| Lease lifecycle | **Built** | Draft, **activate**, extend, terminate, **record the end of the term** (including a holdover) and **renew into a draft successor**. Activation had existed in the domain since the first milestone with no screen at all, so until 21 October 2026 a lease drafted in the product never billed anything; renewal had no caller anywhere in the repository. Nothing expires a lease automatically, by decision: whether the tenant left or stayed on is a fact only a person knows. |
| Receipt correction | **Built** | A confirmed receipt can be reversed with a reason — a bounced cheque, a double capture, a slip keyed against the wrong landlord — which reverses every allocation still live on it first. Nothing is deleted: the original entries and their reversal both stay in the ledger. |
| Inspection capture UI | **Built**, including photographs (this row has now been wrong in both directions) | Templates are published with a version, an inspection is created against a unit and a lease, findings are recorded item by item with a condition and a damage type, the report is finalised, and a correction creates a new version with a reason — all at `/app/<org>/inspections`. The resident reads a finalised report and agrees or disputes it at `/portal/<lease>/inspections`. Photographs attach **per checklist item** and are visible to the resident, since they are the evidence behind a deduction from that resident's deposit. This row previously said the capture screen was not built, which was wrong — it has existed since the operations milestone — and the correction before this one repeated the claim while fixing a different half of the same sentence. What was genuinely missing was the resident's response (built 21 October 2026) and the photographs (built the same day). |
| Owner portal | Scope functions and policies exist | Phase 2 per the blueprint. `app.owns_property` and the owner read policies are in place. |
| Spike operator permissions | **Built** | Platform authority was one boolean: every operator could change any customer's plan, suspend any account and edit the lease templates every customer inherits, and the only way to make somebody an operator was an `UPDATE` in psql. Operators now hold named roles (administrator, support, billing, read-only) resolved on every call, the platform write policies are keyed to the specific permission rather than to operator status, and a colleague is admitted through `/join-operator/<token>` — the only path that may set `is_platform_operator`. The console cannot be left without an administrator and nobody can remove their own access. See `docs/decisions/0021-spikes-own-permissions.md`. **Still outstanding:** an operator cannot yet reach the landlord console under a session — see the support row below. |
| The job queue | **Built** | `failJob` moved exhausted work to `dead` and the home page counted it as "needs an operator to inspect" with nothing to inspect it with. `/platform/jobs` now shows what failed, the error that killed it, the attempt history and the payload, grouped by handler so one broken handler reads as one cause. An operator can run a job again (full retry budget, audited against the customer) or abandon it — which keeps the row as evidence and makes it inert, since the worker claims only `queued`. The page says when the worker looks stopped rather than busy. See `docs/decisions/0027-the-queue-is-operable.md`. **Not built:** nothing restarts the worker, nothing alerts, and the outbox backlog and undelivered notifications are still counted rather than actionable — the first is the worker's own job, the second waits on an email provider. |
| Plans and pricing | **Built** | `plans` carried a price nothing ever wrote to, so launching a tier or raising R899 meant a deploy. `/platform/plans` now creates plans, schedules prices and sets staff and storage caps. A price has a DATE: the billing run uses the price in force for the period it bills, so invoicing March in April after a rise on 1 April charges March at March's price — which editable price columns would have got wrong. A period already invoiced cannot be repriced, a plan always has a price, and retiring a plan stops it being offered without moving anybody off it. See `docs/decisions/0026-a-price-has-a-date.md`. **Not built:** a per-customer price or discount (a negotiated rate still needs a plan that costs that), and proration of any kind — a plan change takes effect next period. |
| Platform settings and feature flags | **Built** | What the product decides was spread between environment variables, SQL constants and numbers in `if` statements — a support session lasted 1–24 hours because 24 was written in the code, and a customer could not have their resident portal switched off. `/platform/settings` now carries typed settings with shipped defaults; a feature flag is a boolean setting. Five ship, each read by code: the resident portal, resident maintenance requests, public application links, and the two support hour limits. The first three can differ per customer and are named on the customer's own settings screen when switched off, with the reason and who did it. See `docs/decisions/0025-settings-and-flags.md`. **Deliberately not built:** per-customer limits (that is what plan entitlements are), scheduling, gradual rollout, and any targeting finer than one customer. |
| Roles and permissions, visible | **Built** | `roles`, `permissions` and `role_permissions` were reference data with no screen, so support could not answer "why can't our manager approve that?" without reading SQL, and a customer wanting one extra thing had to be told no. `/platform/permissions` now shows what every role carries, which roles carry each permission, which roles cannot be assigned to staff, and which permissions a support session could ever exercise. One customer's role can be given one extra permission on their own page — grants only, always requiring a second factor, visible to the customer on their staff screen with the reason and the operator's name. See `docs/decisions/0024-what-a-role-can-do.md`. **Deliberately not built:** changing what a role does for every customer (that stays a migration), taking a permission away, and per-member exceptions. |
| Reviewing Spike's conduct | **Built** | `platform.audit.read` had no screen behind it, and once sessions could change records the only person who could say what Spike had done inside a customer's data was the operator who did it. `/platform/audit` now shows every action on an account and every action under a session — who, to whom, when, why, what the session was allowed to change and who at the customer approved it — filterable by operator, customer, action and date, with a CSV that carries its own filters. A customer's ordinary work never appears. See `docs/decisions/0023-reviewing-spikes-own-conduct.md`. **Not built:** nothing watches this and nothing is alerted; it is a review tool somebody has to open. |
| Support that can act | **Built** | A support session was read-only, so a landlord asking Spike to fix a mis-filed ticket got instructions rather than help. A customer can now allow **Maintenance**, **Property and lease records** or **Documents** when they open a window or approve a request; unticked still means look and change nothing. No scope reaches money, memberships, support access, period locks, the bulk export or identity documents — those tables carry no support policy at all. Every action is attributed to the session by a trigger. See `docs/decisions/0022-support-that-can-act.md`. An operator with a live approved session can now open the landlord console itself: every screen carries a banner naming whose records they are, what may be changed and when it ends, the menu offers only what the session carries, and the customer ending the session shuts the door on the next click. |
| Customer offboarding | **Built** | Closing an account used to set a column: the console stopped opening, the records stayed indefinitely, and the only link to the customer's own archive was on a console page closing had just taken away from them. A closure now records who closed it, why, and the date the records may be destroyed (sixty months by default, a platform setting). The page a closed customer is sent to carries that date and their download. After the date an **administrator** — not support — can destroy the records: every row carrying that organisation_id, found from the catalogue rather than a list, keeping only Spike’s own invoices, its audit of its own conduct and the sessions the customer authorised. People left with nothing to belong to are anonymised rather than deleted, because `support_sessions.authorised_by` is the record of their consent. Uploaded files are removed from storage too — their keys are read before the purge, because deleting `documents` deletes the only record of where the bytes are, and any the bucket will not give up are written down and shown in red rather than left unreachable. Nothing happens on a timer, and a destroyed account cannot be reopened. See `docs/decisions/0028-leaving-is-a-process.md`. |
| Customer provisioning UI | **Partly built** (the operator form was wrongly listed here as missing) | The operator form exists at `/platform/new`: Spike provisions a customer and invites its first administrator, and a provisioned organisation starts with **nobody in it**. A landlord can now **ask** for an account at `/request-access`, and Spike approves the request at `/platform/signups`, which provisions through that same operator path. It is a request and not a sign-up on purpose: with no email provider the address cannot be verified and with no payment provider the account costs nothing to open, so **no organisation is created without a person deciding** — see `docs/decisions/0020-asking-for-an-account.md`. Nobody is told what was decided, for the same reason. |
| CSV onboarding import | **Built** | Seven import kinds in the blueprint's order, with downloadable templates, row-and-field validation that writes nothing, and all-or-nothing commits. Opening balances require a cut-off date, source reference and approval. See `docs/runbooks/onboarding.md`. Document import (step 8 in the blueprint) is still not built, and there is no bulk portal-invitation step. |
| PDF statement export | **Built** | Operator and resident PDF statements, generated by a dependency-free writer and verified by an independent parser (`pdftotext`) in the test suite. **Limit: WinAnsi text only.** English and Afrikaans including diacritics render correctly; Greek, Cyrillic and CJK are replaced with `?` rather than producing a corrupt file. Supporting those needs an embedded TrueType font, which the writer deliberately does not do. |
| Utilities (meters, tariffs) | Phase 2 | MVP supports reviewed, manually entered utility charges only. |

## Resident portal gaps

Found during the portal design pass. Each is a thing the interface would need
from the backend before it could show something it currently cannot.

| Gap | State | Consequence |
| --- | --- | --- |
| Landlord logo | **Closed** (migration 0055, ADR 0012, ADR 0015) | A landlord uploads a PNG or JPEG, validated from its own bytes, and it appears in the console sidebar, on the portal, on statement PDFs, as the browser tab's icon and on their own `/sign-in/<slug>` page. A format the PDF writer cannot embed faithfully falls back to the landlord's name in text rather than failing to produce a statement. |
| Bank account type | **Not recorded** | `bank_accounts` holds bank, holder, last four, branch code and the sealed number. There is no cheque/savings/transmission field, so the portal does not claim one. |
| Ticket status when a contractor is booked | **The ticket does not move** | `approveQuoteAndIssueWorkOrder` creates the work order and leaves the ticket at its current status, so a resident sees "Received" while a glazier is booked for Monday. The portal shows the appointment and contractor from the work order rather than inferring a status the domain never recorded — mapping `submitted` to "Scheduled" because a work order exists would be the interface inventing a state. Fixing it properly means a status transition and an event row in the maintenance workflow, which belongs with that workflow rather than with a portal pass. Pinned by a test so the day it changes, the test says so. |
| Acknowledge or reopen a request | **No command exists** | There is no resident-facing command to accept a completion or reopen a ticket, so no button is shown for one. `awaiting_confirmation` is displayed as "Waiting on you" with the landlord as the way to respond. |
| Inline preview of uploaded files | **Deliberately impossible** | `authoriseDownload` permits inline rendering only for a PDF PropertyOS generated itself. Photographs and uploaded documents download rather than previewing, and the portal says so rather than appearing broken. |
| Emergency contact | **Now configurable, often unset** | Migration 0048 adds `organisation_profiles.emergency_contact` and the landlord settings form asks for it. Until a landlord fills it in, the portal says no number has been given and points at the lease agreement. No number is ever invented. |

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
* **The seed script is all-or-nothing and refuses to run twice.** It runs in one
  transaction, so a failure leaves nothing behind, and it refuses to seed on top
  of existing demo data rather than producing a half-populated database.
* **The test harness DROPS the database it is pointed at.** It now refuses any
  name that does not identify a test database, after exactly that mistake wiped
  the development seed data. Override with `ALLOW_DESTRUCTIVE_TEST_DB=true`.
* **The content security policy allows `eval` in development.** React's
  development build uses it to rebuild stack traces across environments, and
  without the allowance every page logged a violation and the dev overlay
  reported an issue on a page that was working. The allowance is conditional on
  `NODE_ENV`, so a deployed build keeps the strict policy, and
  `tests/unit/content-security-policy.test.ts` fails if anyone makes it
  unconditional. The policy still carries `'unsafe-inline'` for scripts in both
  builds; moving to nonces is the real fix and is not done.
* **An escalation is never applied automatically.** The product can see that
  an agreed increase has fallen due and proposes the arithmetic; a person
  applies it. That is deliberate — an unattended job that raises rent is one
  misconfigured interval away from raising it twice — but it does mean an
  increase waits until somebody acts on it. The lease screen says so; there is
  no notification yet.
* **No VAT is calculated anywhere, and no document says "tax invoice".**
  `charge_lines` has no tax columns, so an invoice prints the VAT number where
  one is recorded and nothing else about tax. The words *tax invoice* have a
  meaning in the VAT Act — a document using them must show the tax charged —
  and most residential letting is an exempt supply in any case, so the
  documents say INVOICE. `docs/scopes/vat.md` scopes what it would take:
  schema, a dated rates table, a third journal leg, per-lease treatment, and
  the tests that are the real work.
* **A meter reading is evidence, not a calculation.** A utility line stores
  the quantity, the tariff and the meter pair beside the amount an operator
  entered; nothing multiplies them into a total. Stepped municipal tariffs
  mean the product of the two is frequently not the bill, so the invoice shows
  both and flags a difference rather than correcting either. There is no meter
  register, no reading history and no estimate: a reading belongs to the
  charge it was captured on.
* **The icon is a letter, not a logo.** No approved Spike mark exists, so
  `apps/web/src/app/icon.svg` is the wordmark's initial in the brand purple.
  It exists so pages stop requesting a favicon that is not there. Replace it
  when brand sign-off lands. It is only ever seen where no landlord's own logo
  applies: the product's own sign-in page, the organisation chooser, and the
  console of an organisation that has uploaded nothing.
* **A freshly seeded operator account can see almost nothing.** Elevated roles
  are MFA-gated inside `app.has_permission`, so without a verified second factor
  an organisation administrator holds none of their elevated permissions. The
  console renders and is nearly empty. This is the rule working, but it reads as
  a broken install, so `./scripts/preview.sh` enrols a factor for the demo
  accounts and `pnpm db:mfa` does it on demand. Neither is a sign-in bypass:
  codes still go through normal verification and replay protection.
* **A TOTP code cannot be used twice, including by a test re-run.** Two sign-ins
  as the same account inside one 30-second window will see the second refused.
  The preview smoke checks wait for the next window and read a new code rather
  than treating the refusal as a failure.
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
  exercise HAS now been run and verified, carried through to the application
  signing a resident in against the restored database (see
  `docs/runbooks/recovery.md`), but against a 672 KB development dataset on a
  local machine. That measures the procedure, not a production recovery time.
* **No external service has ever been contacted.** Email, authentication,
  malware scanning and object storage are all standing in for a provider that
  has never been configured. `docs/credentials.md` records what that leaves
  unverified variable by variable, and `pnpm preflight` reports the same for
  whichever environment it is run in — but no staging environment exists, and
  each external account needs its own authorisation before one can.
* **Server Actions buffer a 26 MB body before any of our code runs.** Every
  upload in the product — documents, proof of payment, maintenance photographs,
  import CSVs — arrives through a Server Action, and Next caps an action body at
  1 MB by default, so a 1.6 MB spreadsheet answered "A server error occurred"
  while the screen advertised 5 MB. The limit is now set past the largest file
  the product accepts, so the product's own checks and messages are the ones
  that answer. The cost is that anonymous actions (sign-in, a rental
  application, redeeming a tenancy invitation) will also buffer a body that
  large. Moving uploads to route handlers, which stream and can be limited
  individually, would remove that exposure and is not done.
* **A plan changed mid-period is billed as though it changed at the start.**
  There is no proration, no per-customer price and no discount: a customer who
  upgrades on the 20th pays the new plan for the whole month, and one who
  downgrades pays the old one. Chasing, trial expiry, a payment provider and a
  debit order all exist now (ADRs 0031–0034); proration is the one still
  missing from how Spike is paid, along with any way to contact a customer from
  the console.
* **Idempotency covers the commands that create records, not every command.**
  Recording a receipt or a deposit, drafting an expense, and a resident's proof
  of payment or maintenance request are each protected by a per-form key. The
  approvals, reversals and edits are not: they act on a record that already
  exists and are guarded by its own state instead — an approved payout cannot
  be approved twice. Extending the keys to those is worth doing and is not done.
* **One of a customer's administrators can take over another's login.** The
  recovery route an organisation decides for itself is exactly that: an
  `org_admin` can ask on a colleague's behalf, approve it and take the link.
  They gain no permission they did not already hold — `org_admin` is the top
  customer role — but they gain the ability to act as that person. The control
  is that it is audited with their stated verification and that the account
  holder is sent a notice, not that it is prevented. Recovering a *Spike*
  account from a customer organisation is refused outright.
* **A recovery request sits until somebody decides it.** Nothing notifies the
  administrator who could approve it, and nothing expires an open request. A
  request only Spike can decide now raises a platform alert; one a colleague
  could decide raises nothing, because Spike cannot see it. The notice to an
  account holder whose recovery Spike approved is queued and undelivered until
  a mail provider is configured — so the waiting period only protects somebody
  if an operator tells them about it by another route, and the approval box
  asks what they checked, at length, for that reason.
* **Nothing is actually delivered by email until somebody configures a
  provider, which is now a key and a DNS change rather than any code.** The
  notices are correct as of ADR 0035 and there are two real adapters as of ADR
  0036 — Resend over HTTPS, and SMTP for anything else — with a preflight that
  asks Resend which domains are verified and a `pnpm email:test` that sends one
  real message and prints the provider's own answer. With nothing configured
  every attempt still ends `development_sink` with the sink's reason on it, the
  console groups them by why, and nobody receives anything. What is outstanding
  is a Resend key, an `EMAIL_FROM` on a domain verified with them, and SPF,
  DKIM and DMARC records at the registrar — without those last three a rent
  reminder lands in a spam folder and this product records it as sent, which is
  worse than not sending it.
* **Resend's API shape is written from public knowledge, not verified against
  the reference.** This environment's network policy refuses `api.resend.com`
  and `resend.com`, so the adapter was built and tested against a local server
  answering in the documented shapes. It is defensive about it — the message id
  is read from either field it might arrive in, an unreadable success is a
  retryable failure rather than an assumption, and every error field is
  optional — but the first live send is still the first live send.
* **A soft bounce is recorded and not retried differently.** A full mailbox or
  a greylisting is noted on the notice and the message keeps whatever delivery
  attempts it had; nothing backs off and tries again in six hours, which would
  be better and needs a schedule the worker does not have. Hard bounces,
  blocked senders and complaints do stop the mail, per ADR 0037.
* **Bounce handling needs the webhook configured, which nothing can check for
  you.** Without `RESEND_WEBHOOK_SECRET` and a webhook in the provider's
  dashboard pointing at `/api/email/resend/events`, events arrive unverified or
  not at all — they are recorded and acted on by nothing, and mail keeps going
  to addresses that have already rejected it. `pnpm preflight` reports it as a
  gap.
* **There is still no reply-to on anything**, so a resident hitting reply writes
  to `no-reply@`, and no unsubscribe handling of any kind — defensible while
  every message is transactional, and not for a day longer than that.
* **A resident without portal access cannot be told anything.** An in-app
  notice is delivered by being written into their inbox, which only exists if
  they have accepted a portal invitation. Where nobody on the lease has one the
  dispatcher writes nothing and says why in the worker log, rather than filing
  a row no person can open. Reaching those residents needs SMS or a landlord
  with a phone, and the product has neither.
* **Notification wording is not editable by anybody.** The templates live in
  migrations: a customer cannot change what their residents are told, and
  cannot add a notice of their own. Nine of the eleven registered templates
  are in-app only.
* **Spike still cannot collect money without a real provider.** The whole path
  exists — mandate, run, submission, outcome, dispute reversal — and the only
  adapter that can submit anything is the sandbox. A live deployment needs a
  sponsoring bank or a provider with a debit-order facility and a registered
  user code. Nothing submits on a schedule either: a person presses the button,
  deliberately, until the arithmetic has been watched for a few months.
* **An unpaid debit is not re-presented.** It can be abandoned or left; nothing
  tries again on a later date, and the rules for that are the provider's and
  the bank's rather than ours to invent. There is still no stored card and no
  tokenised recurring charge, and refunds are reversed at the provider and
  recorded here by hand.

* **Nothing warns a customer before their trial ends.** The trial ends on its
  date and the first they hear of it is the invoice. The warning needs a
  template and a working mail provider, neither of which exists, so it is
  written down here rather than half-built.
* **A reminder is sent once per step, not until it is paid.** The ladder has
  three rungs — a reminder at 3 days overdue, a final notice at 10, a
  suspension proposal at 21 — and then it waits for a person. Dunning that
  nags weekly needs a scheduling model and a way for a customer to say "I
  know", and it has neither. The reminder and the notice are also *queued and
  undelivered* until `EMAIL_PROVIDER` and the SMTP settings are set, like every
  other customer-facing notification: until then the ladder is honest with
  Spike and silent to the customer, which is the worse half of chasing
  somebody.
* **Suspension for non-payment collects nothing.** It stops the console. It
  does not re-present a failed debit order, does not chase the debt further,
  and does not expire: an account stays suspended until a person reopens it.
  The debt survives the suspension and the invoice survives both.
* **DebiCheck's own fields are not modelled** — no tracking indicator, no debit
  value type, no amendment flow — and whether Payfast is the right provider for
  debit orders at all is open: in South Africa the debit-order providers are
  often different companies from the card gateways.
* **The Payfast adapter is not written.** Its signature rule, ITN field names
  and validation callback have to come from the official specification; this
  environment's network policy denies `developers.payfast.co.za` and
  `payfast.io`, and a signature written from memory fails silently in both
  directions. The seam, the state machine and the notification endpoint are
  provider-independent, so it is one adapter rather than a redesign.
* **Nothing in offboarding happens on its own.** No reminder when a retention
  date approaches, no list of accounts past theirs on the platform home page,
  and no notification to a closed customer — the page they are sent to tells
  them the next time they sign in, and that is all. A customer cannot ask for
  closure themselves either; they ask Spike, who closes it.
* **The customer export is built in memory.** The archive is assembled whole
  before it is sent, which bounds it to what the process can hold. That is
  comfortable for the portfolio sizes this product is for and would need to
  become a streamed export before it is not. It also carries no document bytes:
  the manifest names every attachment with its storage key and SHA-256 so the
  files can be matched to an object backup, but there is no object backup to
  match them to.
* **Two screens miss the one-second target at the blueprint's scale.** The
  overview and the collection report take two to three seconds against 5,000
  leases and five years of charges; both are the same collection-metrics query,
  whose parts are fast separately and slow combined. Eight other screens meet
  it, after the fixes measured in `docs/performance.md`. Nothing is known about
  concurrency: every figure there is one user at a time.
* **No dependency CVE scanning or SAST in CI**, and no independent penetration
  test. See `docs/security-review.md`.
