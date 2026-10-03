# Runbook — reports and exports

## Scope

Every report runs under the requesting user's own Row Level Security context.
Two people with different property assignments correctly get **different totals**
from the same report. This is intended: a report describes what its reader is
entitled to see, not the whole organisation.

If a figure looks too low, check the reader's property scope before assuming the
data is wrong.

## Reconciling a figure

Every headline on the dashboard links to the records behind it with the same
filters. Those two must agree, and
`tests/integration/reports.test.ts` asserts it on every build:

| Dashboard tile | Reconciles against |
| --- | --- |
| Rent billed | Collection report, and raw posted rent charge lines |
| Outstanding receivable | Arrears ageing, and `charge_line_balances` |
| Arrears | Arrears ageing, due-date filtered |
| Occupancy | Occupancy report |
| Rent roll receivable | Arrears ageing total |
| Journal lines | `trial_balance`, which must net to zero |

If a figure ever disagrees with the records it opens, that is a defect, not a
rounding artefact. Capture the correlation id and stop before billing.

## For your accountant

Give them **Journal lines** for the period. It is the complete double-entry
detail, states whether the extract balances, and carries its definitions in the
file. Supporting exports: arrears ageing, collection, expense report (operating
and capital reported separately), deposit register, rent roll.

## What the exports promise

Every CSV carries, above the data:

* the report name and generation timestamp;
* the exact filters used;
* the report's qualifications — the definitions, in plain words.

This is deliberate. A spreadsheet divorced from its definition is how
"collected" quietly becomes "received", and how a capital improvement quietly
enters net operating income.

A financial export is **private data in its own right**. Exports are served
under the caller's scope and are never public URLs.

## Definitions that catch people out

* **Collected** means receipts *allocated to charges issued in that period*.
  A receipt held as unapplied credit is not collected. A payment against prior
  arrears is not in this period's collection figure — it is in arrears ageing.
* **Arrears buckets** are driven by the charge **due date**, not the invoice
  date. A partial payment leaves the remainder in its original bucket.
  Allocation order therefore changes ageing, which is why the applied policy is
  recorded on every allocation row.
* **Occupancy** excludes days a unit was recorded out of service from the
  denominator, so a renovation does not read as a letting failure.
* **Net operating income** excludes capital, financing and owner drawings. The
  expense report splits them; do not sum the "all costs" column into NOI.
* **Deposits** are a liability, never income, and never reduce the rent
  receivable until an approved, lawful transfer is posted.
* **Yield** is shown only where the denominator is known and labelled. A
  property with no recorded purchase price shows no yield rather than a guess.
