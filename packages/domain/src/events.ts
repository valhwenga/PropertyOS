/**
 * Every event this product puts in the outbox.
 *
 * A closed list, and typed, because the open one cost real reliability: the
 * worker looks up `event:<type>` in its handler registry, a type nobody
 * registered has no handler, and a job with no handler is retried with backoff
 * and then marked **dead**. So emitting an event the worker had never heard of
 * turned a successful business action — issuing a portal invitation,
 * finalising an inspection, suspending a customer — into a permanently failed
 * job and a red "needs an operator to inspect" figure on the platform console.
 *
 * Five types were in that state, and three of them had been added hours
 * earlier by the work that introduced them. Nothing failed loudly enough to
 * notice, which is exactly why this is a type rather than a convention:
 * `emitEvent` now takes only these, so a new event that nobody has registered
 * is a compile error, and `tests/unit/outbox-handlers.test.ts` fails if the
 * registry does not cover every one of them.
 */
export const OUTBOX_EVENT_TYPES = [
  'charge.posted',
  'billing_run.posted',
  'receipt.confirmed',
  'receipt.allocated',
  'payment.evidence.submitted',
  'invoice.message.queued',
  'lease.activated',
  'lease.expired',
  'lease.renewed',
  'organisation.created',
  'portal.invitation.issued',
  'inspection.finalised',
  'maintenance.ticket.created',
  'maintenance.work_order.issued',
  'platform.account.status_changed',
  'platform.support_session.requested',
  'platform.support_session.opened',
  'support.session.approved',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
