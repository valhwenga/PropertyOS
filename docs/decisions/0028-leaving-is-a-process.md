# 0028 — Leaving is a process, not a flag

**Status:** accepted · 2026-10-27

## The problem

`setAccountStatus('closed')` set a column. That was offboarding. The console
stopped opening, the records sat there indefinitely, and nothing recorded why
the account closed or what would happen to what was in it.

Three things followed from that, and all three are worse than they sound.

A customer who left had **no way to take their records**. The export route has
only ever needed a membership, so a closed customer's archive still built — but
`requireOperator` sends their staff to the closed page, and the only link to
that archive was on a console page closing had just taken away. The way out
existed and could not be reached, which is the same as not existing.

A customer who asked to be **deleted** could not be. `customer.export` is a
customer permission and export is in no support scope, so Spike could not even
run it on their behalf; there was no deletion path at all, for anybody. Before
real customer data lands, that is the gap worth closing first.

And the closed page said, in as many words: *"there is no path in this product
that deletes a customer's records."* It was true when it was written.

## What we decided

Closing records a reason and a date. The customer takes their archive while the
clock runs. After the date, an administrator may destroy what is left.

### The date is the brake, and nothing runs on a timer

The retention date does not destroy anything when it passes. It stops being a
refusal. A product that deletes a landlord's tenancy history on a schedule is a
product that deletes it the first time somebody fat-fingers a date.

The default is sixty months, as a platform setting. Five years is the period a
South African landlord's financial records are commonly kept for; it is Spike's
own default and the setting's own description says to confirm it against your
own advice rather than ours. Where a customer asks for removal sooner, the date
moves — as a recorded decision with a reason, not as an operator editing a date
in the database.

### Closing is one door now

`setAccountStatus` refuses `closed`, and the status form no longer offers it. A
closed account with no retention date is one nobody can destroy and nobody can
answer the customer about, so there is no path that produces one. Reopening is
still `setAccountStatus`, and it deletes the closure row: the clock stops
because the customer stayed.

### Destruction keeps Spike's records and removes the customer's

The `organisations` row was never deletable. `subscription_invoices` references
it with NO ACTION, so deleting a customer would mean destroying Spike's own
invoices to them first. That constraint is right — Spike's tax records are
Spike's obligation, not something a departing customer can erase — and it
settles the shape of the whole feature. The organisation stays as a tombstone.

What is destroyed is **every row carrying that organisation_id**, found from the
catalogue rather than from a list, because a hand-written list of eighty-six
tables stops being complete the next time somebody adds one. The keep list is
the short half, and every entry on it is Spike's rather than the customer's:
the subscription invoices, the audit of Spike's own conduct, and the support
sessions and access windows the customer authorised.

The function proves its own result. After the passes it asks every one of those
tables for a count and raises if a single row is left, so a FK that quietly
blocks a delete fails the destruction instead of half-finishing it.

The customer's **own** audit entries go with their records: an entry naming
which resident was added, and what their details were before somebody changed
them, is exactly the personal information this exists to remove. What stays is
`platform.%` — Spike's conduct — plus `customer.exported`, which is the evidence
that they took their data before leaving.

### Destroying rows is not destroying files

A document's bytes live in a bucket, and `documents.storage_key` is the only
record of where. Deleting the row without removing the object leaves the lease
agreements, inspection photographs and identity documents in place with nothing
left in the database to find them by — unreachable personal information, which
is worse than not having destroyed anything.

So the keys are read **before** the purge and handed back to the caller, which
removes the objects once the transaction has committed. The order is forced:
object storage has no rollback, so a transaction that failed after emptying a
bucket would leave rows pointing at files that no longer exist.

A file that will not delete does not fail the destruction — the records are
already gone, and failing there would only hide it. Its key is written to the
closure and into Spike's own trail instead, and the panel shows it in red until
somebody finishes the job. A file left behind with its key written down is a
job; a file left behind with its key deleted is personal information nobody can
ever find again.

### The people are anonymised, not deleted

This is the decision the FK graph forced, and it is the right one anyway.
`support_sessions.authorised_by` points at the customer's own administrator —
the record of their consent to Spike reading their records. Deleting that
person's row would delete the evidence of their consent along with it.

