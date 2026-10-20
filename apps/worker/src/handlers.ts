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
const notify: Handler = async (sql, job) => {
  const outboxId = String(job.payload.outboxId);
  const eventType = String(job.payload.eventType);

  const templateKey =
    eventType === 'receipt.allocated' ? 'statement.issued'
    : eventType === 'payment.evidence.submitted' ? 'payment.evidence.received'
    : eventType === 'maintenance.ticket.created' ? 'maintenance.ticket.created'
    : null;
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

  const outcome =
    template.channel === 'email'
      ? await email.send({
          to: 'resident@example.invalid',
          subject: template.subject ?? 'PropertyOS',
          body: template.body,
          templateKey,
        })
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
      ${outcome.status === 'failed' ? outcome.error
        : outcome.status === 'development_sink' ? outcome.reason : null},
      ${outcome.status === 'sent' ? sql`now()` : null}
    )
  `;

  if (outcome.status === 'failed') {
    // Surfaced as a retry; a persistent failure lands in the dead queue where an
    // operator can see it. The notice record is never erased.
    throw new Error(`Email delivery failed: ${outcome.error}`);
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
const auditOnly: Handler = async () => {};

export const HANDLERS: Record<string, Handler> = {
  'event:charge.posted': auditOnly,
  'event:receipt.confirmed': auditOnly,
  'event:receipt.allocated': notify,
  'event:lease.activated': auditOnly,
  'event:billing_run.posted': auditOnly,
  'event:organisation.created': auditOnly,
  'event:payment.evidence.submitted': notify,
  'event:maintenance.ticket.created': notify,
  'event:invoice.message.queued': sendInvoiceMessage,
};
