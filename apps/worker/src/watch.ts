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
import { raiseAlertNotices, recordNoticeOutcome } from '@propertyos/domain';
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
