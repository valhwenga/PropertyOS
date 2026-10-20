# ADR 0014 — Sending an invoice is not an accounting act

**Status:** accepted · **Date:** 2026-10-20

## Why

The product could raise a month's invoices and could not send one. A billing
run posted charge documents to the ledger, and from there a resident could only
find them by signing into the portal and looking — which assumes they knew
there was something to look at.

## The distinction everything here rests on

An invoice has two states that are about different things, and conflating them
would be the kind of mistake that is discovered by a resident.

| | What it says | Where it lives |
| --- | --- | --- |
| `charge_documents.status` | draft → posted → reversed. Whether the money is in the books. | The accounting record, immutable once posted |
| Delivery | Whether anybody told the resident. Changes repeatedly, can fail, can be retried. | `invoice_deliveries`, its own table |

So delivery never touches the posted document, and sending moves no money,
marks nothing paid and alters no balance. A row in `invoice_deliveries` exists
only once an operator has said the invoice should go out; no row is the honest
reading of "nobody has decided yet".

## The rules

1. **Only a posted invoice can be sent.** A draft is not in anyone's books and
   can still change; emailing one invites payment against a figure that does
   not exist yet. The command refuses, naming the documents.
2. **"Sent" means a provider acknowledged it.** Nothing writes `sent` for
   having tried. This deployment has no provider, so the honest outcome is
   `undelivered` with the sink's reason in words, and the screen shows that
   rather than a tick. A database check constraint enforces the other half:
   `sent` cannot exist without the moment it happened.
3. **A resident with no email address is suppressed, visibly.** Not skipped,
   not counted. The operator sees who was not reached and why, because they
   are the one who can fix it.
4. **An undelivered invoice can be sent again.** That is the point of recording
   the reason; the row offers "Try again" once the cause is addressed.
5. **The message is rendered when it is queued, not when it is sent.** A
   template edited in the meantime cannot change what somebody receives after
   an operator approved it.

## The wording belongs to the landlord

`organisation_message_templates` holds one message per organisation, with
`{{merge.fields}}` the product fills in — the invoice number, the period, the
amount, the due date, the portal link. Every field is a fact already on the
invoice, so a message cannot assert something the ledger does not. A field the
product does not define is refused at save time rather than sent with the
braces showing, which is what tells a resident nobody checked.

Until a landlord writes their own, the product's default is used. It lives in
the domain rather than being seeded, so improving it never overwrites somebody's
edits.

## Deliberately not done

- **No attachment.** The message carries the figures and a link to the
  resident's own statement, which stays correct as payments arrive. A PDF
  attached today is wrong by next week.
- **Only the primary resident is emailed.** A co-lessee with portal access sees
  the same invoice there; two emails about one debt invites two payments.
- **No reminders, no dunning, no schedule.** Sending is something a person
  decides to do, this month, having looked at the list.

## What this does not fix

Nothing is actually delivered until an email provider is configured — M5 in
`docs/MVP-RECONCILIATION.md`, which needs a purchase and a DNS change. Every
screen here says so in those words. What is built is everything up to the
provider: the state, the wording, the queue, the worker and the record of what
came back.
