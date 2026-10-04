# ADR 0010 — Adversarial review findings

**Status:** accepted · **Date:** 2026-10-04

## Why

Everything in this codebase was written in one sustained effort and tested as it
was written. Tests written alongside an implementation tend to confirm what the
author intended, not find what they got wrong. This was a deliberate second
pass: go back over the financial and isolation paths looking for holes, write the
test that would expose each one, and see which fail.

54 adversarial tests were written. **Two failed.** Both were real defects in the
same function, and both are fixed.

## Finding 1 — credit notes could over-credit a charge (fixed)

`issueCreditNote` checked each note against the ORIGINAL document total, but
never against what had already been credited.

Two notes of R600 each against a R900 charge both passed the check, crediting
R1,200. The resident ended in credit on a charge they never overpaid, and the
receivable went negative. Every individual note looked valid.

**Severity: high.** Silent, produces wrong resident balances, and reachable by an
ordinary finance approver doing something reasonable — correcting a charge twice.

## Finding 2 — concurrent credit notes raced (fixed)

Even with a correct cumulative check, two notes issued at the same moment both
read a zero already-credited total before either committed, and both succeeded.
The original document was never locked.

**Severity: high**, same consequence, harder to notice because it needs
concurrency to reproduce.

## The fix

Both are fixed the way the rest of the system handles this class of problem:

1. **Application**: `SELECT ... FOR UPDATE` on the original document, then check
   `credited > (original total − already credited)`, with an error that says how
   much remains creditable.
2. **Database** (migration 0018): a `BEFORE INSERT` trigger on `charge_documents`
   that locks the original and rejects the insert if the cumulative credit would
   exceed it. It also verifies the note shares the original's organisation, lease
   and currency.

The trigger is the real guard. The application check exists to produce a readable
error, exactly as with the over-allocation guard on receipts. Had the trigger
existed first, neither defect could have shipped — which is the argument for
putting financial invariants in the database rather than in a service layer.

## What held up

The other 52 adversarial tests passed on first run, including:

* allocation reversal frees the receipt and restores the debt correctly;
* a receipt reversal with a partial allocation leaves the book balanced and does
  not strand unapplied credit;
* a receipt identified to one lease cannot be allocated to another;
* suspense is released from the SUSPENSE account on allocation, not from
  unapplied receipts — so suspense does not stay permanently overstated;
* a lease cannot be drafted against another organisation's unit, nor a foreign
  resident added as a party;
* a revoked or suspended membership loses access on the very next request;
* an empty claims string resolves to no user, not to everyone;
* a job payload cannot widen the worker's organisation scope;
* republishing an outbox event produces one job, not two;
* statements agree with `lease_balances`, are reproducible, and their running
  balance is internally consistent;
* a month split between two tenants prorates to exactly one month's rent.

## Schema invariants, now permanent

Nine schema-level tests were added so a future migration cannot quietly break a
guarantee the rest of the system depends on:

* every table has Row Level Security enabled;
* every table with RLS has at least one policy;
* **every view is `security_invoker`** — without it a view runs as its owner and
  silently bypasses RLS, which is the single easiest way to reopen tenant
  isolation;
* every customer table carries `organisation_id`;
* the application role is neither superuser nor `BYPASSRLS`;
* `journals` and `journal_lines` are not updatable or deletable;
* money is stored as `bigint` minor units.

One of these was initially written too broadly: it flagged the balance VIEWS,
whose `sum(bigint)` is `numeric`. Rather than assume that was safe, the behaviour
was checked — `numeric` is exact arbitrary precision and the driver returns it as
an integer string that `BigInt()` round-trips losslessly. The test was narrowed to
stored columns, and a separate test now pins the view behaviour so a future
driver upgrade that started returning JS numbers would fail the build.

## What this review did not cover

* The web layer. These tests exercise the domain and the database.
* Anything requiring a live Supabase project, SMTP provider or clamd.
* Performance and concurrency beyond the two-transaction races tested here.
* An independent security review, which remains a pilot blocker.
