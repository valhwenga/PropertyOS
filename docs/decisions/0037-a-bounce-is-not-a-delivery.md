# 0037 — A bounce is not a delivery

**Status:** accepted · 2026-10-29

## The problem

0035 made the notices correct and 0036 gave them a provider. Both stopped at
the same place: the provider says "accepted", the product records `sent`, and
that is the last thing it ever learns about the message.

Acceptance is not arrival. The mailbox may not exist, may be full, or the
recipient may mark the message as spam, and all of that arrives afterwards — by
webhook, at an endpoint that did not exist. So a resident who moved out two
years ago is still sent a rent reminder every month, the product still records
it as sent, and the one person who could fix it, the landlord who has their
phone number, is never told.

In the aggregate it is worse than a missed message. Mail to dead addresses is
how a sending domain's reputation is destroyed, and the reputation is shared by
every customer on it: one stale tenancy list degrades delivery for everybody.

## What we decided

### The endpoint trusts nothing

`POST /api/email/resend/events`, the same shape as the payment notification
endpoint and for the same reasons. It reads the **raw body** before anything
else, because the signature is over the bytes and re-serialising parsed JSON
changes key order and whitespace. An event it cannot verify is recorded with
`signature_verified = false` and changes nothing — which is the whole
protection, because otherwise anybody who can post to the URL could mark a
landlord's own address undeliverable and silence their rent reminders.

Signatures are the Svix scheme: HMAC-SHA256 over `<id>.<timestamp>.<body>`,
compared in constant time, against every `v1,` signature offered (a secret
mid-rotation signs with two). A timestamp more than five minutes out is refused
as a replay. **No secret configured is a refusal, not a pass.**

It answers 200 to anything it has recorded, including rubbish: a non-2xx tells
a provider to retry, and a forged request must not be able to make the endpoint
retry-storm itself. Deduplication is `webhook_events (provider,
provider_event_id)`, in the schema since 0004.

### A bounce does not rewrite the send

`status` stays `sent` and `bounced_at`, `complained_at`, `bounce_kind` and the
provider's own words go beside it. The message *was* accepted — that is a true
record, and "accepted and then bounced" says more than "failed".
`delivered_at` is separate from `sent_at` for the same reason: one is when our
provider took it, the other is when the receiving server did, and only the
second means it arrived.

### Only the permanent kinds stop us

A hard bounce, a blocked sender or a complaint suppresses the address. A **soft**
bounce does not: a full mailbox on a Friday is not a dead address, and stopping
a landlord's mail over a weekend because of one is worse than the bounce.

### The suppression list is global, and no customer may read it

A sending reputation is a property of the address and the domain, not of
whichever customer's resident it happens to be — so the list is keyed on the
address alone. Which is exactly why `email_suppressions` has no customer select
policy: an address can belong to residents of two landlords, and one landlord
does not get to learn that a person complained about another's mail.

What a customer may see is the generalised answer, through one narrow definer
function scoped to addresses on **their own** residents: a complaint reads as
"asked not to receive", which is true, actionable and names nobody. Scoping it
to their own residents also stops the function being an oracle — an arbitrary
address cannot be tested through it to ask whether a stranger has ever
complained.

### Lifting is recorded, not deleted

Somebody will ask: the landlord says the mailbox is fixed, the complaint was a
misclick. Lifting takes a person, a reason of at least five characters (checked
in the schema) and leaves the row as history, because "we started sending there
again because the landlord said it was fine" is the answer a postmaster wants
when the reputation question comes round. It resends nothing: a three-month-old
rent reminder going out because an address came back is not what anybody meant.

### And somebody is told

A twelfth alert condition on addresses that started bouncing **this week**,
with a threshold. Recent rather than total, because a list that grew to two
hundred over three years is housekeeping and twelve this week is somebody
importing a stale tenancy list. The operator console groups the live
suppressions with the provider's own words on each, because "mailbox does not
exist" is an answer to a landlord on the phone and "delivery failed" is not.

## What this cost to get right

**The definer function checked a permission that does not exist.** It asked for
`residents.read`; the permission is `resident.read`. RLS and permission checks
fail closed, so the function silently returned nothing for everybody — a
landlord would simply never have been told. Caught by the test that asserts a
landlord *is* told, which is the only kind of test that catches it.

## What this does not do

**It cannot be exercised against Resend from here.** The network policy refuses
`api.resend.com` and `resend.com`, so the event shapes are read from public
knowledge and the parser degrades unknown shapes to "no action" rather than
throwing. The signature scheme, the raw-body handling and the whole ingest path
were exercised over real HTTP against the running preview, with a signed event
and a forged one.

**Nothing retries a soft bounce differently.** It is recorded and the message
keeps whatever delivery attempts it had. A product that backed off and tried a
full mailbox again in six hours would be better, and needs a schedule this does
not have.

**A resident's own portal notices are unaffected.** They are in-app and do not
go through a provider; a dead email address does not stop them.

**There is still no reply-to and no unsubscribe.** A resident who replies writes
to `no-reply@`. Defensible while every message is transactional and not a day
longer.
