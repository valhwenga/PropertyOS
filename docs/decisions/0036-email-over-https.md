# 0036 — Email over HTTPS, through Resend

**Status:** accepted · 2026-10-29

## The problem

0035 made the notices correct: addressed to the right people, rendered with
real values, refused if a placeholder is unfilled, attempted by the worker on a
cadence. Every one of them still ended `development_sink`, because no provider
was configured — and the SMTP client, which is the only delivery path the
product had, cannot be configured where this product is developed. Outbound 587
and 465 are closed in the cloud environment: `smtp.resend.com:587`,
`smtp.postmarkapp.com:587` and `smtp.gmail.com:465` do not even resolve.

A mail path that cannot be exercised where the code is written is a mail path
nobody trusts, and the first time it runs will be the first time anybody finds
out whether it works.

## What we decided

**A second adapter, over HTTPS, behind the same interface.** Resend takes a
JSON `POST /emails` on 443, which goes through the same egress as everything
else. `EMAIL_PROVIDER=resend` with `RESEND_API_KEY` and `EMAIL_FROM`;
`EMAIL_PROVIDER=smtp` still works unchanged, for a provider without an HTTP API
or a self-hosted relay. Anything else is still the sink, and the sink's reason
now names what to set.

Dependency-free, like the SMTP client beside it. One endpoint, one recipient,
no SDK to track.

### `sent` still means accepted and traceable

A 2xx alone is not a send. `sent` is written only when Resend answered 2xx
**and** gave a message id, because half of "the provider took responsibility
and we can find the message again" is not enough to put in an audit trail. A
2xx we cannot read an id out of is recorded as a failure that is worth asking
again — which is safe, because of the next decision.

### An idempotency key, because the worker retries

The delivery pass tries an undelivered notice up to four times. Without a key,
a provider that accepted a message and then lost the connection would be asked
to send it again, and a resident would get four copies of a final notice.
Resend holds a key for 24 hours and returns the original response instead of
sending twice, so the key is the notification's own id: stable across retries,
unique per message. The invoice-message handler passes one too, for the same
reason.

### A rate limit is not a refusal

The default allowance is a couple of requests a second and a pass can hold
fifty messages. "Ask again shortly" — a 429, a 5xx, an unreachable host — is a
different fact from "this message is not acceptable", and recording the first
as the second would spend one of four attempts and eventually mark real mail as
failed. So `EmailOutcome` carries `retryAfterSeconds` on a failure, and
`recordNoticeDelivery` takes `keepQueued`: the notice stays `queued` with its
attempts intact, the reason is still recorded so the console says what
happened, and the pass stops rather than hammering a provider that just asked
it to slow down.

### Two ways to find out whether it works, before a customer does

`pnpm preflight --probe` asks Resend which domains are verified — a read,
nothing sent — and fails loudly if `EMAIL_FROM`'s domain is not among them,
which is the thing that actually stops a first send long after the key is
right. `pnpm email:test you@example.com` sends one real message and prints the
provider's own answer, including the message id. It exits non-zero when the
sink is in use, because somebody running it wants to know whether mail works
and "the sink took it" is not a yes.

## What this cost to get right

**Resend's own documentation is unreachable from here.** `api.resend.com` and
`resend.com` are both refused by this environment's network policy, so the
request and response shapes are written from what is publicly known of the API
rather than verified against the reference. That is why the adapter reads the
message id from either `id` or `data.id`, treats an unreadable success as a
retryable failure rather than assuming, and parses error bodies with every
field optional. The tests run a local server that answers in those shapes,
which is as close to the real thing as this environment allows — **the first
live send is still the first live send**, and `pnpm email:test` exists for
exactly that moment.

## What this does not do

**Nothing is delivered until somebody configures it.** The key, the verified
domain, and the SPF/DKIM/DMARC records are a purchase and a DNS change. This
decision removes the code excuse, not the setup.

**No HTML part, no attachments.** Messages are plain text and link to the
portal; the invoice PDF is a link by deliberate decision in 0014. Resend
supports both, and neither is wired.

**No reply-to, no bounce handling, no unsubscribe.** A resident who replies
writes to `no-reply@`. Resend reports bounces and complaints by webhook and
nothing here listens, so a dead address stays on a lease being reminded
forever. Both are written down in `docs/known-limitations.md` rather than
half-built.

**And nothing throttles proactively.** The pass reacts to a 429 rather than
pacing itself under the provider's documented rate. That is the right order —
reacting is correct whatever the limit turns out to be — but a large backlog
will spend a few passes discovering it.
