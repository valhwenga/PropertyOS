# 0035 — A notice reaches somebody

**Status:** accepted · 2026-10-29

## The problem

The product has been writing notices to people since migration 0006 and
delivering almost none of them. Two separate failures, in the same handler.

**The notices had no reader.** `notifications` is read by the inbox as
`where recipient_user_id = <the signed-in person>`. The worker's `notify`
handler never set it. Five event types went through that handler — a receipt
allocation, a resident's proof of payment, a maintenance request, and the two
Spike support-access notices — and every one of them wrote a row no human being
could reach, then recorded it as **sent**. Not queued, not undelivered: sent,
which the console, the health counts and the alerting all believed.

**And the body was the template.** Those five templates carry `{{reference}}`,
`{{amount}}`, `{{resident_name}}`. Nothing in this product had ever substituted
one. A resident would have read "Maintenance request {{reference}} has been
logged".

Both were invisible for the same reason: with no mail provider configured, the
only thing that ever looked at these rows was a count.

## What we decided

### The schema refuses both states

An in-app notice without a `recipient_user_id` is not a message, so
`in_app_notice_has_a_reader` forbids it. A notice whose title, subject or body
still contains `{{` is worse than no message, so `notice_is_rendered` forbids
that. A notice with no recipient of any kind is addressed to nobody, so
`notice_is_addressed` forbids that too.

These are check constraints rather than care taken in the dispatcher, because
the dispatcher is not the only thing that writes notices — five call sites do —
and the next one will be written by somebody who has not read this file.

The existing rows in both states were deleted by the migration. They were
unreadable by definition, so nothing was taken from anybody.

### The renderer refuses, and says what it was not given

`renderNotice` substitutes `{{name}}` and throws naming every variable nobody
supplied. An empty string counts as missing: "You owe " is not better than a
refusal. `notification_templates.variables` records what each template needs,
derived in SQL from the template's own text rather than typed out beside it — a
list maintained by hand next to the thing it describes is a list that drifts.

### The audience is resolved from the event, explicitly

One branch per event type, each naming the tenancy or the organisation it
reads. A resident notice goes to the people with a live portal link on that
lease; an account notice goes to everyone holding
`organisation.settings.manage`. It runs on the worker's connection, which has
no session and no RLS, so the scoping is in the query and visible.

Where there is nobody who could read it, **nothing is written and the reason is
returned**. A resident with no portal access cannot be told anything by this
product; that is a fact about the product, and it belongs in
`docs/known-limitations.md` rather than in a row nobody can open.

### A key of our own for "already written"

The old handler used `provider_message_id` as its idempotency key. That column
is the provider's id for the message, which an email notice needs for exactly
that once it is delivered — so the key and the receipt were the same column and
the second would have overwritten the first. `dedupe_key` with a unique index,
and `on conflict do nothing` rather than a look-before-insert, because the
worker can redeliver one event into two passes at once.

### Something finally sends the queued ones

`deliverQueuedNotices` on the worker's watch pass. Until now
`sendInvoiceMessage` was the only thing in the whole worker that had ever
called the email adapter for a notification row, so every reminder, final
notice and queued message sat in the table forever. It is capped per pass,
oldest first, and `attempts` caps the retries: a provider that has refused the
same message four times will refuse the fifth.

The adapter's vocabulary is kept intact — `sent` only for a provider
acknowledgement, `development_sink` for the sink's honest refusal, `failed`
with the provider's own words. Nothing collapses the three, because the middle
one is the state this deployment is actually in.

### The alert had to be widened in the same breath

`notifications.undelivered` counted `queued` and `failed`. Once a delivery pass
exists, every undelivered message moves to `development_sink` — so the alert
would have gone quiet for a product delivering nothing at all. The states are
now named once, in `app.notification_backlog_states()`, read by the condition
and by the console. The jobs screen groups them by *why*, with the provider's
last words attached, because "17 undelivered" invites the wrong action and "no
mail provider is configured" invites the right one.

## What this cost to get right

**A reminder that said `115000`.** The dunning body built last week
interpolated minor units straight into a sentence: "115000 is still
outstanding". Found only because this slice is about what people actually read.

**`like '%\n%'` means "contains the letter n".** A backslash is LIKE's own
escape character, so the statement meant to find the two templates holding a
literal backslash-n matched all eleven. Harmless — `replace` rewrote nine of
them identically — but wrong, and asked by `position` now.

**And the two templates really did hold `\n`** as two characters, since 0008.
Nothing had rendered them, so nobody had seen it.

**A test that could only fail.** The browser spec pattern-matched the page for
something reference-shaped, picked up the LEASE reference in the portal header,
and then asserted that the inbox mentioned the lease. It reads the reference
the form itself prints now.

## What this does not do

**Nothing is delivered on this deployment.** The sink is still the adapter,
every email notice ends `development_sink` with the reason on it, and the
console says so. What changed is that the messages are now correct, addressed
and attempted — so configuring SMTP is the whole of the remaining work rather
than the start of it.

**A resident without portal access still cannot be told anything.** The
dispatcher says so and the worker logs it. Reaching them needs SMS or a
landlord with a phone, and this product has neither.

**Templates are not editable by anybody.** The wording lives in migrations.
A customer cannot change what their residents are told, and ADR 0014's
position — Spike's templates are Spike's — stands until somebody asks.

**And in-app is still the only channel that works end to end.** An in-app
notice is delivered by being written; everything else waits on a provider.
