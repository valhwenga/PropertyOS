# 0034 — Trials end, and debts are chased

**Status:** accepted · 2026-10-28

## The problem

Two holes, both of them revenue, both of them invisible because nothing ever
looked.

**A trial had no end.** `subscriptions.status` could be `trialing`, and nothing
in the product ever moved it off. Every customer ever provisioned was free
until somebody noticed and changed a dropdown by hand. The billing run skipped
them by status, politely and forever.

**An overdue invoice was counted, not chased.** 0082 raised an alert saying how
many invoices were overdue. An alert is a number on a dashboard; it is not a
reminder in somebody's inbox, and nobody was sending one.

## What we decided

### A trial ends on a date

`subscriptions.trial_ends_on`, backfilled from the organisation's creation date
plus `trial.length_days` (30) for every customer still on trial. The billing
run keys the skip on that date rather than on the status: a period that starts
after the trial ended is billed, the account is moved to `active` with a reason
naming the date and the invoice, and the subscription stops being a trial.

The run does it rather than a timer, because the thing that ends a trial is the
first invoice and the run is what issues invoices. A separate nightly job that
flipped statuses would mean an account could be `active` with nothing billed.

### The ladder sends messages; a person takes things away

`chaseOverdueInvoices` runs on the worker's watch pass, takes no actor, and
records steps: a first reminder at 3 days, a final notice at 10, and at 21 days
it writes down that suspension is the next thing somebody *could* decide. That
is as far as it goes. Suspension itself is `suspendForNonPayment`, which needs
a platform permission, a reason, and a person — the same division this product
has kept since ADR 0017, for the same reason: suspension stops a landlord
reaching their own tenancy records.

The proposal step sends the customer nothing. Telling somebody "you are about
to be suspended" before a person has decided would be a threat the product
invented by itself.

### One step per invoice per day

Keyed `(invoice_id, step)` in the database, so a pass running every five
minutes cannot send four reminders an hour. The uniqueness does that, not the
function remembering.

And at most one step per invoice per pass per day. Without it, the first pass
over an existing backlog would send a reminder, a final notice and a
suspension proposal in the same minute — three contradictory messages from a
product that had simply not been watching. One step a day means a sixty-day-old
debt climbs the ladder over three days, in order, the way it would have if
somebody had been chasing all along.

### The customer can see they are being chased

`organisationDunningSteps`, on their own subscription page, in plain words:
what was sent and when. Being chased in silence is how a suspension arrives as
a surprise. The panel also says what non-payment never does — their records are
not deleted and the resident portal keeps working — because that is true and a
worried customer should not have to ask.

Visible to whoever runs the organisation, by RLS on
`organisation.settings.manage`. A contractor does not see the company's debts.

### Stopping is not writing off

`stopChasing` records `written_off` and stops the ladder. The invoice still
says what it says: voiding it is a separate, deliberate act with its own
audit trail. The case this exists for is the ordinary one — the customer rang,
it is being sorted out, and nobody wants reminders going out in the background.

## What this cost to get right

**A string compared to a Date is quietly false.** The trial guard read
`if (trialEndsOn > periodStart)` where `trial_ends_on` came back from the
driver as a JS `Date` and `periodStart` was `'YYYY-MM-DD'`. JavaScript coerces
the Date to a number, the comparison is always false, and every trial would
have been treated as ended. The same implicit conversion had already been
sitting in the pre-existing `if (r.issueDate < periodStart)` guard, which has
therefore never once fired in the life of this product. Both are fixed by
casting the dates `::text` in SQL, which also makes the declared return type
true for the first time.

**Shared global state between test files.** The trial test wrote Spike's own
invoicing identity, which is global, and the suite asserting what happens when
that identity is *absent* ran in parallel against the same database and broke.
The test moved to the file that already has those details saved in its
`beforeAll`. Nothing about the code was wrong; the test was in the wrong file.

**Steps ordered by timestamp are not ordered.** Several steps recorded in the
same transaction share a `taken_at` to the microsecond, so the ladder came back
in whatever order the planner felt like. Ordered by the rung's rank in SQL now.

## What this does not do

**Nothing is written off automatically, and nothing is suspended
automatically.** Both are a person's act, and the screen is built so neither is
the default button.

**There is no second cadence.** A reminder goes out once per step, not weekly
until paid. Dunning that nags on a schedule needs a scheduling model and a way
for a customer to say "I know", and it has neither.

**A suspension does not collect anything.** It stops the console; it does not
re-present a failed debit order or chase the debt further. The debt survives
the suspension and the invoice survives both.

**Nothing emails the customer about the trial ending** before it does. The
first they hear of it is the invoice, which is not good enough and is written
down in `docs/known-limitations.md` rather than quietly fixed with a template
nobody has written.
