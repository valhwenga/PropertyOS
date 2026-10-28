'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Button, Card, EmptyState, StatusBadge } from '@propertyos/ui';
import { silenceAlertAction, unsilenceAlertAction } from './alert-actions';

/**
 * Everything that is wrong, and what has been said about it.
 *
 * Silenced conditions stay in the list, greyed, with who silenced them and
 * until when. Removing them would hide from a colleague the fact that somebody
 * quietened the dead-job alert until Friday — which is the thing a colleague
 * most needs to know, and the reason this is a list rather than a badge.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

export interface AlertRow {
  key: string;
  severity: 'critical' | 'warning';
  summary: string;
  detail: string;
  href: string;
  silencedUntil: string | null;
  silencedByName: string | null;
  silenceReason: string | null;
  lastRaisedAt: string | null;
}

export function AlertList({
  alerts, canSilence,
}: { alerts: AlertRow[]; canSilence: boolean }) {
  if (alerts.length === 0) {
    return (
      <EmptyState
        title="Nothing is wrong"
        description="No dead jobs, no stalled worker, nobody locked out waiting on Spike, no backlog, no retention date passed and no overdue invoice. This is the state this page exists to be empty in."
      />
    );
  }
  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <AlertCard key={alert.key} alert={alert} canSilence={canSilence} />
      ))}
    </div>
  );
}

function AlertCard({ alert, canSilence }: { alert: AlertRow; canSilence: boolean }) {
  const [silenced, silence, silencing] = useActionState(silenceAlertAction, null);
  const [lifted, lift, lifting] = useActionState(unsilenceAlertAction, null);
  const [open, setOpen] = useState(false);
  const quiet = Boolean(alert.silencedUntil);

  return (
    <Card
      className={quiet ? 'p-4 opacity-70' : 'p-4'}
      data-alert={alert.key}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">{alert.summary}</p>
          <p className="mt-0.5 text-sm text-ink-700">{alert.detail}</p>
          <p className="mt-1 text-xs text-ink-400">
            <span className="tabular">{alert.key}</span>
            {alert.lastRaisedAt
              ? ` · last told somebody ${alert.lastRaisedAt.slice(0, 16).replace('T', ' ')}`
              : ' · nobody has been told'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            tone={quiet ? 'neutral' : alert.severity === 'critical' ? 'critical' : 'caution'}
            glyph={quiet ? '■' : alert.severity === 'critical' ? '▲' : '◐'}
          >
            {quiet ? 'silenced' : alert.severity}
          </StatusBadge>
          <Link
            href={alert.href}
            className="text-sm font-medium text-spike-600 hover:underline"
          >
            Look
          </Link>
        </div>
      </div>

      {quiet ? (
        <p className="mt-2 rounded-lg border border-ink-200 bg-ink-50 p-2 text-xs text-ink-700">
          Silenced until {alert.silencedUntil!.slice(0, 16).replace('T', ' ')} by{' '}
          {alert.silencedByName ?? 'an operator'} — {alert.silenceReason}
        </p>
      ) : null}

      {[silenced, lifted].map((outcome, index) =>
        outcome && !outcome.ok ? (
          <div
            key={index}
            className="mt-2 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2"
          >
            <p className="text-sm text-critical-700">{outcome.message}</p>
          </div>
        ) : null)}

      {canSilence ? (
        <div className="mt-3 border-t border-ink-100 pt-3">
          {quiet ? (
            <form action={lift}>
              <input type="hidden" name="alertKey" value={alert.key} />
              <Button type="submit" variant="secondary" disabled={lifting}>
                {lifting ? 'Lifting…' : 'Tell me about it again'}
              </Button>
            </form>
          ) : (
            <>
              <button
                type="button" onClick={() => setOpen((shown) => !shown)}
                className="text-sm font-medium text-ink-600 hover:underline"
              >
                {open ? 'Cancel' : 'Known — stop telling me for now'}
              </button>
              {open ? (
                <form action={silence} className="mt-2 space-y-2">
                  <input type="hidden" name="alertKey" value={alert.key} />
                  <p className="text-xs text-ink-500">
                    It stays in this list, greyed, with your name and your reason on it. It
                    comes back on its own when the time is up.
                  </p>
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="block text-sm font-medium text-ink-700" htmlFor={`hours-${alert.key}`}>
                        For
                      </label>
                      <select
                        id={`hours-${alert.key}`} name="hours" defaultValue="24"
                        className={`mt-1 ${FIELD}`}
                      >
                        <option value="4">4 hours</option>
                        <option value="24">A day</option>
                        <option value="72">Three days</option>
                        <option value="168">A week</option>
                      </select>
                    </div>
                    <div className="min-w-60 flex-1">
                      <label className="block text-sm font-medium text-ink-700" htmlFor={`why-${alert.key}`}>
                        Why
                      </label>
                      <input
                        id={`why-${alert.key}`} name="reason" required minLength={5} maxLength={500}
                        placeholder="Known: the handler fix deploys on Thursday, SPK-7310"
                        className={`mt-1 ${FIELD}`}
                      />
                    </div>
                    <Button type="submit" variant="secondary" disabled={silencing}>
                      {silencing ? 'Silencing…' : 'Silence it'}
                    </Button>
                  </div>
                </form>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Whether anybody was actually told.
 *
 * The uncomfortable half of this feature. An operator reading a list of alerts
 * needs to know whether they left the building, and with no mail provider
 * configured the answer is no — so the reason sits here in full rather than in
 * a log.
 */
export function NoticeLog({
  notices,
}: {
  notices: Array<{
    alertKey: string; raisedAt: string; severity: string; summary: string;
    recipients: number; sent: number; undelivered: number; lastError: string | null;
  }>;
}) {
  if (notices.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        Nothing has been raised yet. The worker looks every five minutes.
      </p>
    );
  }
  return (
    <Card className="divide-y divide-ink-100">
      {notices.map((notice) => (
        <div key={`${notice.alertKey}-${notice.raisedAt}`} className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-ink-900">{notice.summary}</p>
            <p className="text-xs text-ink-500">
              {notice.raisedAt.slice(0, 16).replace('T', ' ')} ·{' '}
              <span className="tabular">{notice.sent}</span> of{' '}
              <span className="tabular">{notice.recipients}</span> delivered
            </p>
          </div>
          {notice.undelivered > 0 && notice.lastError ? (
            <p className="mt-1 text-xs text-critical-700">{notice.lastError}</p>
          ) : null}
        </div>
      ))}
    </Card>
  );
}
