# Runbook — EFT reconciliation

Reconciliation has three distinct steps. Do not merge them.

## 1. Recognise the bank receipt

Import the bank CSV. A repeated upload of the exact same file is rejected by its
source hash. Individual transactions are deduplicated on the bank's own
identifier where one exists; where it does not, a conservative fingerprint is
used that **preserves two genuinely separate same-amount payments on one day**
rather than dropping a legitimate receipt.

Overlapping statement periods are expected and safe: true duplicates are flagged,
legitimate separate receipts are preserved.

## 2. Identify the lease

Suggested matches are **suggestions**. A suggested match is never automatically
final. Where the payer cannot be identified, confirm the receipt into
**suspense** — do not guess a lease. Suspense money is real money with an unknown
owner, and it is visible on the dashboard until resolved.

## 3. Allocate to charges

The default order is oldest due date first; the applied policy is recorded on
every allocation because the order changes arrears ageing. You may split a
receipt across several charges.

* A **partial payment** leaves the remainder of the charge in its original due
  date bucket.
* An **overpayment** stays as unapplied credit with a traceable history. It is
  never forced onto a charge.
* **Over-allocation is impossible.** Two operators allocating the same receipt
  simultaneously will serialise; one succeeds, the other is refused.

## Proof of payment uploaded by a resident

An uploaded screenshot is **evidence awaiting verification**. It carries no
accounting effect: no journal, no receipt, no allocation, no change to the
balance. Verify the funds against the bank record, then confirm a receipt. Only
that reduces what the resident owes.

## Reversing a receipt

Returned EFT or chargeback: Receipt → **Reverse**, with a reason. Live
allocations are reversed first, then the receipt journal, so the debt correctly
reappears. Nothing is erased.
