# Runbook — onboarding a customer portfolio

**Who:** the operator, with their accountant for step 6.

Import in this order. Each step references the previous one by the codes the
operator already uses, not by identifiers they have never seen.

| # | Import | Notes |
| --- | --- | --- |
| 1 | Properties | A unique code per property. This is the key everything else references. |
| 2 | Units | A standalone house still needs one unit — use `MAIN`. |
| 3 | Residents | Your own reference per person. Email is optional; the portal invitation is separate. |
| 4 | Leases | Creates the lease ACTIVE, with its rent schedule and occupancy. |
| 5 | Extra recurring charges | Only for charges beyond rent. Rent schedules are created by step 4. |
| 6 | Opening balances | Requires a cut-off date, a source reference and an approver. |
| 7 | Deposits held | Separate from arrears, with the holder recorded. |

## How each import works

**Preview saves nothing.** Upload a file and every row is validated against the
live database. Problems are reported **by row and by column**, with row numbers
matching the operator's own file.

**Commit is all or nothing.** One batch commits in one transaction. If anything
fails, nothing is saved. An operator never has to work out which rows went in.

The downloaded template carries its column guidance as leading `#` lines. The
import strips them, so forgetting to delete them is not an error.

## Step 6 — opening balances, the step that matters

This is where a portfolio becomes trustworthy or doesn't. Wrong opening balances
mean untrusted statements, which the blueprint ranks as the second-highest risk
in the project.

**Import one row per historical unpaid charge, with its original due date.**
Arrears ageing is driven by that date, so supplying it is what makes the ageing
real. The document is issued at the cut-off, but the lines keep the dates the
operator gave.

**If only a single total per resident is available**, supply one row with no due
date. The batch is then marked `limited_ageing_detail`, and the system says the
ageing detail is limited rather than inventing an age for the money.

**These are not rent.** Imported arrears post as `opening_balance` documents, and
the balancing entry is **opening equity, not rental income** — the money was
earned before PropertyOS held the records, so recognising it as income now would
overstate the period. Never re-enter historical arrears as a new month's rent.

### The three controls

The import will not commit without all three:

1. **Cut-off date** — the date the balances are correct as at. Anything after it
   is billed normally, not imported.
2. **Source reference** — where the figures came from, for example "Accountant
   ledger export, signed 31 December 2025". Recorded against every balance.
3. **Approval** — the signed-in user explicitly confirms they have checked the
   figures. Their name is recorded as approver, in the audit trail.

**Do this with the accountant present.** The approval is a statement that
someone checked these numbers, and it is the record that will be relied on when
a resident disputes a balance.

## Step 7 — deposits

Imported separately, with the holder recorded explicitly (landlord, agency trust
or third-party custodian). A deposit is a **liability to the resident**: it is
never rental income, and it does not reduce arrears.

**No interest is calculated.** Record credited interest only from actual bank
evidence, after import. An assumed rate must never be presented as earned
interest.

## After importing

1. Run a **dry billing cycle in staging** against the imported data and compare
   statements to the operator's existing records, line by line, before any live
   data is used.
2. Check the **trial balance** nets to zero (Reports → Journal lines).
3. Compare **arrears ageing** against the operator's own ageing report. A
   difference here almost always means missing original due dates in step 6.
4. Only then invite residents, and only after two cycles reconcile.

## If an import goes wrong

There is nothing to undo at the row level, because nothing partial was ever
written. If a committed batch was wrong:

* Properties, units, residents — correct them in the application.
* Opening balances — issue a **linked credit note** against the opening balance
  document. Posted financial records are immutable; the original stays visible
  with the correction beside it.
* Deposits — record a corrective deposit event with evidence and approval.

The same file cannot be committed twice: a repeated upload is rejected on its
content hash.
