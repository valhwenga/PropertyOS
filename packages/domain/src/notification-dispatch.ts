import type { Sql } from '@propertyos/db';
import { invalid } from './errors';
import { formatMoney } from './money';

/**
 * Turning an event into a notice somebody can actually read.
 *
 * The worker has had a `notify` handler since 0006 and it has never told a
 * single person anything. It wrote the template's own text — placeholders and
 * all — into `notifications` with no `recipient_user_id`, and recorded it as
 * `sent`. The inbox reads by recipient, so those rows were unreachable; the
 * body would have read "Maintenance request {{reference}} has been logged".
 * Migration 0087 makes both states impossible in the schema. This module is
 * what writes the rows that satisfy it.
 *
 * Three rules, in the order they matter:
 *
 *   1. **A notice has a reader.** The audience is resolved from the event, and
 *      where there is nobody who could read it, nothing is written and the
 *      reason is returned. A row addressed to nobody is not a message.
 *   2. **An unresolved placeholder is a refusal.** `renderNotice` throws
 *      naming every variable it was not given, rather than sending somebody
 *      `{{amount}}`.
 *   3. **Sent means a provider said so.** Nothing here writes `sent` for an
 *      email. In-app notices are `sent` the moment they are written, because
 *      for that channel writing the row IS the delivery — the person reads it
 *      in their own inbox.
 */

/** A person who can read a notice, and how to reach them. */
export interface NoticeRecipient {
  authUserId: string | null;
  email: string | null;
  residentId: string | null;
}

export interface DispatchEvent {
  organisationId: string;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  payload: Record<string, unknown>;
  /** Used as the idempotency key, so a redelivered event writes one notice. */
  outboxId: string;
}

export interface DispatchOutcome {
  /** How many notices were written. */
  posted: number;
  /** Why nothing was written, where nothing was. */
  skipped: string | null;
  templateKey: string | null;
}

/**
 * Which template an event uses.
 *
 * `receipt.allocated` used to borrow `statement.issued`, so applying a payment
 * to somebody's account would have told them their statement was ready for a
 * period nobody had run. It has its own wording in 0087.
 */
const TEMPLATES: Record<string, string> = {
  'receipt.allocated': 'receipt.allocated',
  'payment.evidence.submitted': 'payment.evidence.received',
  'maintenance.ticket.created': 'maintenance.ticket.created',
  'platform.support_session.requested': 'support.access.requested',
  'platform.support_session.opened': 'support.access.opened',
};

/**
 * Substitutes `{{name}}` and refuses to leave one behind.
 *
 * The refusal is the point. A message with a placeholder in it tells the
 * person reading it that nobody was looking, and it is the kind of mistake
 * that survives a code review and arrives in somebody's inbox.
 */
export function renderNotice(
  text: string,
  variables: Record<string, string>,
): string {
  const rendered = text.replace(/\{\{([a-z_]+)\}\}/g, (_match, name: string) => {
    const value = variables[name];
    return value === undefined || value === '' ? `{{${name}}}` : value;
  });
  const missing = [...rendered.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]!);
  if (missing.length > 0) {
    throw invalid(
      `This notice cannot be sent: nothing supplied ${[...new Set(missing)].join(', ')}.`,
    );
  }
  return rendered;
}

/** Everyone in the organisation who runs it, for notices about the account. */
async function peopleWhoRunIt(tx: Sql, organisationId: string): Promise<NoticeRecipient[]> {
  const rows = await tx<{ auth_user_id: string; email: string }[]>`
    select distinct m.auth_user_id::text, u.email::text
      from memberships m
      join auth.users u on u.id = m.auth_user_id
      join membership_roles mr on mr.membership_id = m.id
      join role_permissions rp on rp.role_key = mr.role_key
     where m.organisation_id = ${organisationId}::uuid
       and m.status = 'active'
       and rp.permission_key = 'organisation.settings.manage'
       and u.email not like 'destroyed-%@invalid'
  `;
  return rows.map((r) => ({ authUserId: r.auth_user_id, email: r.email, residentId: null }));
}

/**
 * The residents on a lease who can actually read an in-app notice.
 *
 * A resident with no live portal link has no inbox: the notice would be a
 * row no person could reach, which 0087 forbids. They are not silently
 * dropped — the dispatcher returns that as the reason, the worker logs it, and
 * `docs/known-limitations.md` says plainly that the product cannot tell a
 * resident without portal access anything.
 */
