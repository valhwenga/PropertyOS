# ADR 0016 — An invoice is a document, and a statement is not one

**Status:** accepted · **Date:** 2026-10-20

## Why

A tenant who asks for "the invoice" could be sent a statement, which answers a
different question. A statement says what an account has done and changes every
time money moves. An invoice says what was charged on one date, for which home,
and what reference to quote when paying it — and it does not change afterwards.
ADR 0014 built sending; this builds the thing that is sent.

## What every design must carry

A landlord chooses from three designs. What they cannot choose is a layout that
has lost something, so each one carries, in a place a reader cannot miss:

1. **Who is charging** — registered name, trading name, registration and VAT
   numbers where they exist, an address and a contact.
2. **Which home** — property, unit and street address.
3. **What was charged** — line by line, with proration shown as the arithmetic
   (`20 of 31 days · full period R441.75`) rather than as a figure to take on
   trust.
4. **The amount and the due date.**
5. **The reference the tenant must quote** — which is the **lease reference**,
   because that is what `suggestAllocation` matches a bank line on. An invoice
   carrying a reference nobody reconciles is how a payment goes missing for a
   week.

`tests/unit/invoice-layout.test.ts` renders all three and reads the text back
out of the PDF. A design that drops one of those fails, and a design drawn off
the page fails with it — which is the fault a test on the input data cannot
see.

## The three designs

| | What it is | Chosen when |
| --- | --- | --- |
| **Classic** | Ruled and formal, like a statement | It will be read by an accountant, or filed with a tribunal |
| **Modern** | A band in the landlord's accent carrying their logo, with the amount set large | The brand matters and the ink does not |
| **Compact** | Everything on the top half of one page, smaller type | One rent line a month, read on a phone |

Three, not thirty: each was laid out and looked at. A fourth that nobody has
read is not a choice, it is a risk with a name.

## What it refuses to do

- **No VAT arithmetic.** `charge_lines` has no tax columns, so this document
  prints the VAT number where one is recorded and calculates nothing. A
  breakdown assembled from a rate nobody entered would be a number a landlord
  then files a return on.
- **No balance.** The invoice states what was charged on its issue date and
  says, on every design, that payments already made are on the statement. A
  figure on an invoice that drifts is worse than no invoice.
- **No full account number.** Where to pay is bank, holder, branch and the last
  four digits — the same as the portal. The full number stays behind
  `revealResidentAccountNumber`, which audits each disclosure; printing it on
  every emailed document would route around that control, and an invoice is the
  document most likely to be forwarded.
- **The lines are checked, not recomputed.** The posted total is what is owed.
  Where the lines disagree with it the document says so, in words, rather than
  quietly showing whichever figure looks tidier.
- **A draft is marked PRO FORMA** and says it is not a demand; a reversed
  invoice says a credit note cancelled it and not to pay it.
- **No attachment on the email.** The message carries `{{invoice.link}}`, which
  is read behind the tenant's own sign-in. An attachment naming what somebody
  owes sits in every mailbox it is forwarded to; a link is served to the person
  who can already see it, and is generated when they ask, so it is never a
  stale copy.

## Reading it as the person who owes it

A resident is a member of nothing. The document and its lines come through
their own additive select policies, which are anchored on the leases they hold.
Everything else — who the landlord is, where to pay — comes through
`security definer` functions that check the portal link first, so neither id in
the URL decides anything. Migration 0060 adds `app.resident_invoice_landlord`
for the business identity; it returns exactly the facts already printed on the
lease the tenant signed, and never the sealed identity number of a
natural-person landlord.

## Choosing one

Settings → Appearance → Invoice design, beside the accent and the logo, and
validated the same way: a key from the list reaches the database, never a
layout an administrator composed. Each option links to a **sample** rendered in
that organisation's own colours and logo, with invented figures, an invented
tenant and SAMPLE across its face — because picking a layout by showing
somebody a real tenant's debt would be using a person as a swatch, and a
specimen that can be mistaken for a demand is worse than no specimen.

Changing the design changes invoices generated from then on. A PDF somebody has
already downloaded is not rewritten, which is the correct behaviour for a
document and the reason this is generated on request rather than stored.
