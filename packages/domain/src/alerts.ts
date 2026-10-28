import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { forbidden, invalid } from './errors';
import { requirePlatformOperator, requirePlatformPermission } from './platform';

/**
 * Telling somebody.
 *
 * Everything this product knew was a screen somebody had to remember to open.
 * The counts were right and unread, which at pilot means the first dead
 * billing job is discovered weeks later by a customer.
 *
 * The division of labour here matters more than any single condition:
 *
 *   * `app.platform_alert_conditions()` decides WHAT is wrong. One definition
 *     in SQL, read by the console, the worker and the tests.
 *   * this module decides WHO is told and whether to say it again.
 *   * the worker does the saying, and records what became of it.
 *
 * Nothing here sends anything. A domain module that reached for an email
 * provider would be a domain module that cannot be tested without one.
 */

export type AlertSeverity = 'critical' | 'warning';

export interface PlatformAlert {
  key: string;
  severity: AlertSeverity;
  summary: string;
  detail: string;
  href: string;
  /** Set when somebody has decided not to be told about this again yet. */
  silencedUntil: string | null;
  silencedByName: string | null;
  silenceReason: string | null;
  /** When this condition last produced a notice, whether or not it arrived. */
  lastRaisedAt: string | null;
}

/**
 * What is wrong right now, and what has been said about it.
 *
 * Silenced conditions are still here, marked. Dropping them would hide from a
 * colleague the fact that somebody quietened the dead-job alert until Friday,
 * which is exactly the thing a colleague needs to know.
 */
export async function platformAlerts(
  tx: Sql,
  authUserId: string,
): Promise<PlatformAlert[]> {
  await requirePlatformOperator(tx, authUserId);

  const rows = await tx<{
    alert_key: string; severity: AlertSeverity; summary: string; detail: string;
    href: string; silenced_until: string | null; silenced_by_name: string | null;
    silence_reason: string | null; last_raised_at: string | null;
  }[]>`
    select a.alert_key, a.severity, a.summary, a.detail, a.href,
           case when s.silenced_until > now() then s.silenced_until::text end as silenced_until,
           case when s.silenced_until > now() then who.full_name end as silenced_by_name,
           case when s.silenced_until > now() then s.reason end as silence_reason,
           (select max(n.raised_at)::text from platform_alert_notices n
             where n.alert_key = a.alert_key) as last_raised_at
    from app.platform_alerts() a
    left join platform_alert_silences s on s.alert_key = a.alert_key
    left join user_profiles who on who.auth_user_id = s.silenced_by
    order by case a.severity when 'critical' then 0 else 1 end, a.alert_key
  `;

  return rows.map((row) => ({
    key: row.alert_key,
    severity: row.severity,
    summary: row.summary,
    detail: row.detail,
    href: row.href,
    silencedUntil: row.silenced_until,
    silencedByName: row.silenced_by_name,
    silenceReason: row.silence_reason,
    lastRaisedAt: row.last_raised_at,
  }));
}

/**
 * Deciding not to be told about something again yet.
 *
 * `platform.operations.manage` rather than a permission of its own: the people
 * who can act on these conditions are the people who should be able to say
 * "yes, known, I am on it". It is given to support as well as administrators,
 * which is the same reasoning the queue screen was built on.
 *
 * An expiry is required and cannot be open-ended. A silence with no end is how
 * a condition stops being an alert and becomes a thing nobody remembers
 * agreeing to ignore.
 */
export async function silenceAlert(
  tx: Sql,
  authUserId: string,
  params: { alertKey: string; hours: number; reason: string },
): Promise<void> {
  const operator = await requirePlatformPermission(
    tx, authUserId, 'platform.operations.manage',
  );
  if (params.reason.trim().length < 5) {
    throw invalid('Say why it is being silenced. A colleague will read it.');
  }
  if (!Number.isInteger(params.hours) || params.hours < 1 || params.hours > 720) {
    throw invalid('Silence it for between an hour and thirty days.');
  }

  const [silenced] = await tx<{ alert_key: string }[]>`
    insert into platform_alert_silences (alert_key, silenced_until, silenced_by, reason)
    values (
      ${params.alertKey},
      now() + make_interval(hours => ${params.hours}),
      ${operator.authUserId}::uuid,
      ${params.reason}
    )
    on conflict (alert_key) do update
      set silenced_until = excluded.silenced_until,
          silenced_by = excluded.silenced_by,
          reason = excluded.reason,
          silenced_at = now()
    returning alert_key
  `;
  if (!silenced) throw forbidden('That alert could not be silenced.');

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: operator.authUserId,
    action: 'platform.alert.silenced',
    resourceType: 'platform_alert',
    resourceId: null,
    reason: params.reason,
    before: null,
    after: { alertKey: params.alertKey, hours: params.hours },
  });
}

/** Undoing that, before it expires on its own. */
export async function unsilenceAlert(
  tx: Sql,
  authUserId: string,
  params: { alertKey: string },
): Promise<void> {
  const operator = await requirePlatformPermission(
    tx, authUserId, 'platform.operations.manage',
  );
  const removed = await tx<{ alert_key: string }[]>`
    delete from platform_alert_silences where alert_key = ${params.alertKey}
    returning alert_key
  `;
  if (removed.length === 0) return;

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: operator.authUserId,
    action: 'platform.alert.unsilenced',
    resourceType: 'platform_alert',
    resourceId: null,
    reason: 'Silence lifted.',
    before: { alertKey: params.alertKey },
    after: null,
  });
}