async function residentsOnLease(tx: Sql, leaseId: string): Promise<NoticeRecipient[]> {
  const rows = await tx<{ auth_user_id: string; resident_id: string; email: string | null }[]>`
    select pl.auth_user_id::text, pl.resident_id::text, u.email::text
      from portal_links pl
      join auth.users u on u.id = pl.auth_user_id
     where pl.lease_id = ${leaseId}::uuid
       and pl.status = 'active'
       and pl.revoked_at is null
       and (pl.expires_at is null or pl.expires_at > now())
       and pl.auth_user_id is not null
  `;
  return rows.map((r) => ({
    authUserId: r.auth_user_id, email: r.email, residentId: r.resident_id,
  }));
}

interface Resolved {
  recipients: NoticeRecipient[];
  variables: Record<string, string>;
  title: string;
  linkPath: string | null;
  /** Set when there is nobody to tell, and why. */
  nobody: string | null;
}

async function resolve(tx: Sql, event: DispatchEvent): Promise<Resolved> {
  const nothing = (why: string): Resolved => ({
    recipients: [], variables: {}, title: '', linkPath: null, nobody: why,
  });

  switch (event.eventType) {
    case 'receipt.allocated': {
      if (!event.resourceId) return nothing('the event names no receipt');
      const [receipt] = await tx<{ lease_id: string | null; currency_code: string }[]>`
        select lease_id::text, currency_code from receipts
         where id = ${event.resourceId}::uuid
      `;
      if (!receipt?.lease_id) {
        // A receipt in suspense belongs to no tenancy yet, so there is nobody
        // it is about. Allocating it later is its own event.
        return nothing('the receipt is not against a lease');
      }
      const recipients = await residentsOnLease(tx, receipt.lease_id);
      if (recipients.length === 0) return nothing('no resident on the lease has portal access');
      const minor = Number(event.payload.allocatedMinor ?? 0);
      return {
        recipients,
        variables: { amount: formatMoney(minor, receipt.currency_code) },
        title: 'A payment was applied to your account',
        linkPath: `/portal/${receipt.lease_id}/statement`,
        nobody: null,
      };
    }

    case 'payment.evidence.submitted': {
      const leaseId = typeof event.payload.leaseId === 'string' ? event.payload.leaseId : null;
      if (!leaseId) return nothing('the event names no lease');
      const recipients = await residentsOnLease(tx, leaseId);
      if (recipients.length === 0) return nothing('no resident on the lease has portal access');
      const minor = Number(event.payload.claimedAmountMinor ?? 0);
      return {
        recipients,
        variables: { amount: formatMoney(minor, 'ZAR') },
        title: 'Proof of payment received',
        linkPath: `/portal/${leaseId}/payments`,
        nobody: null,
      };
    }

    case 'maintenance.ticket.created': {
      if (!event.resourceId) return nothing('the event names no ticket');
      const [ticket] = await tx<{ lease_id: string | null; reference: string }[]>`
        select lease_id::text, reference from maintenance_tickets
         where id = ${event.resourceId}::uuid
      `;
      if (!ticket) return nothing('the ticket could not be read');
      if (!ticket.lease_id) {
        // Raised by staff against a unit rather than a tenancy: there is no
        // resident whose request it is.
        return nothing('the ticket is not against a lease');
      }
      const recipients = await residentsOnLease(tx, ticket.lease_id);
      if (recipients.length === 0) return nothing('no resident on the lease has portal access');
      return {
        recipients,
        variables: { reference: ticket.reference },
        title: `Maintenance request ${ticket.reference}`,
        linkPath: `/portal/${ticket.lease_id}/requests/${event.resourceId}`,
        nobody: null,
      };
    }

    case 'platform.support_session.requested':
    case 'platform.support_session.opened': {
      const recipients = await peopleWhoRunIt(tx, event.organisationId);
      if (recipients.length === 0) {
        return nothing('nobody in the organisation holds organisation.settings.manage');
      }
      const [organisation] = await tx<{ slug: string }[]>`
        select slug from organisations where id = ${event.organisationId}::uuid
      `;
      return {
        recipients,
        variables: {},
        title: event.eventType.endsWith('requested')
          ? 'Spike support is asking to read your records'
          : 'Spike support opened your account',
        linkPath: organisation ? `/app/${organisation.slug}/settings/support-access` : null,
        nobody: null,
      };
    }

    default:
      return nothing(`no audience is defined for ${event.eventType}`);
  }
}

/**
 * Writes the notices one event is due.
 *
 * Idempotent on `provider_message_id = outbox-<id>`: at-least-once delivery
 * must not produce two copies of the same message, and the worker redelivers.
 *
 * Runs on the worker's connection, which has no session and no RLS — the
 * audience is resolved explicitly here instead, which is why every branch
 * above names the tenancy or the organisation it reads.
 */
