/**
 * The in-app inbox.
 *
 * A notice is a record of something that happened, addressed to a person. It is
 * never the event itself: marking one read changes nothing about the lease, the
 * payment or the document it refers to.
 *
 * Email delivery is separate and goes through the adapter. A notice that says
 * "emailed" says so because the adapter reported a send — never because one was
 * queued. Nothing here reports a message as delivered that was not sent.
 */
import type { Sql } from '@propertyos/db';
import { notFound } from './errors';

export interface InboxNotice {
  id: string;
  title: string;
  body: string;
  linkPath: string | null;
  channel: string;
  createdAt: string;
  readAt: string | null;
}

/** The signed-in user's own notices, newest first. RLS does the scoping. */
export async function listMyNotifications(
  tx: Sql,
  authUserId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<InboxNotice[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const rows = await tx<
    { id: string; title: string | null; subject: string | null; body: string;
      link_path: string | null; channel: string; created_at: string; read_at: string | null }[]
  >`
    select id, title, subject, body, link_path, channel,
           created_at::text, read_at::text
    from notifications
    where recipient_user_id = ${authUserId}::uuid
      ${options.unreadOnly ? tx`and read_at is null` : tx``}
    order by created_at desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? r.subject ?? 'Notice',
    body: r.body,
    linkPath: r.link_path,
    channel: r.channel,
    createdAt: r.created_at,
    readAt: r.read_at,
  }));
}

export async function countUnreadNotifications(tx: Sql, authUserId: string): Promise<number> {
  const [row] = await tx<{ n: string }[]>`
    select count(*)::text as n from notifications
    where recipient_user_id = ${authUserId}::uuid and read_at is null
  `;
  return Number(row?.n ?? '0');
}

/**
 * Marks one notice read.
 *
 * Scoped by recipient in the statement as well as by policy: a miss is a miss,
 * never someone else's notice silently marked.
 */
export async function markNotificationRead(
  tx: Sql,
  authUserId: string,
  notificationId: string,
): Promise<void> {
  const rows = await tx`
    update notifications set read_at = now()
    where id = ${notificationId}::uuid
      and recipient_user_id = ${authUserId}::uuid
      and read_at is null
    returning id
  `;
  if (rows.length === 0) {
    // Either it is not theirs, or it was already read. Both are "nothing to do"
    // rather than an error worth showing.
    const [exists] = await tx`
      select id from notifications
      where id = ${notificationId}::uuid and recipient_user_id = ${authUserId}::uuid
    `;
    if (!exists) throw notFound('Notification');
  }
}

export async function markAllNotificationsRead(tx: Sql, authUserId: string): Promise<number> {
  const rows = await tx`
    update notifications set read_at = now()
    where recipient_user_id = ${authUserId}::uuid and read_at is null
    returning id
  `;
  return rows.length;
}

/**
 * Posts an in-app notice to specific people.
 *
 * In-app only. It records that the notice exists and is immediately readable;
 * it makes no claim about email. A caller that also wants email sends it
 * through the adapter and records that result separately.
 *
 * `templateKey` must already exist in notification_templates — the foreign key
 * enforces it. That keeps the set of things the product says to people
 * enumerable, instead of letting any call site invent a new kind of message.
 * The title and body passed here carry the specifics; the stored template is
 * the fallback wording.
 */
export async function postInAppNotice(
  tx: Sql,
  organisationId: string,
  params: {
    recipientUserIds: string[];
    templateKey: string;
    title: string;
    body: string;
    linkPath?: string | null;
  },
): Promise<{ posted: number }> {
  const recipients = [...new Set(params.recipientUserIds)].filter(Boolean);
  if (recipients.length === 0) return { posted: 0 };

  const rows = await tx`
    insert into notifications (
      organisation_id, template_key, channel, recipient_user_id,
      title, subject, body, link_path, status, provider, sent_at
    )
    select ${organisationId}::uuid, ${params.templateKey}, 'in_app', r::uuid,
           ${params.title}, ${params.title}, ${params.body},
           ${params.linkPath ?? null}, 'sent', 'in_app', now()
    from unnest(${recipients}::uuid[]) as r
    returning id
  `;
  return { posted: rows.length };
}