/** A notice the worker has raised and not yet tried to deliver. */
export interface PendingNotice {
  id: string;
  alertKey: string;
  severity: AlertSeverity;
  summary: string;
  detail: string;
  href: string;
  recipientEmail: string;
}

/**
 * Raising what needs raising, for the worker.
 *
 * Runs on the worker's own connection, so it takes no actor: there is nobody
 * signed in, and the scheduled pass is not somebody's action. What protects it
 * is that `platform_alert_conditions` and these tables are granted to the
 * worker role and to nobody else.
 *
 * Three rules, all of them about not becoming noise:
 *
 *   * a silenced condition raises nothing;
 *   * a condition that raised a notice inside the repeat window raises nothing,
 *     so a condition that stays true for a week produces one notice a day
 *     rather than one every five minutes;
 *   * a condition with no recipient raises nothing, and says so to the caller,
 *     because inserting notices addressed to nobody is how a queue of
 *     undeliverable rows grows without telling anybody anything.
 *
 * Recipients are the operators holding `platform.operations.manage`, which is
 * the permission that can act on every one of these conditions.
 */
export async function raiseAlertNotices(
  tx: Sql,
): Promise<{ notices: PendingNotice[]; conditions: number; recipients: number }> {
  const conditions = await tx<{
    alert_key: string; severity: AlertSeverity; summary: string; detail: string; href: string;
  }[]>`
    select c.* from app.platform_alert_conditions() c
    left join platform_alert_silences s on s.alert_key = c.alert_key
    where (s.silenced_until is null or s.silenced_until <= now())
      and not exists (
        select 1 from platform_alert_notices n
        where n.alert_key = c.alert_key
          and n.raised_at > now()
            - make_interval(hours => app.setting_number('alerts.repeat_hours'))
      )
  `;

  const recipients = await tx<{ auth_user_id: string; email: string }[]>`
    select distinct r.auth_user_id::text, u.email
    from platform_operator_roles r
    join platform_role_permissions rp on rp.role_key = r.role_key
    join auth.users u on u.id = r.auth_user_id
    where rp.permission_key = 'platform.operations.manage'
      and u.email not like 'destroyed-%@invalid'
  `;

  if (conditions.length === 0 || recipients.length === 0) {
    return { notices: [], conditions: conditions.length, recipients: recipients.length };
  }

  const notices: PendingNotice[] = [];
  for (const condition of conditions) {
    for (const recipient of recipients) {
      const [row] = await tx<{ id: string }[]>`
        insert into platform_alert_notices (
          alert_key, severity, summary, recipient_user_id, recipient_email
        ) values (
          ${condition.alert_key}, ${condition.severity}, ${condition.summary},
          ${recipient.auth_user_id}::uuid, ${recipient.email}
        )
        returning id::text
      `;
      if (row) {
        notices.push({
          id: row.id,
          alertKey: condition.alert_key,
          severity: condition.severity,
          summary: condition.summary,
          detail: condition.detail,
          href: condition.href,
          recipientEmail: recipient.email,
        });
      }
    }
  }

  return { notices, conditions: conditions.length, recipients: recipients.length };
}

/** What became of the attempt to deliver one. */
export async function recordNoticeOutcome(
  tx: Sql,
  params: {
    noticeId: string;
    status: 'sent' | 'undeliverable';
    provider?: string;
    error?: string;
  },
): Promise<void> {
  await tx`
    update platform_alert_notices
       set status = ${params.status},
           provider = ${params.provider ?? null},
           sent_at = ${params.status === 'sent' ? tx`now()` : tx`null`},
           last_error = ${params.error ?? null}
     where id = ${params.noticeId}::uuid
  `;
}

export interface NoticeSummary {
  alertKey: string;
  raisedAt: string;
  severity: AlertSeverity;
  summary: string;
  recipients: number;
  sent: number;
  undelivered: number;
  lastError: string | null;
}

/**
 * What has been said lately, and whether it arrived.
 *
 * The question this answers is the uncomfortable one: an operator looking at a
 * list of alerts needs to know whether anybody was actually told, and with no
 * mail provider configured the answer is no. Grouped by raising rather than
 * listed per recipient, because "eleven notices, none delivered" is the fact
 * and the eleven rows are the detail.
 */
export async function recentAlertNotices(
  tx: Sql,
  authUserId: string,
  options: { limit?: number } = {},
): Promise<NoticeSummary[]> {
  await requirePlatformPermission(tx, authUserId, 'platform.operations.manage');

  const rows = await tx<{
    alert_key: string; raised_at: string; severity: AlertSeverity; summary: string;
    recipients: string; sent: string; undelivered: string; last_error: string | null;
  }[]>`
    select alert_key, date_trunc('minute', raised_at)::text as raised_at,
           min(severity) as severity, min(summary) as summary,
           count(*)::text as recipients,
           count(*) filter (where status = 'sent')::text as sent,
           count(*) filter (where status <> 'sent')::text as undelivered,
           min(last_error) filter (where last_error is not null) as last_error
    from platform_alert_notices
    group by alert_key, date_trunc('minute', raised_at)
    order by 2 desc
    limit ${options.limit ?? 30}
  `;

  return rows.map((row) => ({
    alertKey: row.alert_key,
    raisedAt: row.raised_at,
    severity: row.severity,
    summary: row.summary,
    recipients: Number(row.recipients),
    sent: Number(row.sent),
    undelivered: Number(row.undelivered),
    lastError: row.last_error,
  }));
}
