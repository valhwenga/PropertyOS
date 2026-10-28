# 0033 — Collecting on the mandate

**Status:** accepted · 2026-10-28

## The problem

0084 recorded the authority. Nothing used it: a customer could authorise Spike
to collect and Spike still had to wait for somebody to press Pay.

## What we decided

Three separate acts, because collapsing them is how a wrong number reaches
somebody's bank account.

**Prepare** is arithmetic over invoices and mandates. It produces instructions,
takes nothing, and can be run again safely. **Submit** hands one instruction to
the provider, and a person does that, not a timer. **The outcome** is the
bank's word, days later, through the notification endpoint — and it is the only
thing that can mark a collection successful.

A single "run the collections" button would mean the first bug in the
arithmetic is discovered by the customers it debited.

### The cap is enforced where it cannot be argued with

A collection may never exceed the mandate's authorised amount, and a trigger
reads the mandate to check it. Not the code that prepares the instruction: the
thing that must not be possible should not depend on the code that happens to
be asking. The same trigger refuses a collection that starts before the mandate
does, belongs to another customer, or stands against a mandate that is not
authenticated.

It also refuses at submission time, separately, because a payer can withdraw
authority between the 29th and the 1st and a cancelled mandate must not be
debited.

### Where the debt exceeds the authority, it skips and says who

The run collects **what is outstanding** rather than what the invoice says, so
a part payment is not debited twice. Where the outstanding amount is more than
the payer authorised, it does not take the cap: it skips, and names the
customer and the reason. Debiting the cap would leave an invoice short-paid
that nobody decided to short-pay, and the fix is a conversation about their
mandate — which the skip reason tells the operator to have.

The run names everybody it skipped, for the same reason the billing run does:
an operator needs to know who is **not** being collected from.

### One live instruction per invoice

Two instructions is two debits for one debt, and the customer's recourse is a
dispute Spike caused. A partial unique index, so it is impossible rather than
discouraged.

### A dispute is the undoing of a settlement that never happened

A payer can challenge a debit after it succeeded and have their bank reverse
it. The money did not arrive, so the invoice owes what it always owed —
`reverseFundsOnInvoice` puts it back to issued and clears the paid date. That
is not a credit note and not an adjustment, and the collection keeps the
reason.

### One settlement rule, three ways in

There are now three ways money reaches one of Spike's invoices: an operator
reading the bank statement, a card payment, a debit order. `invoice-settlement.ts`
holds the rule they all use — settled when what arrived covers what it says,
and not before — because a second copy is how one of them starts marking
invoices paid for less than they say.

### The account number travels once

A bank cannot be instructed with four digits, so submission opens the sealed
number, holds it for the length of one call, and hands it to the provider. It
is not logged, not returned to the browser, not in the audit entry, and the
failure path deliberately logs the reference rather than the instruction.

### The customer sees what is about to leave

Their subscription page lists what is being collected, when, and against which
invoice — before it happens, and with the bank's reason if it fails. A customer
finding out from their bank statement is how a debit order becomes a dispute.

## What the work found

**A Server Action with no completion signal.** The sandbox "bank" posted its
notification and returned nothing, so a browser test had nothing to wait for:
it raced ahead, the next test's cleanup deleted the row, and the notification
arrived afterwards for a reference the endpoint had never heard of. The log
line `unknown_reference` was true and the cause was three steps upstream. It
redirects now, which is both the signal and the right behaviour for an
operator.

**A stubbed cipher is not a sealed field.** The browser seed wrote
`decode('00','hex')` into `account_number_cipher`, and submission — which opens
it — failed silently behind an error message nobody asserted on. The seed seals
a real number now.

**`'\x00'` in a tagged template is a NUL byte**, which the Postgres wire
protocol cannot carry: eight tests failed at once with "insufficient data left
in message". `decode('00','hex')` says the same thing without it.

## What this does not do

**Nothing is submitted automatically**, and no provider can submit anything:
the sandbox is still the only adapter, Payfast remains unimplemented for the
reasons in 0031, and whether Payfast does debit orders at all is an open
question — in South Africa the debit-order providers are frequently different
companies from the card gateways.

**There is no retry or representment.** An unpaid collection can be abandoned
or left; nothing re-presents it on a later date, and the rules for doing so are
the provider's and the bank's rather than ours to invent.

**And DebiCheck's own fields are still unmodelled** — tracking indicators,
debit value types, the amendment flow. They come from the specification with
the rest of it.
