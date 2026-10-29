import { dispatchEventNotice } from '@propertyos/domain';
import { resolveEmailAdapter } from '@propertyos/integrations';
import { log } from './logger';
import type { Job, Sql } from './queue';

export type Handler = (sql: Sql, job: Job) => Promise<void>;

const email = resolveEmailAdapter();

/**
 * Turns a domain event into a notice somebody can read.
 *
 * It used to turn one into a row nobody could. The notice was written with no
 * `recipient_user_id`, which the inbox reads by, and with the template's own
 * text — so the body said `{{reference}}` — and then recorded as **sent**. Not
 * queued, not undelivered: sent, which every screen and every alert believed.
 *
 * Both are now impossible in the schema (0087), and the work of satisfying it
 * — who should be told, what the message actually says — is
 * `dispatchEventNotice` in the domain, where it can be tested without a
 * worker. This handler is the thin part: hand it the event, log what came of
 * it.
 *
 * It still does not throw. A notice with no audience is a fact about this
 * product (a resident without portal access cannot be told anything by it),
 * not a job failure to be retried until it dies.
 */
const notify: Handler = async (sql, job) => {
  // Every notice belongs to a customer. A job with no organisation is a
  // platform job, and none of them notify anybody here.
  if (!job.organisationId) return;

  // The outbox publisher spreads the event's own payload over these three
  // fields, so the whole job payload IS the event's variables.
  const outcome = await dispatchEventNotice(sql as never, {
    organisationId: job.organisationId,
    eventType: String(job.payload.eventType),
    resourceType: String(job.payload.resourceType ?? ''),
    resourceId: job.payload.resourceId ? String(job.payload.resourceId) : null,
    payload: job.payload as Record<string, unknown>,
    outboxId: String(job.payload.outboxId),
  });

  if (outcome.skipped) {
    log('info', 'notice not written', {
      eventType: job.payload.eventType, template: outcome.templateKey, reason: outcome.skipped,
    });
  }
};

/**
 * Sends one invoice message, and records what actually happened.
 *
 * The message was written when the operator queued it, so this does not
 * re-render anything: a template edited in the meantime cannot change what a
 * resident receives after somebody approved it.
 *
 * The honesty rule again, and it matters most here because a landlord is about
 * to tell a resident they owe money: `sent` is written only when the adapter
 * reports a provider acknowledgement. With no provider configured the delivery
 * is `undelivered` with the sink's reason, and the invoice screen says so in
 * those words rather than showing a tick.
 */
const sendInvoiceMessage: Handler = async (sql, job) => {
  const notificationId = String(job.payload.notificationId);
  const documentId = String(job.payload.documentId);

  const [message] = await sql<
    { id: string; recipient_email: string | null; subject: string | null; body: string;
      status: string }[]
  >`
    select id, recipient_email::text, subject, body, status
      from notifications
     where id = ${notificationId} and organisation_id = ${job.organisationId}
  `;
  if (!message) return;
  // At-least-once delivery, exactly-once effect: a redelivered event must not
  // send a second copy of the same invoice.
  if (message.status !== 'queued') return;
  if (!message.recipient_email) return;

  const outcome = await email.send({
    to: message.recipient_email,
    subject: message.subject ?? 'Your invoice',
    body: message.body,
    templateKey: 'invoice.issued',
    // A redelivered job must not send a second invoice. The status check above
    // catches the ordinary case; this catches the one where the provider
    // accepted the message and the connection died before we recorded it.
    idempotencyKey: notificationId,
  });

  const detail = outcome.status === 'sent'
    ? `Accepted by ${outcome.provider}.`
    : outcome.status === 'development_sink'
      ? outcome.reason
      : outcome.error;

  await sql.begin(async (tx) => {
    await tx`
      update notifications
         set status = ${outcome.status},
             provider = ${outcome.provider},
             provider_message_id = ${outcome.status === 'sent' ? outcome.providerMessageId : null},
             attempts = attempts + 1,
             last_error = ${outcome.status === 'sent' ? null : detail},
             sent_at = ${outcome.status === 'sent' ? tx`now()` : null}
       where id = ${notificationId} and organisation_id = ${job.organisationId}
    `;
    await tx`
      update invoice_deliveries
         set state = ${outcome.status === 'sent' ? 'sent' : 'undelivered'},
             sent_at = ${outcome.status === 'sent' ? tx`now()` : null},
             last_attempt_at = now(),
             outcome_detail = ${detail}
       where document_id = ${documentId} and organisation_id = ${job.organisationId}
    `;
  });

  if (outcome.status === 'failed') {
    // A provider that refused is worth retrying; the record above already says
    // the resident has not been told.
    throw new Error(`Invoice message delivery failed: ${outcome.error}`);
  }
};

/** Recomputes nothing; it only records that an event was observed. */
/**
 * The event happened, the outbox row is the record, and nothing else is due.
 *
 * Registered explicitly rather than left out. An unregistered type has no
 * handler, a job with no handler is retried and then marked **dead**, and the
 * platform console counts dead jobs as "needs an operator to inspect" — so
 * leaving an event out does not mean "nothing happens", it means a red figure
 * and a stranger's afternoon. Five types were in exactly that state before
 * this was written.
 */
const auditOnly: Handler = async () => {};

/**
 * Every event type the domain can emit, and what the worker does with it.
 *
 * `tests/unit/outbox-handlers.test.ts` fails if this does not cover
 * `OUTBOX_EVENT_TYPES`, which is a closed union in the domain — so a new event
 * cannot be added without a decision being made here about what it does.
 */
export const HANDLERS: Record<string, Handler> = {
  'event:charge.posted': auditOnly,
  'event:billing_run.posted': auditOnly,
  'event:receipt.confirmed': auditOnly,
  'event:receipt.allocated': notify,
  'event:payment.evidence.submitted': notify,
  'event:invoice.message.queued': sendInvoiceMessage,

  'event:lease.activated': auditOnly,
  // The lease list and the expiry report read the lease's own status, so the
  // transition is the whole of the effect; nothing is sent.
  'event:lease.expired': auditOnly,
  'event:lease.renewed': auditOnly,
  'event:organisation.created': auditOnly,

  // The link is handed over by the person who issued it — no email is sent and
  // none is claimed anywhere — so there is nothing for the worker to do.
  'event:portal.invitation.issued': auditOnly,
  'event:inspection.finalised': auditOnly,
  'event:maintenance.ticket.created': notify,
  // Deliberately silent for now: the resident sees the appointment and the
  // contractor on their portal, and a notice would need a template naming a
  // person who may not have portal access.
  'event:maintenance.work_order.issued': auditOnly,

  // Spike's own actions. The customer sees a suspension the moment they try to
  // open the console, and an approval is their own click.
  'event:platform.account.status_changed': auditOnly,
  'event:platform.support_session.requested': notify,
  'event:platform.support_session.opened': notify,
  'event:support.session.approved': auditOnly,
};
