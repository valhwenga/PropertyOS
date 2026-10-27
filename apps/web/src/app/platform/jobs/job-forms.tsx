'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import { abandonJobAction, retryJobAction, retryTypeAction } from './actions';

/**
 * One failure, and the two things that can be done about it.
 *
 * The error text is shown in full rather than truncated: the first line of a
 * stack is usually enough to tell a broken handler from a database that was
 * briefly away, and an operator who has to open a database connection to read
 * it is back where this screen started.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

export interface JobView {
  id: string;
  jobType: string;
  status: string;
  organisationName: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  decisionReason: string | null;
  decidedByName: string | null;
  stalled: boolean;
}

export function JobRow({ job, canManage }: { job: JobView; canManage: boolean }) {
  const [retried, retry, retrying] = useActionState(retryJobAction, null);
  const [abandoned, abandon, abandoning] = useActionState(abandonJobAction, null);
  const [open, setOpen] = useState<'retry' | 'abandon' | null>(null);

  return (
    <Card className="p-4" data-job={job.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">
            <span className="tabular">{job.jobType}</span>
            <span className="ml-2 text-xs text-ink-400">#{job.id}</span>
          </p>
          <p className="text-xs text-ink-500">
            {job.organisationName ?? 'no customer — platform work'} ·{' '}
            {job.attempts} of {job.maxAttempts} attempts · queued{' '}
            {job.createdAt.slice(0, 16).replace('T', ' ')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job.stalled ? (
            <StatusBadge tone="critical" glyph="▲">claimed and never returned</StatusBadge>
          ) : null}
          <StatusBadge
            tone={job.status === 'dead' ? 'critical' : job.status === 'abandoned' ? 'neutral' : 'info'}
            glyph={job.status === 'dead' ? '▲' : job.status === 'abandoned' ? '■' : '◐'}
          >
            {job.status}
          </StatusBadge>
        </div>
      </div>

      {job.lastError ? (
        <pre className="
          mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border border-ink-200
          bg-ink-50 p-2 text-xs text-ink-700
        ">
          {job.lastError}
        </pre>
      ) : null}

      {job.decisionReason ? (
        <p className="mt-2 text-xs text-ink-500">
          {job.decidedByName ? `${job.decidedByName}: ` : ''}{job.decisionReason}
        </p>
      ) : null}

      {[retried, abandoned].map((outcome, index) =>
        outcome && !outcome.ok ? (
          <div
            key={index}
            className="mt-2 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2"
          >
            <p className="text-sm text-critical-700">{outcome.message}</p>
          </div>
        ) : null)}

      {canManage && (job.status === 'dead' || job.status === 'abandoned') ? (
        <div className="mt-3 flex flex-wrap gap-3 border-t border-ink-100 pt-3">
          <button
            type="button" onClick={() => setOpen(open === 'retry' ? null : 'retry')}
            className="text-sm font-medium text-spike-600 hover:underline"
          >
            {open === 'retry' ? 'Cancel' : 'Run it again'}
          </button>
          {job.status === 'dead' ? (
            <button
              type="button" onClick={() => setOpen(open === 'abandon' ? null : 'abandon')}
              className="text-sm font-medium text-ink-600 hover:underline"
            >
              {open === 'abandon' ? 'Cancel' : 'It will never run'}
            </button>
          ) : null}
        </div>
      ) : null}

      {open === 'retry' ? (
        <form action={retry} className="mt-2 space-y-2">
          <input type="hidden" name="jobId" value={job.id} />
          <p className="text-xs text-ink-500">
            It goes back on the queue with a full set of attempts. A handler that failed
            part-way through will repeat the part that worked — this runs the job, it does
            not undo it.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-60 flex-1">
              <label className="block text-sm font-medium text-ink-700" htmlFor={`retry-${job.id}`}>
                What was fixed
              </label>
              <input
                id={`retry-${job.id}`} name="reason" required minLength={5} maxLength={500}
                placeholder="SPK-1234: the handler was registered and deployed"
                className={`mt-1 ${FIELD}`}
              />
            </div>
            <Button type="submit" variant="primary" disabled={retrying}>
              {retrying ? 'Queueing…' : 'Run it again'}
            </Button>
          </div>
        </form>
      ) : null}

      {open === 'abandon' ? (
        <form action={abandon} className="mt-2 space-y-2">
          <input type="hidden" name="jobId" value={job.id} />
          <p className="text-xs text-ink-500">
            The row and its attempts stay — they are the evidence of what went wrong. It
            stops being counted as outstanding, and the worker will never pick it up.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-60 flex-1">
              <label className="block text-sm font-medium text-ink-700" htmlFor={`abandon-${job.id}`}>
                Why it can never run
              </label>
              <input
                id={`abandon-${job.id}`} name="reason" required minLength={5} maxLength={500}
                placeholder="The lease it refers to was deleted"
                className={`mt-1 ${FIELD}`}
              />
            </div>
            <Button type="submit" variant="danger" disabled={abandoning}>
              {abandoning ? 'Abandoning…' : 'Abandon it'}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

/**
 * Everything of one kind, in one decision.
 *
 * The case: a handler was broken for an afternoon and two hundred jobs died of
 * the same cause. Retrying those one at a time is how somebody gives up
 * halfway and leaves a permanent red number on the home page.
 */
export function RetryTypeForm({
  jobType, count, lastError,
}: { jobType: string; count: number; lastError: string | null }) {
  const [state, action, pending] = useActionState(retryTypeAction, null);
  const [open, setOpen] = useState(false);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">
            <span className="tabular">{jobType}</span>
          </p>
          <p className="text-xs text-ink-500">
            {count} dead job{count === 1 ? '' : 's'} — almost certainly one cause
          </p>
        </div>
        <button
          type="button" onClick={() => setOpen((shown) => !shown)}
          className="text-sm font-medium text-spike-600 hover:underline"
        >
          {open ? 'Cancel' : `Run all ${count} again`}
        </button>
      </div>

      {lastError ? (
        <pre className="
          mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border border-ink-200
          bg-ink-50 p-2 text-xs text-ink-700
        ">
          {lastError}
        </pre>
      ) : null}

      {/* No success message, deliberately — the same rule the support-access
          controls follow. A successful bulk retry empties this cause from the
          page, so the line announcing it would render into a component that
          has just been unmounted; the cause disappearing IS the feedback. A
          failure keeps the cause, and the component, so it has somewhere to
          show. */}
      {state && !state.ok ? (
        <div className="mt-2 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{state.message}</p>
        </div>
      ) : null}

      {open ? (
        <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="jobType" value={jobType} />
          <div className="min-w-60 flex-1">
            <label className="block text-sm font-medium text-ink-700" htmlFor={`bulk-${jobType}`}>
              What was fixed
            </label>
            <input
              id={`bulk-${jobType}`} name="reason" required minLength={5} maxLength={500}
              placeholder="SPK-1234: the handler was registered and deployed"
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Queueing…' : `Run all ${count} again`}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
