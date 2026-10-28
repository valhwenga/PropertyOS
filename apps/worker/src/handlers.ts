import { resolveEmailAdapter } from '@propertyos/integrations';
import type { Job, Sql } from './queue';

export type Handler = (sql: Sql, job: Job) => Promise<void>;

const email = resolveEmailAdapter();

/**
 * Turns a domain event into a notification.
 *
 * Idempotent: the notification row is keyed on the outbox id, so a redelivered
 * event updates the same row instead of sending a second message.
 *
 * Honesty rule: the row's status is whatever the adapter actually returned.
 * When no provider is configured the status is `development_sink` and the UI
 * says the message was not delivered. Nothing here ever writes `sent` on the
 * strength of having tried.
 */
/**
 * Which events become a notice, and under which template.
 *
 * A map rather than a ladder of ternaries, because the registry at the bottom
 * of this file has to cover every event type the domain can emit and the two
 * lists are read together.
 */
const NOTIFICATION_TEMPLATES: Record<string, string> = {
  'receipt.allocated': 'statement.issued',
  'payment.evidence.submitted': 'payment.evidence.received',
  'maintenance.ticket.created': 'maintenance.ticket.created',
  // Support access: the customer has to approve a session before it reaches
  // anything, and a request sitting on a screen nobody opened is a request
  // nobody answers.
  'platform.support_session.requested': 'support.access.requested',
  'platform.support_session.opened': 'support.access.opened',
};

const notify: Handler = async (sql, job) => {
  const outboxId = String(job.payload.outboxId);
  const eventType = String(job.payload.eventType);

  const templateKey = NOTIFICATION_TEMPLATES[eventType] ?? null;
  if (!templateKey) return; // Not every event has a notification.

  const [template] = await sql<{ channel: string; subject: string | null; body: string }[]>`
    select channel, subject, body from notification_templates where key = ${templateKey}
  `;
  if (!template) return;

  const [existing] = await sql<{ id: string }[]>`
    select id from notifications
    where organisation_id = ${job.organisationId}
      and provider_message_id = ${`outbox-${outboxId}`}
  `;
  if (existing) return; // Already handled: at-least-once delivery, exactly-once effect.

  // There is no recipient resolution for these events yet, and there was no
  // recipient: this handler sent every one of them to `resident@example.invalid`
  // with the template's raw body. Against the sink that was invisible; with
  // SMTP configured it would have mailed a fabricated address and recorded it
  // as delivered.
  //
  // So it no longer sends. The notice is recorded as queued, with the reason on
  // it, which is both true and visible: undelivered notifications are one of
  // the conditions `app.platform_alert_conditions()` raises, so a backlog of
  // these now tells somebody instead of sitting in a table.
  const outcome =
    template.channel === 'email'
      ? ({
          status: 'queued',
          provider: null,
          reason: 'No recipient resolution for this event yet: nothing was sent. '
            + 'The notice is recorded so the message is not lost.',
        } as const)
      : ({ status: 'sent', provider: 'in_app', providerMessageId: `outbox-${outboxId}` } as const);

  await sql`
    insert into notifications (
      organisation_id, template_key, channel, subject, body, status, provider,
      provider_message_id, attempts, last_error, sent_at
    ) values (
      ${job.organisationId}, ${templateKey}, ${template.channel},
      ${template.subject}, ${template.body},
      ${outcome.status},
      ${outcome.provider},
      ${`outbox-${outboxId}`},
      1,
      ${'reason' in outcome ? outcome.reason : null},
      ${outcome.status === 'sent' ? sql`now()` : null}
    )
  `;

  // Nothing throws here any more. The old code failed the job when delivery
  // failed, which was right when it was delivering; a job that fails because
  // this product has no recipient resolution would die in the queue every time
  // and tell an operator nothing they can act on.
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
