# 0023 — Reviewing Spike's own conduct

**Status:** accepted · 2026-10-26

## The problem

`platform.audit.read` was named when operators got roles (ADR 0021) and had
nothing behind it. The reason it needed something changed shape a week later:
ADR 0022 made support sessions able to **change** a customer's records. "What
has Spike done inside our customers' data" stopped being a question about
reading, and the only person who could answer it was the operator who did it —
`audit_events_platform_own_select` shows an operator their own actions, and
nothing showed a colleague's.

Migration 0064 settled this argument once already, for platform actions, on the
grounds that *a review that cannot name who acted is not a review*. The same
sentence applies to an action taken inside somebody's records, more strongly.

## What we decided

One screen, `/platform/audit`, and one policy to make it possible.

### The review set

A row qualifies two ways:

- its action starts with `platform.` — Spike acting on an **account**:
  provisioning, plans, suspensions, operators, invoices; or
- it carries a `support_session_id`, which 0074's trigger stamps on anything
  done under a session — something done inside a customer's **records**.

`audit_events_platform_support_select` is the new policy, and its narrowness is
the whole point: `support_session_id is not null` is exactly the set of
session-stamped rows. A landlord's staff changing their own lease carries no
session id and stays as invisible to Spike as it has always been. The reviewer
gets their colleagues' conduct, not a window into the customers.

`audit_events_platform_select` was also restated from `is_platform_operator()`
to `app.platform_permission('platform.audit.read')` — unchanged in practice,
since every platform role carries that permission, and correct in principle for
the same reason 0073 restated the write policies. An operator holding no role
now reads nothing, which is what holding no role should mean.

`audit_events_platform_own_select` is deliberately left alone. Seeing what you
yourself did is not a privilege to withhold, and an operator whose roles were
just removed should still be able to account for their own work.

### A session row is not always Spike's, and that is deliberate

Approving a session and ending one carry the session id too, so the customer's
own decisions appear beside the work done under them: *SPK-4410 opened by Spike
Support, approved by Nomsa Dlamini, ticket re-filed, session ended by Nomsa
Dlamini*. That chain is what makes the middle row legitimate, and a view that
dropped the ends would be worse than useless.

This was a correction, not a plan. The screen's first description claimed "a
customer's own staff never appear here", and reading the real output showed
rows attributed to the customer's administrator — because they had ended the
session. The sentence was wrong rather than the rows; the copy now says what is
true: Spike's actions, plus the customer's decisions about those sessions, and
never their ordinary work.

### The file says what it covers

A review that has to be shown to somebody travels as a file, so the filters are
written into its head along with who generated it and how many rows matched
versus how many are in the file. A row torn out of context is how an audit
extract misleads.

`toCsv` from the reports module is not reused: it writes a currency and a
period into every file because a financial report has both. An audit extract
has neither, and borrowing it would have put "Currency: ZAR" at the top of a
list of operator actions.

### Said when truncated

The screen shows the most recent 200 and the table's heading carries the total,
with a line saying the list is cut short when it is. A reviewer concluding
"nobody has been in there" from a truncated first page is the failure this
avoids; `platformAuditTrail` returns `total` and `capped` from the same
conditions as the rows, so the count can never describe a different set.

## What this does not do

It is a review tool, not an alerting one: nothing watches this and nothing is
sent. It also does not expose a customer's own audit trail to Spike — that
still needs a live session, and then it is the customer's screen that shows it.
