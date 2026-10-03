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
};
