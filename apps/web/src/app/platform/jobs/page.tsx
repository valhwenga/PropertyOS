import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@propertyos/ui';
import {
  listJobs, platformPermissionsOf, queueHealth, undeliveredNotices,
} from '@propertyos/domain';
import { readPrivilegedAs, requireViewer } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { JobRow, RetryTypeForm } from './job-forms';

export const metadata = { title: 'Background work' };
export const dynamic = 'force-dynamic';

/**
 * The job queue.
 *
 * The platform home page has counted dead jobs as "needs an operator to
 * inspect" since it was written, with nothing to inspect them with. This is
 * that screen: what failed, what killed it, and the two decisions available —
 * run it again, or say it never will.
 *
 * The thing worth noticing about the numbers at the top is which one means the
 * worker is dead rather than busy. A queue that is long with a recent oldest
 * entry is a busy worker; a queue that is long with an oldest entry from
 * yesterday is no worker at all, and the page says so rather than leaving it
 * to be worked out.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string }>;
}) {
  const viewer = await requireViewer();
  const q = await searchParams;
  const status = ['dead', 'abandoned', 'queued', 'running', 'succeeded']
    .includes(q.status ?? '')
    ? (q.status as 'dead' | 'abandoned' | 'queued' | 'running' | 'succeeded')
    : 'dead';

  const { health, listed, mine, undelivered } = await readPrivilegedAs(viewer, async (tx) => ({
    health: await queueHealth(tx, viewer.authUserId),
    undelivered: await undeliveredNotices(tx, viewer.authUserId),
    listed: await listJobs(tx, viewer.authUserId, {
      status, ...(q.type ? { jobType: q.type } : {}),
    }),
    mine: await platformPermissionsOf(tx, viewer.authUserId),
  }));

  const canManage = mine.includes('platform.operations.manage');
  const oldestQueued = health.oldestQueuedAt
    ? new Date(health.oldestQueuedAt).getTime()
    : null;
  // Ten minutes is not a threshold with science behind it: it is long enough
  // that an ordinary backlog has drained and short enough that somebody still
  // has time to act.
  const workerLooksStopped = Boolean(
    (oldestQueued !== null && Date.now() - oldestQueued > 10 * 60_000) || health.stalled > 0,
  );

  const tab = (value: string, label: string, count?: number) => (
    <Link
      key={value}
      href={`/platform/jobs?status=${value}`}
      aria-current={status === value ? 'page' : undefined}
      className={[
        'rounded-lg border px-3 py-1.5 text-sm',
        status === value
          ? 'border-spike-500 bg-spike-50 font-medium text-spike-700'
          : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50',
      ].join(' ')}
    >
      {label}{count === undefined ? '' : ` ${count}`}
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Background work"
        description="What the worker is doing, what it gave up on, and why. Running a job again does not change what it does — only whether it runs."
      />

      {workerLooksStopped ? (
        <Card className="border-critical-700/30 bg-critical-50 p-4">
          <p className="text-sm font-semibold text-critical-700">
            The worker may not be running
          </p>
          <p className="mt-1 text-sm text-ink-700">
            {health.stalled > 0
              ? `${health.stalled} job${health.stalled === 1 ? ' was' : 's were'} claimed and never reported back. A worker that died mid-flight leaves them like this until it restarts and reclaims them.`
              : `The oldest queued job has been waiting since ${formatDateTime(health.oldestQueuedAt!, 'Africa/Johannesburg')}. A busy worker does not leave work that long.`}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Nothing on this page restarts it. Check the worker process before running
            anything again, or the retries will queue up behind the same wall.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Waiting</p>
          <p className="tabular mt-1 text-2xl font-semibold">{health.queued}</p>
          {health.oldestQueuedAt ? (
            <p className="mt-1 text-xs text-ink-400">
              oldest {formatDateTime(health.oldestQueuedAt, 'Africa/Johannesburg')}
            </p>
          ) : null}
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Running</p>
          <p className="tabular mt-1 text-2xl font-semibold">{health.running}</p>
          {health.stalled > 0 ? (
            <p className="mt-1 text-xs text-critical-700">{health.stalled} stalled</p>
          ) : null}
        </Card>
        <Card className={health.dead > 0 ? 'border-critical-700/30 p-4' : 'p-4'}>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Gave up</p>
          <p className="tabular mt-1 text-2xl font-semibold">{health.dead}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Abandoned</p>
          <p className="tabular mt-1 text-2xl font-semibold">{health.abandoned}</p>
          <p className="mt-1 text-xs text-ink-400">a person decided</p>
        </Card>
        <Card className={health.unpublishedOutbox > 50 ? 'border-caution-700/30 p-4' : 'p-4'}>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Events not yet queued
          </p>
          <p className="tabular mt-1 text-2xl font-semibold">{health.unpublishedOutbox}</p>
          <p className="mt-1 text-xs text-ink-400">
            {health.undeliveredNotifications} message
            {health.undeliveredNotifications === 1 ? '' : 's'} undelivered
          </p>
        </Card>
      </div>

      {undelivered.total > 0 ? (
        <section aria-labelledby="undelivered" className="space-y-3">
          <h2
            id="undelivered"
            className="text-sm font-semibold uppercase tracking-wide text-ink-500"
          >
            Messages nobody received
          </h2>
          <p className="text-sm text-ink-500">
            Grouped by why. <strong>Queued</strong> means the worker has not reached it yet;
            <strong> no provider</strong> means this deployment delivers nothing at all and the
            message was recorded rather than sent; <strong>refused</strong> means a provider
            said no, in its own words.
          </p>
          {undelivered.byState.map((state) => (
            <Card key={state.status} className="p-4" data-undelivered={state.status}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-ink-900">
                  {state.status === 'queued'
                    ? 'Queued, not yet attempted'
                    : state.status === 'development_sink'
                      ? 'No mail provider is configured'
                      : 'A provider refused it'}
                </p>
                <p className="tabular text-sm text-ink-700">
                  {state.count} message{state.count === 1 ? '' : 's'}
                </p>
              </div>
              {state.reason ? (
                <p className="mt-2 text-xs text-ink-500">{state.reason}</p>
              ) : null}
              {state.oldestAt ? (
                <p className="mt-1 text-xs text-ink-400">
                  oldest written {state.oldestAt.slice(0, 10)}
                </p>
              ) : null}
            </Card>
          ))}
        </section>
      ) : null}

      {health.deadByType.length > 0 ? (
        <section aria-labelledby="causes" className="space-y-3">
          <h2 id="causes" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            What is failing
          </h2>
          <p className="text-sm text-ink-500">
            Grouped by handler, because one broken handler is one cause rather than a hundred
            failures. Fix the cause, then run them all again.
          </p>
          {health.deadByType.map((cause) => (
            canManage ? (
              <RetryTypeForm
                key={cause.jobType}
                jobType={cause.jobType}
                count={cause.count}
                lastError={cause.lastError}
              />
            ) : (
              <Card key={cause.jobType} className="p-4">
                <p className="tabular text-sm font-medium text-ink-900">{cause.jobType}</p>
                <p className="text-xs text-ink-500">{cause.count} dead</p>
              </Card>
            )
          ))}
        </section>
      ) : null}

      <section aria-labelledby="jobs" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="jobs" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            {listed.total} {status}
          </h2>
          <nav aria-label="Job status" className="flex flex-wrap gap-2">
            {tab('dead', 'Gave up', health.dead)}
            {tab('abandoned', 'Abandoned', health.abandoned)}
            {tab('queued', 'Waiting', health.queued)}
            {tab('running', 'Running', health.running)}
            {tab('succeeded', 'Done')}
          </nav>
        </div>

        {listed.jobs.length === 0 ? (
          <EmptyState
            title={status === 'dead' ? 'Nothing has been given up on' : `Nothing ${status}`}
            description={
              status === 'dead'
                ? 'Every job the worker has taken has either succeeded or is still being retried.'
                : 'No job is in that state right now.'
            }
          />
        ) : (
          listed.jobs.map((job) => (
            <JobRow key={job.id} job={job} canManage={canManage} />
          ))
        )}
      </section>
    </div>
  );
}
