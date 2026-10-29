/**
 * The pass that tells somebody.
 *
 * Every signal this product had was a screen. This is the part that leaves the
 * building: on a cadence, it asks the database what is wrong, raises a notice
 * per recipient for anything not silenced and not said recently, and tries to
 * deliver each one.
 *
 * Three things it deliberately does not do.
 *
 * It does not decide what is wrong — `app.platform_alert_conditions()` does,
 * so the console, this pass and the tests cannot disagree about a threshold.
 *
 * It does not fail the worker. A mail provider that is down must not stop the
 * queue: an undeliverable notice is recorded as undeliverable and the loop
 * carries on. The alert about the alerts is the undelivered count on the
 * console, which is itself one of the conditions.
 *
 * And it does not pretend. With no provider configured the adapter is the sink,
 * every notice is recorded `undeliverable` with the sink's own reason on it,
 * and the screen says so — rather than a product that believes it has told
 * somebody.
 */
import {
  chaseOverdueInvoices, noticesAwaitingDelivery, raiseAlertNotices, recordNoticeDelivery,
  recordNoticeOutcome,
} from '@propertyos/domain';
import { resolveEmailAdapter } from '@propertyos/integrations';
import type { Sql } from './queue';

/** The worker's own logger, passed in: `main` owns it and this is not worth a
 *  second implementation or a circular import. */
type Log = (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;

const email = resolveEmailAdapter();

function body(notice: {
  summary: string; detail: string; href: string; severity: string;
}): string {
  const base = process.env.APP_BASE_URL ?? '';
  return [
    notice.summary,
    '',
    notice.detail,
    '',
    `Open: ${base}${notice.href}`,
    '',
    'You are receiving this because you hold platform.operations.manage in the',
    'Spike console. Silence it there if it is known and in hand.',
  ].join('\n');
}

export async function watchForTrouble(sql: Sql, log: Log): Promise<number> {
  // Chasing before alerting, so that a reminder recorded on this pass is
  // reflected in the conditions the same pass raises rather than a cadence
  // later. It only records steps and queues messages — it cannot suspend
  // anybody, which is a person's decision.
  try {
    const chased = await chaseOverdueInvoices(sql as never);
    if (chased.reminders + chased.finalNotices + chased.proposed > 0) {
      log('info', 'chased overdue invoices', { ...chased });
    }
  } catch (error) {
    // Never allowed to stop the alerting that follows it, for the same reason
    // alerting is never allowed to stop the queue.
    log('error', 'chasing pass failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Then the messages written for customers and residents, which until now
  // nothing had ever sent: a reminder, a final notice, an invoice message's
  // sibling notices — all written, all queued, all sitting in a table. The
  // alerts below are Spike telling itself; this is the product telling the
  // people it is about.
  try {
    const delivered = await deliverQueuedNotices(sql, log);
    if (delivered.attempted > 0) log('info', 'queued notices attempted', { ...delivered });
  } catch (error) {
    log('error', 'notice delivery pass failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const { notices, conditions, recipients } = await raiseAlertNotices(sql as never);

  if (conditions > 0 && recipients === 0) {
    // Worth a line in the log precisely because nothing else can say it: there
    // is something wrong and nobody to tell.
    log('warn', 'platform conditions are raised with no operator to notify', { conditions });
  }

  for (const notice of notices) {
    try {
      const outcome = await email.send({
        to: notice.recipientEmail,
        subject: `[Spike ${notice.severity}] ${notice.summary}`,
        body: body(notice),
        templateKey: `alert.${notice.alertKey}`,
      });

      if (outcome.status === 'sent') {
        await recordNoticeOutcome(sql as never, {
          noticeId: notice.id, status: 'sent', provider: outcome.provider,
        });
      } else {
        await recordNoticeOutcome(sql as never, {
          noticeId: notice.id,
          status: 'undeliverable',
          provider: outcome.provider,
          error: outcome.status === 'development_sink' ? outcome.reason : outcome.error,
        });
      }
    } catch (error) {
      // A provider that throws is the same outcome as one that refuses, and
      // neither is allowed to stop the queue.
      await recordNoticeOutcome(sql as never, {
        noticeId: notice.id,
        status: 'undeliverable',
        provider: email.name,
        error: error instanceof Error ? error.message : 'unknown delivery error',
      });
    }
  }

  if (notices.length > 0) {
    log('info', 'platform alerts raised', {
      conditions, recipients, notices: notices.length, provider: email.name,
    });
  }
  return notices.length;
}

/**
 * Delivers the email notices the product has written for people.
 *
 * Separate from the alert delivery above on purpose: those are Spike's own
 * messages to its operators, and this is everything the product says to a
 * landlord or a resident — the dunning reminder, the final notice, whatever a
 * future template adds. They were all being written and none of them sent,
 * because `sendInvoiceMessage` was the only thing in the worker that had ever
 * called the adapter for a notification row.
 *
 * Capped per pass, oldest first, and `attempts` caps the retries: a provider
 * that has refused the same message four times will refuse the fifth, and the
 * record says why rather than the loop trying forever.
 *
 * Nothing here throws. A mail provider that is down must not stop the queue —
 * the notice says it was not delivered, and the undelivered count is itself one
 * of the conditions the alert pass raises.
 */
export async function deliverQueuedNotices(
  sql: Sql,
  log: Log,
): Promise<{ attempted: number; sent: number; undelivered: number }> {
  const queued = await noticesAwaitingDelivery(sql as never, { limit: 50 });
  let sent = 0;
  let undelivered = 0;

  for (const notice of queued) {
    try {
      const outcome = await email.send({
        to: notice.recipientEmail,
        subject: notice.subject,
        body: notice.body,
        templateKey: notice.templateKey ?? undefined,
        // The notice's own id, so that four retries of something the provider
        // already accepted cannot put four copies in somebody's inbox.
        idempotencyKey: notice.id,
      });

      // "Ask again shortly" — a rate limit, a 5xx, an unreachable provider.
      // The notice keeps its attempts and the pass stops: the next messages
      // would get the same answer, and hammering a provider that just asked us
      // to slow down is how an account gets suspended.
      const waitAndRetry = outcome.status === 'failed' && outcome.retryAfterSeconds !== undefined;

      await recordNoticeDelivery(sql as never, {
        notificationId: notice.id,
        status: outcome.status,
        provider: outcome.provider,
        providerMessageId: outcome.status === 'sent' ? outcome.providerMessageId : null,
        detail: outcome.status === 'sent'
          ? null
          : outcome.status === 'development_sink' ? outcome.reason : outcome.error,
        keepQueued: waitAndRetry,
      });

      if (waitAndRetry) {
        log('warn', 'delivery paused by the provider', {
          provider: outcome.provider,
          retryAfterSeconds: (outcome as { retryAfterSeconds?: number }).retryAfterSeconds,
          remaining: queued.length - (sent + undelivered),
        });
        break;
      }

      if (outcome.status === 'sent') sent += 1;
      else undelivered += 1;
    } catch (error) {
      // A provider that throws is the same outcome as one that refuses.
      await recordNoticeDelivery(sql as never, {
        notificationId: notice.id,
        status: 'failed',
        provider: email.name,
        providerMessageId: null,
        detail: error instanceof Error ? error.message : 'unknown delivery error',
      });
      undelivered += 1;
    }
  }

  if (undelivered > 0) {
    // Said once per pass rather than once per message: with no provider
    // configured this is every notice, every time, and a log nobody can read
    // is as useless as a notice nobody receives.
    log('warn', 'notices were not delivered', { count: undelivered, provider: email.name });
  }

  return { attempted: queued.length, sent, undelivered };
}