export async function dispatchEventNotice(
  tx: Sql,
  event: DispatchEvent,
): Promise<DispatchOutcome> {
  const templateKey = TEMPLATES[event.eventType] ?? null;
  if (!templateKey) return { posted: 0, skipped: null, templateKey: null };

  const [template] = await tx<{ channel: string; subject: string | null; body: string }[]>`
    select channel, subject, body from notification_templates where key = ${templateKey}
  `;
  if (!template) {
    return { posted: 0, skipped: `no template named ${templateKey}`, templateKey };
  }

  const key = `outbox-${event.outboxId}`;

  const resolved = await resolve(tx, event);
  if (resolved.nobody) return { posted: 0, skipped: resolved.nobody, templateKey };

  const subject = renderNotice(template.subject ?? resolved.title, resolved.variables);
  const body = renderNotice(template.body, resolved.variables);
  const title = renderNotice(resolved.title, resolved.variables);

  let posted = 0;
  for (const recipient of resolved.recipients) {
    // An in-app notice is delivered by being written: the person reads it in
    // their own inbox. An email notice is queued, and `sent` is written only
    // by the delivery pass, only when a provider acknowledges it.
    const inApp = template.channel === 'in_app';
    if (inApp && !recipient.authUserId) continue;
    if (!inApp && !recipient.email) continue;

    // `on conflict do nothing` rather than a look-before-insert: the worker
    // can redeliver an event into two passes at once, and the unique index is
    // the only thing that holds under that.
    const written = await tx<{ id: string }[]>`
      insert into notifications (
        organisation_id, template_key, channel, recipient_user_id, recipient_email,
        recipient_resident_id, title, subject, body, link_path, status, provider,
        dedupe_key, sent_at
      ) values (
        ${event.organisationId}::uuid, ${templateKey}, ${template.channel},
        ${recipient.authUserId}::uuid, ${inApp ? null : recipient.email},
        ${recipient.residentId}::uuid, ${title}, ${subject}, ${body},
        ${resolved.linkPath},
        ${inApp ? 'sent' : 'queued'}, ${inApp ? 'in_app' : null},
        ${`${key}:${recipient.authUserId ?? recipient.email}`},
        ${inApp ? tx`now()` : null}
      )
      on conflict (organisation_id, dedupe_key) do nothing
      returning id::text
    `;
    if (written.length > 0) posted += 1;
  }

  return {
    posted,
    // Nothing written with recipients resolved means every one of them was
    // already told: a redelivery, which is the common case and not a problem.
    skipped: posted === 0 && resolved.recipients.length === 0
      ? 'no recipient could be reached on this channel'
      : null,
    templateKey,
  };
}

export interface QueuedNotice {
  id: string;
  organisationId: string;
  templateKey: string | null;
  recipientEmail: string;
  subject: string;
  body: string;
  attempts: number;
}

/**
 * Email notices nobody has delivered yet.
 *
 * Capped, and oldest first, so one pass cannot spend an hour on a backlog and
 * starve everything else the worker does. `attempts` caps the retries: a
 * message the provider has refused four times is not going to be accepted on
 * the fifth, and a loop that keeps trying forever is a loop nobody reads the
 * errors from.
 */
export async function noticesAwaitingDelivery(
  tx: Sql,
  options: { limit?: number; maxAttempts?: number } = {},
): Promise<QueuedNotice[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const maxAttempts = options.maxAttempts ?? 4;
  const rows = await tx<{
    id: string; organisation_id: string; template_key: string | null;
    recipient_email: string; subject: string | null; body: string; attempts: number;
  }[]>`
    select id::text, organisation_id::text, template_key, recipient_email::text,
           subject, body, attempts
      from notifications
     where channel = 'email' and status = 'queued'
       and recipient_email is not null
       and attempts < ${maxAttempts}
     order by created_at
     limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    organisationId: r.organisation_id,
    templateKey: r.template_key,
    recipientEmail: r.recipient_email,
    subject: r.subject ?? 'A message from your landlord',
    body: r.body,
    attempts: r.attempts,
  }));
}

/**
 * Records what the adapter said about one notice.
 *
 * The vocabulary is the adapter's, unchanged: `sent` only for a provider
 * acknowledgement, `development_sink` for the sink's honest refusal, `failed`
 * with the provider's own words. Nothing collapses the three, because the
 * middle one is the state this product is actually in.
 */
export async function recordNoticeDelivery(
  tx: Sql,
  params: {
    notificationId: string;
    status: 'sent' | 'development_sink' | 'failed';
    provider: string;
    providerMessageId?: string | null;
    detail: string | null;
  },
): Promise<void> {
  await tx`
    update notifications
       set status = ${params.status},
           provider = ${params.provider},
           provider_message_id = ${params.providerMessageId ?? null},
           attempts = attempts + 1,
           last_error = ${params.status === 'sent' ? null : params.detail},
           sent_at = ${params.status === 'sent' ? tx`now()` : null}
     where id = ${params.notificationId}::uuid
  `;
}
