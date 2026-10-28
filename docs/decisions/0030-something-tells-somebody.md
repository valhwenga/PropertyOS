# 0030 — Something tells somebody

**Status:** accepted · 2026-10-28

## The problem

Every signal this product had was a screen somebody had to remember to open.

`/platform/jobs` knows what the worker gave up on. `/platform/audit` knows what
Spike has done inside customer records. `/platform/recoveries` knows that a
landlord is locked out and only Spike can let them back in. The closure panel
knows that a retention date has passed. The billing screen knows about an
invoice nobody chased. All of them correct, all of them unread until somebody
thought to look.

A pilot does not fail because the numbers were wrong. It fails because the
first dead billing job was found three weeks later by the customer it affected.

## What we decided

The conditions get defined once, the worker asks on a cadence, and the console
says so on every page rather than one.

### The conditions live in SQL, in one function

`app.platform_alert_conditions()` returns one row per thing that is wrong, and
the console, the worker and the tests all read it. A threshold written twice is
a threshold that will eventually disagree with itself, and "the worker may be
gone" is the one nobody would notice disagreeing.

It is unguarded and granted narrowly, which is the opposite of the pattern
everywhere else here. The worker connects as its own role with no `auth.uid()`,
so a guard on `is_platform_operator()` would mean the one process that can act
on a schedule is the one that cannot read the conditions.
`app.platform_alerts()` is the guarded way in, and is what the application role
may call.

An empty result is the good state, and the screens say that in words rather
than showing an empty box.

### The banner is in the layout, not on the home page

The home page already carried the counts, and nobody opened it. An operator
deep in a customer's plan change is exactly the person who needs to know the
worker has stopped, so the banner is in the console shell and appears on every
page — one extra query against counts.

Only **critical** conditions, and only unsilenced ones. A banner that carries
every warning is a banner people learn to read past, which is the failure mode
worth designing against rather than the one that looks thorough.

### An alert you cannot quieten is one people stop reading

A condition can be silenced, with a reason and an expiry, by somebody holding
`platform.operations.manage` — the permission that can act on all of these, and
one support shares with administrators for the same reason the queue screen
does.

Silenced is **not hidden**. It stays in the list, greyed, with who silenced it,
why, and until when. Hiding it would recreate the original problem one level
down, and the thing a colleague most needs to know is that somebody quietened
the dead-job alert until Thursday. An expiry is required and capped at thirty
days: a silence with no end is how a condition stops being an alert and becomes
something nobody remembers agreeing to ignore.

### Raising, delivering and believing are three different things

The worker raises a notice **per recipient**, then tries to send it, then
records what happened to that attempt on the notice. One row per condition
could not answer the only question that matters — did anybody actually get told
— so there is one per person.

With no mail provider configured, every notice is recorded `undeliverable` with
the sink adapter's own reason on it, and the console shows "0 of 2 delivered"
with that reason underneath. That is the honest state of this deployment, and
it is better stated than a product that believes it has told somebody.

A condition still true tomorrow raises again tomorrow: the repeat window is a
setting, one notice a day by default rather than one every five minutes.
Silencing is how you stop it on purpose.

### Nothing here may stop the queue

The watch pass is wrapped so that a mail provider which is down, or throws,
cannot stop rent charges posting. An undeliverable notice is recorded as
undeliverable and the loop carries on. The alert about the alerts is the
undelivered-messages count, which is itself one of the conditions.

## What the work found

**Every notification email went to `resident@example.invalid`.** The `notify`
handler sent the template's raw body to a hard-coded fake address and recorded
the result as a delivery. Against the development sink that was invisible; with
SMTP configured it would have mailed a fabricated address and written `sent` in
the database. There is no recipient resolution for those events and no template
rendering, so it no longer sends at all: the notice is recorded `queued` with
that reason on it, and the growing count of undelivered messages is now one of
the conditions this work raises. It also no longer throws, because a job that
fails for a missing product feature dies in the queue every time and tells an
operator nothing they can act on.

**Two of these tests assumed a quiet database and passed only alone.** The
assertions "no dead-job alert yet" and "the pass raises nothing now" are about
the whole system, and the suite runs files in parallel against one database
while other suites create and kill jobs of their own. They passed in isolation
and failed in the full run, which is the right way round to find it. They now
assert what this file created, by alert key; "nothing is wrong on a quiet
system" is asserted in the browser spec, against the demo database, where it is
actually true.

**The schema refuses to leave the platform with no administrator.** A test that
wanted "a condition with nobody to tell" tried to clear
`platform_operator_roles` and was refused by the constraint trigger from 0072,
correctly. It takes the permission away inside a rolled-back transaction
instead.

## What this does not do

It does not send anything anywhere until `EMAIL_PROVIDER` and the SMTP settings
are configured — the adapter and the worker pass are built and the notices
accumulate as undeliverable until then. There is no second channel: no SMS, no
webhook, no paging.

It tells **Spike** and not customers. A landlord whose own queue is backed up,
or whose invoice run failed, learns nothing from this; their notifications are
the stub described above.

And it is still only as good as its conditions. It knows nothing about
response times, error rates, disk, certificate expiry or whether the web
application is up at all — a watch pass that runs inside the worker cannot
report that the worker is not running. That one needs something outside this
product looking in.
