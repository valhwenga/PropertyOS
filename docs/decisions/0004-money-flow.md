# ADR 0004 — Money flow and payment providers

**Status:** accepted · **Date:** 2026-10-03

## Decision

**PropertyOS does not hold, route or settle rent money.** The MVP records EFT
money received into the landlord's own designated bank account. There is no
escrow, no trust account and no pooled balance.

### Rent collection is disabled

`RENT_PAYMENT_PROVIDER_ENABLED=false`, and no provider integration is built.
It must not be enabled until the following are confirmed **in writing**:

1. who owns the merchant account;
2. where settlement lands, and on what timetable;
3. who holds the funds between collection and settlement;
4. the provider's terms for collecting on behalf of many unrelated owners;
5. refund, chargeback and failed-payment handling;
6. whether the arrangement requires registration under the Property
   Practitioners Act.

Record-keeping features do not make PropertyOS a licensed trust account, escrow
service or property practitioner.

### SaaS billing is a separate money flow

The `subscriptions` and `plans` tables are Spike's own revenue. No row in that
module ever posts to a customer financial book, and no customer journal ever
references a subscription.

### Fees never create fictitious arrears

`receipts.fee_minor` is recorded separately from `receipts.amount_minor`. A
resident who pays R8,000 with a R120 processing fee borne by the landlord has
paid R8,000 of rent. Settlement of R7,880 does not leave R120 of arrears.

### Browser redirects prove nothing

Payment state (`created`, `pending`, `confirmed`, `failed`, `cancelled`) is only
ever advanced to `confirmed` by verified funds. A redirect may display a pending
status; it never establishes success. Provider events are deduplicated by
`webhook_events (provider, provider_event_id)`.
