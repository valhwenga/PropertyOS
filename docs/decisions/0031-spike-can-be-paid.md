# 0031 — Spike can be paid

**Status:** accepted · 2026-10-28

## The problem

`recordSubscriptionPayment` has always been honest about what it is: an
operator reads Spike's bank statement and types in what arrived. So
"outstanding" on the billing screen means "not yet recorded as received" rather
than "unpaid", every screen says so, and nothing in the product could take a
payment. Spike had a billing system and no way to be paid by it.

## What we decided

This is the collection side of **ADR 0004's second money flow** — Spike's own
revenue, which that decision deliberately keeps separate from any customer
financial book. Rent collection stays disabled, for the six reasons listed
there, and nothing here touches it.

### An attempt is a record, not a result

A customer pressing Pay creates a row meaning "somebody set out to pay this
invoice". It is not a payment. The provider decides whether money moved and
says so out of band, through the notification endpoint.

### Only a verified provider event may confirm one, and the schema enforces it

ADR 0004 says "browser redirects prove nothing", and until now that was a
sentence in a document. Now:

* `confirmed` requires a `webhook_event_id`, by check constraint;
* a trigger refuses the row unless that event's `signature_verified` is true;
* there is **no UPDATE policy** on the table for the application role at all,
  so the state that settles an invoice is not reachable from anything the
  browser can touch;
* the customer's INSERT policy refuses the shape as well as the intent — a row
  arriving already confirmed, or citing an event, is rejected.

The test suite asserts this against the database rather than through the code
path that is supposed to be careful: it takes a verified attempt, points it at
an unverified event, and expects the write to fail.

### The return page will not say "thank you, payment received"

It reports the attempt's recorded state, which immediately after a real
provider's redirect is usually still waiting. A page that congratulates
somebody for arriving is how a product tells a customer their invoice is
settled when the money never left.

### Short payments behave exactly as the manual path already does

A confirmed R400 against a R1 150 invoice records R400 and leaves the invoice
issued; the next Pay button asks for the remainder. Marking it settled for less
than it says would make the figure an operator trusts — what customers owe —
quietly wrong.

### One attempt at a time, and the operator can see it

Two tabs mean two references, two confirmations and one double payment. A
second attempt inside half an hour is refused while the first is unresolved.
And Spike's own billing screen shows "payment in flight" beside an invoice, so
an operator reading the bank statement does not record a transfer against an
invoice a card payment is about to settle.

### Payfast is the chosen provider and is deliberately not implemented

The adapter interface is built, the sandbox implements it completely, and
`SUBSCRIPTION_PAYMENT_PROVIDER=payfast` resolves to an adapter that refuses
with its reason — which the worker's preflight turns into a refusal to start,
the same treatment `RENT_PAYMENT_PROVIDER_ENABLED` already gets.

The reason is specific rather than cautious: Payfast's signature rule, its ITN
field names and its server-side validation callback have to come from the
official specification. This environment's network policy denies
`developers.payfast.co.za` and `payfast.io`, and the only material a search
returned was third-party libraries and forum posts. A signature written from
memory fails in the two worst ways available — subtly wrong rejects every real
payment, and wrongly permissive accepts forged ones — and both are silent.

### The sandbox provider is an adapter, not a mock

It signs its own notifications with HMAC-SHA256 over a canonical string and
verifies them the same way, and its page POSTs them to this product's public
notification endpoint over HTTP. So the signature check, the dedupe, the
unknown-reference path and the invoice settling are all exercised by the code a
real provider will travel through. What it cannot do is move money, and its
page says that in a yellow box twice.

## What the work found

**`webhook_events` was built in migration 0004 for a provider that did not
exist**, with its `(provider, provider_event_id)` uniqueness and a deny-all
read policy, and nothing had ever written a row to it. The dedupe needed no
design: it was waiting.

**One invoice per organisation per period** is enforced, correctly, and a test
helper that issued two invoices for one customer collided with it. Each test
invoice now bills its own period.

**Exported shell variables in the middle of a heredoc.** The preview's
`.env.local` is written by a heredoc, and two `export` lines added inside it
became literal text in the generated file — so the sandbox provider was
configured everywhere except in the process that needed it, and the page 404ed.

## What this does not do

**It does not charge anybody automatically.** This is a customer paying an
invoice they were sent, once, by pressing a button. No stored card, no
tokenised recurring charge, no debit order mandate — which for a South African
subscription business is likely the shape that matters, and is a different
piece of work with DebiCheck mandates in it.

**There is still no dunning, no trial expiry and no proration.** Nothing chases
an unpaid invoice, nothing ends a trial, and a plan changed mid-period is
billed as though it changed at the start. The overdue-invoice alert from 0030
is the whole of the chasing, and it tells Spike rather than the customer.

**And no refunds.** A payment taken in error is reversed at the provider and
then recorded here by hand, which is the same position the manual path has
always been in.
