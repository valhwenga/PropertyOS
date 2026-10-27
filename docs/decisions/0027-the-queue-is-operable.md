# 0027 — The queue is something you can act on

**Status:** accepted · 2026-10-27

## The problem

`failJob` has moved exhausted work to `dead` since the worker was written, and
the platform home page has counted those rows under *"Failed jobs — needs an
operator to inspect"*. There was nothing to inspect with: no list, no error
text, no payload, no attempt history, and no way to run one again. At pilot,
the first dead job means somebody opening a database connection.

## What we decided

`/platform/jobs`: what failed, what killed it, and two decisions — run it
again, or record that it never will.

### Jobs needed real policies, not another counting function

`jobs_select` is keyed on membership and an operator is a member of nothing, so
an operator saw none of them — which is why the health counts come from a
definer function. Counting more things through that function would not have
helped: an operator has to read the error text and the payload to tell a broken
handler from a database that was briefly away.

Read and act are the same permission, `platform.operations.manage`. Splitting
them would have produced a role that can see a failure and not clear it. It is
given to **support as well as administrators** on purpose: a queue that backs
up is firefighting, the person awake is usually support, and the only decision
available is whether work the customer already asked for runs. It changes
nothing commercial, which is the line the support role is otherwise drawn on.

Showing the payload is consistent with the rule `emitEvent` has carried since
it was written — payloads are identifiers and amounts, never personal
information — and a job payload *is* an outbox payload.

### Running a job again is not Spike choosing what happens

The handler was queued by the customer's own action and does what it was always
going to do. The operator decides only *whether* it runs, and that is audited
against the customer it affects. There is no path in the module that edits a
payload.

The attempt counter goes back to zero, because an operator only presses it
after fixing the cause; leaving the count would give the job one attempt and
kill it again, which reads as "the fix did not work".

What it does **not** promise is that the handler is safe to run twice. A
handler that failed after doing half its work will do that half again, and the
screen says so in those words rather than implying a clean replay.

### A dead job that will never run gets a status, not a deletion

Deleting it loses the evidence. Leaving it dead keeps a count nobody can clear,
and a permanent red number is a number people stop reading. `abandoned` says a
person decided, and carries who and why. The worker claims `status = 'queued'`
and nothing else, so the status alone makes it inert — asserted in a test
rather than left to trust.

### One broken handler is one cause

A handler broken for an afternoon produces two hundred dead jobs of one kind.
The screen groups by handler and offers one decision for the group, because
retrying two hundred by hand is how somebody gives up halfway and leaves the
red number there for good.

### The page says when the worker looks dead

A long queue with a recent oldest entry is a busy worker; a long queue whose
oldest entry is from yesterday is no worker at all. The banner says which, and
says plainly that nothing on the page restarts it — otherwise the retries
queue up behind the same wall.

## Two things the work found

**A success message that cannot survive its own re-render.** A bulk retry
empties the cause from the page, so the line announcing "3 jobs back on the
queue" renders into a component that has just been unmounted. This codebase
had already settled it: the support-access controls show no success messages
because the changed state says more than a line beside a button that has itself
disappeared. The same rule applies here, and the browser test asserts the
disappearance instead.

**I overwrote an existing test file.** `tests/integration/operations.test.ts`
was the milestone-3 acceptance suite; writing the new queue tests to that path
replaced 29 tests with 7. Restored from git and renamed to `job-queue.test.ts`.
The domain module is `operations.ts` and was genuinely new; only the test path
collided.

## What this does not do

It does not restart the worker, retry on a schedule, or alert anybody —
`/platform/audit` and this page are both things somebody has to open. It does
not let an operator edit a payload or compose a job. And the outbox backlog and
undelivered notifications are still counted rather than actionable: the first
is the worker's own job to drain, and the second waits on an email provider
that does not exist.
