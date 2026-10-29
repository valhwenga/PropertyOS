# ADR 0019 — Spike charges the landlord

**Status:** accepted
**Date:** 2026-10-21

## Context

Plans, prices, unit allowances and an overage rate have existed since the first
migration. Nothing had ever charged anybody. A customer could sit on the
portfolio plan at R899 a month with eleven units above its allowance and owe
nothing, because no invoice existed to owe — the reconciliation document
carried the whole area as **Absent**, which was at least honest.

## Decision

### Spike's billing identity is configuration, not a constant

An invoice carries a supplier's registered name, address and VAT registration
number. This repository does not know Spike's, and inventing a VAT number would
be inventing a tax document. They live in a single row an operator fills in,
and:

* **nothing can be issued** without a legal name and an address. An invoice
  without them is a number on a page;
* **with no VAT number there is no tax on the document**, the rate stored on it
  is zero, and it is headed INVOICE rather than TAX INVOICE. This is the rule
  `docs/scopes/vat.md` sets out for the landlord's own documents, applied to
  Spike's: a document that calls itself a tax invoice is one somebody's
  accountant will claim against;
* each invoice records **what the VAT number was at issue**. Registering later
  does not retrospectively put tax on a document already sent.

Note which supply this is. The landlord's rent to a resident is usually exempt
under section 12(c); Spike's software to the landlord is an ordinary
standard-rated service. The two have nothing in common but the word VAT.

### One invoice per customer per period, enforced by the schema

`unique (organisation_id, period_start)`. A billing run is a button an operator
presses again when they are unsure whether the first press worked, and
double-charging is the worst available outcome. The second press reports who
was **already invoiced** rather than failing or issuing a second invoice.

### Who is not billed, and why

* **A trial.** A trial is the state of not paying yet; invoicing one would make
  the word meaningless.
* **A closed account.** Nothing accrues after the relationship ends.
* **A plan with no price in the plan table** — the enterprise plan is agreed
  separately. A R0.00 invoice would be noise, and writing a negotiated price
  into the shared plan row would be worse.

**A suspended customer IS billed.** That is the same position ADR 0017 takes:
suspension stops the console and nothing else. Their records, their own billing
run and their residents' portal carry on, and a suspended customer who owed
money last month still owes it.

The run returns the skipped customers **by name with a reason**, and the screen
prints them. "47 invoices issued" with three customers quietly missing is how
a month's revenue goes astray unnoticed.

### Usage on an invoice is a snapshot

The unit count, the allowance and the overage are stored on the invoice row as
they were when the run read them. A customer who adds twenty units in April
does not change what March said. The counts come from
`app.platform_customer_usage()`, the same counts-only function the operator
console uses, because the customer's own tables are closed to an operator.

### An issued invoice is immutable

A trigger refuses any change to what it charged — the organisation, the number,
the period, the totals, the plan, the units, the VAT number. The only way to
withdraw a charge is to **void it with a reason**, and a voided invoice cannot
be reinstated. A document a customer has already read is not a draft.

### A short payment is recorded as what arrived

There is no payment provider and no debit order anywhere in this product. An
operator reads Spike's bank statement and records what came in, with the
reference. If it is less than the invoice, the invoice **stays unpaid** and
shows what was received. Marking it settled for less than it says would make
the one figure this area exists to produce — what customers owe — quietly
wrong, and the screens say "not yet recorded as received" rather than implying
a reconciliation that is not happening.

### What the customer sees, and who

Their own invoices, with every line, the net, the tax (or the statement that
none is charged), the total, what is owing, and where to pay it. The policy is
`organisation.settings.manage` rather than membership: what Spike charges is
commercial information about the business, in the same class as its banking
details, and not something every colleague reads.

## Consequences

* The demo landlord becomes an **active** customer rather than a trial, and
  Spike's own invoicing details are seeded. Both demo organisations were on
  trial, so the entire billing area showed nothing in the demo and a run
  reported two customers skipped and no invoice. Found by running it; the
  second demo organisation stays on trial so the skip is visible too.
* Two new tables are exempted from the invariant that every customer table
  carries an `organisation_id`: `platform_billing_settings`, which belongs to
  the company doing the charging, and `subscription_invoice_lines`, whose
  organisation is on the invoice. The second exemption is only honest because a
  test asserts an administrator of one customer cannot read another's lines.
* **Still absent, and still said so on the screens:** no payment provider, no
  debit order, no dunning, no trial expiry, and no proration when a plan
  changes mid-period. *(All but proration were built in 0031–0034. Left as
  written: these records are dated, not maintained — `docs/known-limitations.md`
  is the living account.)*

## Addendum — the document (same day)

An invoice a customer cannot keep a copy of is not much of an invoice, so both
sides download the same PDF, from one renderer and one read.

It is a separate renderer from the landlord's own invoice, deliberately: that
one is the landlord's document, carries their logo and accent and one of three
designs they choose, and is addressed to a resident. This is Spike's document,
has one plain form, and is addressed to a business.

Two decisions inside it:

* **The heading is derived from the invoice, not from today's settings.** It
  reads TAX INVOICE only where the invoice itself recorded a VAT registration
  **and** shows tax. Reading the live settings would let a document change its
  mind — Spike registering in June would retitle the invoice sent in March —
  and a document whose text changes is not a document. A test asserts the
  half-done state too: a registration recorded with no tax on the invoice is
  still headed INVOICE, because a TAX INVOICE showing no tax fails section
  20(4) either way round.
* **The recipient's name and address are captured on the invoice at issue**,
  which needed migration 0068 and a new definer function. A tax invoice carries
  the recipient's particulars, and the billing run could not read them:
  `organisation_profiles` is customer data and a platform operator holds no
  membership. `app.platform_customer_billing_identity()` returns three fields —
  registered name, registered address, VAT number — to a platform operator and
  nothing else, and is the only route; a test asserts the operator still reads
  nothing from the table directly. Where a customer has recorded no
  particulars the document falls back to the organisation's name and says
  "Address not recorded", because inventing an address is worse than admitting
  there is not one.
