# 0039 — One invoice for the month

**Status:** accepted · 2026-10-29
**Amends:** 0038, which left rent on its own invoice

## The problem

0038 grouped a month's captured utilities into one invoice and left rent on
another, so a tenant still received two documents for one month. The reason
given was not taste — it was this index:

```sql
unique (schedule_id, period_start, document_type) where schedule_id is not null
```

That index is the whole protection against billing somebody twice when a run
crashes halfway and is retried. It is keyed on the **schedule**, which forces
one document per schedule. Rent and water on one document means it can no
longer protect anything — so it had to be replaced before the merge, not after,
and replacing a double-billing guarantee is not something to do in passing.

## What we decided

### Provenance moves to the line

`charge_lines.schedule_id` records which schedule produced a line, backfilled
from the documents that already named one. The document is now a composite and
cannot name one schedule honestly; the line can, and **the line is what was
billed**.

Everything that asked the old question of the document now asks it of the line:
whether a schedule has already been billed for a period (the preview's
`alreadyBilled`), how many periods a charge has raised, and whether the month a
schedule change starts in has already gone out.

### The crash guard moves to the run

```sql
unique (lease_id, period_start, billing_run_id)
  where billing_run_id is not null and status <> 'draft'
```

One posted document per lease, per period, **per run**. A run that dies after
writing a document and is retried finds the row and stops — the same crash
safety as before, keyed on what is now true.

Per *run* rather than per period on purpose. A later run for the same period
can still raise what the first one did not, which is exactly what somebody who
forgot the water readings needs. What stops that second run re-billing the rent
is the per-schedule check on the lines, not this index.

### The merge itself

One document per lease, carrying rent from its schedules and whatever was
captured for the month. What the document *is* has to be true of the whole of
it: rent anywhere in it makes it a rent invoice — that is what the tenant will
call it — a month of nothing but utilities is a utility invoice, and anything
else is a debit raised on the account. The due date is the earliest of its
lines, so nothing inside the document falls due before the document does.

### The migration refuses rather than guesses

Creating that unique index is itself the test of whether existing data permits
the merge, but a bare index violation names a row and not a problem. So the
migration counts the collisions first and stops with a message naming the
number, the query that lists them, and the decision to make for each: a double
billing is a credit note, a deliberate pair is left alone and the newer run
re-keyed. A customer whose history predates this rule gets a sentence they can
act on rather than a constraint error.

## What this cost to get right

**Three readers, not one.** The preview's already-billed check was the obvious
one. Two more were reading `charge_documents.schedule_id` — the count of
periods a schedule has billed, and the check that warns before changing a
charge whose month has already gone out — and the second was only found because
a test asserted a stopped schedule still showed what it had billed. A column
that moves takes every reader with it, and the way to find them is to run the
suite rather than to grep.

## What this does not do

**It does not merge anything already billed.** Documents posted before this are
what they are; the merge applies to runs from here on.

**It does not stop a one-off charge having its own document.** A late fee
raised from a lease mid-month is not part of a run, carries no
`billing_run_id`, and is unaffected — which is right, because it is not part of
the month's billing and should not reopen a document that has gone out.

**And it does not change what a tenant sees of an old month.** Two documents
for March stay two documents for March.
