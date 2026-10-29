# 0038 — The month, before it is billed

**Status:** accepted · 2026-10-29

## The problem

A landlord recovers water, sewerage and refuse every month, and the product
made them do it one lease at a time: open the lease, open the charges panel,
type the readings, post. Forty tenancies was forty round trips.

And each posting produced its **own invoice**. A tenant with water and refuse
received three documents in a month — rent, water, refuse — none of which could
be corrected afterwards, because a posted charge document is immutable by
trigger and the only correction is a credit note.

The immutability is right and is not what this changes. What was wrong is
*where the typing happened*: after the ledger, where nothing can be fixed,
rather than before it, where everything can.

## What we decided

### A captured charge is a draft

`pending_charges` holds what somebody typed for a month: the reading, the
tariff, the arithmetic, the lease and the category. It is not in the ledger, it
is not a document, nobody has been billed, and deleting one is deleting a
draft. The billing run turns it into a real line — and from that moment the row
is history, pointing at the document it became.

### The arithmetic is checked where it cannot be argued with

Three ways a landlord has the figure: the municipal account says R1,119.30; the
meter moved 41 units at a tariff; or they have the consumption and the tariff
without the readings. Any is accepted. Two of them **disagreeing** is refused —
a typed amount that is not quantity × rate is somebody's arithmetic slipping,
and the invoice would carry lines that do not add up to their own total.

A meter that goes backwards is refused too: it is a typo or a replaced meter,
and neither is a bill. In the schema as well as the code, because the form is
not the only way in.

### Typing it twice is a correction, not a second charge

One line per lease, month and category, enforced by a partial unique index
rather than by the caller remembering — two people doing the month together is
the ordinary case, not the exception.

### The run groups them into one invoice per tenancy

Posting a run now posts the schedules as before and then, for each lease, turns
all of that month's captured lines into **one** document. A tenant with water,
sewerage and refuse goes from three invoices to one.

**Rent stays on its own invoice.** Double billing is prevented by a unique
index on `(schedule_id, period_start, document_type)` — per-schedule by
construction — and the one thing this product must never do is bill somebody
twice. Collapsing rent and utilities onto a single document needs a different
guarantee than the one in place, and inventing one while the money is real is
not worth the saving of one PDF.

### Nothing new is needed to send them

`invoice_deliveries` has had `ready → queued → sent` and a *Send all N ready
invoices* button since the invoice-sending work. The gap was never the sending;
it was that there was nothing sensible to send. The month now flows: capture →
preview → post → mark ready → send all.

### What billed it is recorded, and stays recorded

Once a run posts a captured line, the row cannot be edited or deleted — by
policy for the application role and by trigger for everybody, including a
privileged connection. The invoice is the record; the draft is the provenance
of a line on it.

## What this cost to get right

**A repo invariant caught a missing back link.** `tests/unit/back-navigation`
asserts that every page below a section offers a way back to it. The new screen
had a header button to the billing preview and not the shared component, which
is exactly the drift that test exists to stop.

## What this does not do

**It does not bill rent and utilities on one document**, for the reason above.

**It does not import a municipal bill.** Every figure is typed. Reading a
municipal statement — a PDF per property, with its own account numbers and its
own idea of a period — is a bigger piece of work and the first bug in it would
be somebody's water bill.

**There is no per-property tariff.** The rate is typed on each line. A tariff
table that knew Cape Town's step charges would remove most of the typing and
needs the municipality's own schedule to be worth trusting.

**And nothing apportions a bulk meter.** A block with one municipal meter and
twelve tenants is a split rule this does not have; today it is twelve typed
lines.
