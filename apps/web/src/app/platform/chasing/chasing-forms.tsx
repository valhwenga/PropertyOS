'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { stopChasingAction, suspendForNonPaymentAction } from './actions';

/**
 * One overdue invoice, and the two things a person can decide about it.
 *
 * The ladder itself is shown as what has already been sent, in order, because
 * the question an operator actually has in front of an angry customer is "what
 * did we send them, and when" — not "what stage are they at".
 *
 * Suspending is a separate expander with its own reason, and is never the
 * default button on the card. The product has refused to automate suspension
 * since ADR 0017; making it a one-click action on a list would automate it in
 * everything but name.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

export type Step = 'first_reminder' | 'final_notice' | 'suspension_proposed' | 'suspended' | 'written_off';

const STEP_LABEL: Record<Step, string> = {
  first_reminder: 'Reminder sent',
  final_notice: 'Final notice sent',
  suspension_proposed: 'Suspension proposed',
  suspended: 'Suspended',
  written_off: 'Chasing stopped',
};

export interface OverdueRow {
  invoiceId: string;
  invoiceNumber: string;
  organisationName: string;
  slug: string;
  outstanding: string;
  dueDate: string;
  daysOverdue: number;
  organisationStatus: string;
  awaitingDecision: boolean;
  settled: boolean;
  steps: Array<{ step: Step; takenAt: string; takenByName: string | null; note: string | null }>;
}

function tone(row: OverdueRow): { tone: StatusTone; glyph: string; label: string } {
  if (row.steps.some((s) => s.step === 'suspended')) {
    return { tone: 'critical', glyph: '■', label: 'suspended' };
  }
  if (row.steps.some((s) => s.step === 'written_off')) {
    return { tone: 'neutral', glyph: '■', label: 'not chasing' };
  }
  if (row.awaitingDecision) return { tone: 'critical', glyph: '▲', label: 'needs a decision' };
  if (row.steps.length > 0) return { tone: 'caution', glyph: '◐', label: 'being chased' };
  return { tone: 'info', glyph: '◐', label: 'overdue' };
}

export function OverdueCard({ row, canSuspend }: { row: OverdueRow; canSuspend: boolean }) {
  const [suspended, suspend, suspending] = useActionState(suspendForNonPaymentAction, null);
  const [stopped, stop, stopping] = useActionState(stopChasingAction, null);
  const [open, setOpen] = useState<'none' | 'suspend' | 'stop'>('none');
  const badge = tone(row);

  return (
    <Card className="p-4" data-overdue={row.invoiceNumber}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">
            {row.organisationName}
            <span className="ml-2 font-normal text-ink-500">{row.invoiceNumber}</span>
          </p>
          <p className="text-xs text-ink-500">
            <span className="tabular">{row.outstanding}</span> outstanding · due {row.dueDate} ·{' '}
            <span className="tabular">{row.daysOverdue}</span> days overdue
            {row.organisationStatus !== 'active' ? ` · account ${row.organisationStatus}` : ''}
          </p>
        </div>
        <StatusBadge tone={badge.tone} glyph={badge.glyph}>{badge.label}</StatusBadge>
      </div>

      {row.steps.length > 0 ? (
        <ol className="mt-3 space-y-1 border-t border-ink-100 pt-3">
          {row.steps.map((step) => (
            <li key={step.step} className="text-xs text-ink-500">
              <span className="font-medium text-ink-700">{STEP_LABEL[step.step]}</span>{' '}
              {step.takenAt.slice(0, 10)}
              {step.takenByName ? ` by ${step.takenByName}` : ''}
              {step.note ? ` — ${step.note}` : ''}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 border-t border-ink-100 pt-3 text-xs text-ink-500">
          Nothing has been sent yet. The next pass sends the first reminder.
        </p>
      )}

      {[suspended, stopped].map((outcome, index) =>
        outcome && !outcome.ok ? (
          <div
            key={index}
            className="mt-2 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2"
          >
            <p className="text-sm text-critical-700">{outcome.message}</p>
          </div>
        ) : null)}

      {row.settled ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-ink-100 pt-3">
          <a
            href={`/platform/customers/${row.slug}`}
            className="text-sm font-medium text-spike-600 underline underline-offset-2"
          >
            Open the customer
          </a>
          <button
            type="button"
            onClick={() => setOpen((shown) => (shown === 'stop' ? 'none' : 'stop'))}
            className="text-sm font-medium text-ink-600 hover:underline"
          >
            {open === 'stop' ? 'Keep chasing' : 'Stop chasing this'}
          </button>
          {canSuspend && row.organisationStatus === 'active' ? (
            <button
              type="button"
              onClick={() => setOpen((shown) => (shown === 'suspend' ? 'none' : 'suspend'))}
              className="text-sm font-medium text-critical-700 hover:underline"
            >
              {open === 'suspend' ? 'Leave it alone' : 'Suspend the account'}
            </button>
          ) : null}
        </div>
      )}

      {open === 'stop' ? (
        <form action={stop} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="invoiceId" value={row.invoiceId} />
          <div className="min-w-60 flex-1">
            <label className="block text-sm font-medium text-ink-700" htmlFor={`stop-${row.invoiceId}`}>
              Why the chasing is stopping
            </label>
            <input
              id={`stop-${row.invoiceId}`} name="reason" required minLength={5} maxLength={500}
              placeholder="Rang in, paying by transfer on Friday"
              className={`mt-1 ${FIELD}`}
            />
            <p className="mt-1 text-xs text-ink-500">
              The invoice still says what it says. This stops the reminders, it does not
              withdraw the charge.
            </p>
          </div>
          <Button type="submit" variant="secondary" disabled={stopping}>
            {stopping ? 'Saving…' : 'Stop chasing'}
          </Button>
        </form>
      ) : null}

      {open === 'suspend' ? (
        <form action={suspend} className="mt-2 space-y-2 rounded-lg border border-critical-700/25 bg-critical-50 p-3">
          <input type="hidden" name="invoiceId" value={row.invoiceId} />
          <p className="text-sm text-critical-700">
            They lose the console until this is settled. Their records are untouched, the
            resident portal keeps working, and billing keeps running.
          </p>
          <div>
            <label className="block text-sm font-medium text-ink-700" htmlFor={`why-${row.invoiceId}`}>
              Why the account is being suspended
            </label>
            <input
              id={`why-${row.invoiceId}`} name="reason" required minLength={5} maxLength={500}
              placeholder="Unpaid after a final notice and two calls"
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <Button type="submit" variant="danger" disabled={suspending}>
            {suspending ? 'Suspending…' : 'Suspend the account'}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
