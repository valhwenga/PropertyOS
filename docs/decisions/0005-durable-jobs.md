# ADR 0005 — Durable jobs and the transactional outbox

**Status:** accepted · **Date:** 2026-10-03

## Decision

Business changes and their events commit **together**. `emitEvent` writes an
`outbox_events` row inside the same transaction as the charge, receipt or
allocation it describes.

Consequences of that single choice:

* An event can never describe a transaction that rolled back.
* An event can never be lost because the process died before "sending" it.
* The worker publishes the outbox into `jobs` with
  `idempotency_key = 'outbox-<id>'`, so republishing creates one job, not two.

Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so several workers run
concurrently without ever processing the same job twice. Failures retry with
exponential backoff capped at one hour; on exhausting `max_attempts` a job moves
to `dead` — an inspectable poison queue, never a silent discard. Every attempt is
recorded in `job_attempts`.

A worker that dies mid-job leaves the row `running`; `reclaimStalled` returns it
to the queue after a 15-minute lease, so a container restart strands nothing.

Delivery is **at least once**. Handlers must therefore be idempotent, and the
notification handler keys on the outbox id so a redelivered event cannot send a
second message. We do not claim exactly-once delivery; we achieve exactly-once
*effect* through database uniqueness and transaction boundaries.