So an identity left with nothing to belong to keeps its row and loses everything
that identifies a person or admits one: name, email, phone, password, second
factor. The password becomes a value `verifyPassword` cannot parse rather than
an absent one somebody could then set. Somebody who also works for another
landlord on Spike is left entirely alone — this account closing is not an event
in their life anywhere else.

### Only administrators, and only with the name typed

`platform.customers.destroy` is administrators only, unlike
`platform.operations.manage` which support shares. Everything else in this
console is recoverable or reviewable; this is the one action with nothing
behind it. The typed identifier is not security — the caller already holds the
permission — it is there so that destroying the wrong customer's records takes
more than clicking a button on the wrong row.

Moving the retention date takes the same permission rather than the one that
closed the account, because moving it decides when destruction becomes possible.
Support can close an account and cannot bring its destruction forward.

## What the work found

**The first version of this would have left every document in the bucket.**
The destruction was pure SQL, which is exactly the shape that reads as
complete: every table empty, the test suite green, and the customer's signed
leases and identity documents still sitting in storage while the page told them
their documents had been deleted. The storage adapter has had a `remove` since
it was written and nothing in the purge called it. Found by asking what a
document actually is rather than by any test failing.

**And the fix for it was wrong in a way the test suite endorsed.** Reading the
keys in TypeScript before calling the purge passed every test and would have
collected nothing in production: `documents` is keyed on membership, an
operator is a member of nothing, and a Server Action runs under the operator's
own context. The tests passed because `asPlatformOperator` lifts row-level
filtering and the application does not — a harness that is kinder than
production, which is the only kind of harness that can agree with a bug. The
keys now come back from the security-definer function, so there is no way to
destroy the rows without being handed them, and there is a test that runs the
destruction under the context the application actually uses.

**A policy and a permission that disagreed.** `setRetention` asked for
`platform.customers.status` while the row's UPDATE policy required
`platform.customers.destroy`. Row Level Security refuses an UPDATE by matching
no rows rather than by raising, so the caller would have been told it worked.
The permissions were reconciled, and the statement now returns the row it
changed and refuses when it changes nothing — a silent success is the one
failure mode worth writing extra code for.

**Table grants are not policies.** `organisation_closures` had five correct
policies and no `grant`, so every caller got `permission denied for table`. The
integration suite found it immediately; nothing about reading the migration
would have.

**A broken fixture that reported itself as eight skipped tests.** Making
`setAccountStatus` refuse `closed` broke the subscription billing suite, whose
fixture closes a customer to prove the run names who it did not bill. Vitest
reported the suite as *"16 tests | 8 skipped"* and the run exited zero: a
`beforeAll` that throws leaves its tests skipped rather than failed, so the
total went up and nothing went red. The first read of the summary was
"1046 passed", which was true and not the whole truth. The fixture now closes
through `closeCustomer`, which is also the honest fix rather than a way around
the refusal.

**`platform_support` cannot close an account.** `platform.customers.status` is
administrators only — the same permission that suspends. The first draft of the
test suite assumed support could close a customer, which was a wrong premise
rather than a missing permission, and it stays that way.

**An event with no handler is a dead job.** `OUTBOX_EVENT_TYPES` is a closed
list for exactly that reason, so closing emits the existing
`platform.account.status_changed` rather than a closure event nobody registered.
Destruction emits nothing at all: the outbox rows for that organisation were
just deleted, and a notification to a customer who no longer has anybody to
notify is a job that exists only to fail.

## What this does not do

Nothing is automatic. No reminder when a retention date approaches, no list of
accounts past theirs on the platform home page, no notification to the customer
that their account closed — the closed page tells them when they next sign in,
and that is all. A customer cannot ask for closure themselves; they ask Spike.
And the archive is still the same CSV bundle the console offers, built on
request: a large account takes a minute, nothing warns them of that before they
click, and it still carries no document bytes — the manifest names every
attachment with its key and SHA-256, and the files themselves are not in it. A
customer who wants their documents has to ask, and after destruction there is
nothing to ask for.

Nothing retries a stored file that would not delete, either. The keys are kept
and shown, and removing them is a person's job with a storage console.
