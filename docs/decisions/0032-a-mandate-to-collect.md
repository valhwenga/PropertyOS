# 0032 — A mandate to collect

**Status:** accepted · 2026-10-28

## The problem

0031 let a customer pay an invoice by pressing a button. That is not how a
subscription business is paid in South Africa. It is paid by debit order,
against a mandate the payer authenticated through their own bank — and without
one, somebody has to remember to press the button every month. The first month
they forget is the month Spike is funding them.

## What we decided

This migration is the **mandate** and nothing else. Collections against it are
the next piece of work: an instruction that moves money needs the sponsoring
bank relationship, and the authority has to exist first and be impossible to
fabricate afterwards.

Still ADR 0004's second money flow. A tenant's debit order to a landlord is the
first, and stays disabled for the six reasons listed there.

### The authorisation is the artefact, so it is capped and explicit

A mandate names a maximum amount, a day of the month and a date it starts from.
The maximum is not decoration: when collections are built, that is the number
they will be checked against, and a collection that exceeds what the payer
agreed to is the thing this record exists to make impossible.

The screen says it as a sentence — *"Spike may collect up to R2 500 on the 1st
of each month"* — rather than offering a field labelled Amount, because that
sentence is what the payer is agreeing to.

### The terms are immutable

Changing what a payer agreed to is not an edit. Under DebiCheck an amendment is
itself authenticated by the payer, so until that flow is modelled properly the
only honest path is to cancel and ask them to authenticate another — which
leaves both records in place. A trigger enforces it: the amount, the day, the
start date, the account and the organisation cannot change, by anybody,
including by a privileged connection.

### Only a verified provider event may authenticate one

The same rule as a confirmed payment, for the same reason: a page saying
"thanks, that's authorised" proves nothing about what the payer's bank did.
Check constraint, trigger on `signature_verified`, no UPDATE policy for the
application role, and an INSERT policy that refuses a row claiming to be
authenticated.

### One live mandate per customer

Two live mandates are two authorities over one account, and the second is the
one nobody remembers agreeing to. A partial unique index, so it is not
possible rather than merely discouraged.

### The payer may withdraw it at any time, including without telling us

A debit order authority can be cancelled by the account holder at their own
bank. So cancellation arrives as a provider event as well as being something
the customer can do on their own screen, and arriving unprompted is normal
rather than an anomaly. `cancelled_by_payer` records whose decision it was:
a payer withdrawing authority and Spike ending a facility are different events
with different consequences, and inferring which from a sentence somebody typed
is not good enough for an authorisation record.

### The account number is sealed

The same treatment `bank_accounts` and the lease refund account already get:
`account_number_cipher` plus four digits in the clear, so a screen can say
which account without opening the seal. `openMandateAccountNumber` is a
function of its own with one intended caller — the collection instruction that
will one day be submitted to a bank — so no screen can leak it by accident.
The browser test asserts the number never appears in the page, including on the
authorisation page itself.

## What the work found

**The panel was trapped inside "have you been invoiced yet".** Rendered in the
branch that draws the invoice list, so a customer who had never been billed —
precisely the person who wants to set up a debit order, at sign-up — could not
see it at all. Found by a browser test looking for something that was not
there.

**The dedupe wanted to be shared.** Mandates and payments both record provider
events, and a second copy of "insert, let the unique index decide, mark it
processed" is how two dedupes end up disagreeing about what already-seen means.
That is now `provider-events.ts`, and the payment suite passing unchanged
afterwards is what says the refactor was sound.

**Cancellation cannot run on the application role.** There is deliberately no
UPDATE policy on the table, so the Server Action runs `command({ privileged })`
— which lifts row filtering while keeping the caller's identity, so the
permission check in `cancelMandate` is still a real one in SQL. The integration
test had to do the same, and the first version of it failed because the owner
connection has no `auth.uid()` at all.

## What this does not do

**It collects nothing.** There is no collection instruction, no submission, no
unpaid-reason handling and no retry. That is the next piece, and it is the one
that needs a sponsoring bank or a provider with a debit order facility, a
registered user code, and the action-date rules.

**It is sandbox-only, like 0031.** The sandbox stands in for the payer's bank
and says so in a yellow box: under DebiCheck the real authentication happens
inside the payer's own banking app, which is exactly the part no stand-in can
imitate. Payfast remains unimplemented for the reasons in 0031 — and whether
Payfast is even the right provider for debit orders is an open question, since
the SA debit-order providers are often different companies from the card
gateways.

**DebiCheck's own fields are not modelled**: no tracking indicator, no debit
value type, no amendment flow, no mandate-initiated collection types. Those
come from the provider's specification, with the rest of it.

**And Spike cannot end a mandate.** Only the payer can, or their bank. The
column that distinguishes the two exists so that when Spike needs to, nobody
has to guess which happened.
