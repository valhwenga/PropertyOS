import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { conflict, notFound, parsed } from './errors';
import { recordAudit } from './audit';
import { requirePlatformPermission } from './platform';

/**
 * The job queue, as something an operator can act on.
 *
 * `failJob` has moved exhausted work to `dead` since the worker was written,
 * and the platform home page counted those rows under "needs an operator to
 * inspect" with nothing to inspect them with: no list, no error, no payload,
 * no way to run one again. At pilot the first dead job meant a database
 * connection.
 *
 * What an operator decides here is only WHETHER work runs. The handler was
 * queued by the customer's own action and does what it was always going to do;
 * there is no path in this module that edits a payload.
 *
 * See docs/decisions/0027-the-queue-is-operable.md.
 */

export interface QueuedJob {
  id: string;
  jobType: string;
  status: string;
  organisationName: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  runAfter: string;
  /** Set when an operator ran it again or abandoned it. */
  decisionReason: string | null;
  decidedByName: string | null;
  /** Claimed by a worker that has not reported back within the lease. */
  stalled: boolean;
}

export interface QueueHealth {
  queued: number;
  running: number;
  stalled: number;
  dead: number;
  abandoned: number;
  /** The oldest thing still waiting, which is what says whether the worker is alive. */
  oldestQueuedAt: string | null;
  /** Dead work grouped by handler: one broken handler looks like many failures. */
  deadByType: Array<{ jobType: string; count: number; lastError: string | null }>;
  unpublishedOutbox: number;
  oldestUnpublishedAt: string | null;
  undeliveredNotifications: number;
}

/**
 * The shape of the queue right now.
 *
 * Grouped by handler as well as counted, because one broken handler produces
 * a hundred dead jobs and a flat count invites somebody to retry them one at a
 * time rather than fix the cause.
 */
export async function queueHealth(tx: Sql, authUserId: string): Promise<QueueHealth> {
  await requirePlatformPermission(tx, authUserId, 'platform.operations.manage');

  const [counts] = await tx<Array<{
    queued: string; running: string; stalled: string; dead: string; abandoned: string;
    oldest_queued: string | null;
  }>>`
    select
      count(*) filter (where status = 'queued')::text as queued,
      count(*) filter (where status = 'running')::text as running,
      -- A worker takes a lease and reports back; one that died mid-flight
      -- leaves the job 'running' until reclaimStalled picks it up, and a
      -- queue full of those means the worker is gone rather than busy.
      count(*) filter (
        where status = 'running' and locked_at < now() - interval '15 minutes'
      )::text as stalled,
      count(*) filter (where status = 'dead')::text as dead,
      count(*) filter (where status = 'abandoned')::text as abandoned,
      min(run_after) filter (where status = 'queued')::text as oldest_queued
      from jobs
  `;

  const byType = await tx<Array<{ job_type: string; n: string; last_error: string | null }>>`
    select job_type, count(*)::text as n,
           (array_agg(last_error order by created_at desc))[1] as last_error
      from jobs where status = 'dead'
     group by job_type
     order by count(*) desc
     limit 50
  `;

  const [backlog] = await tx<Array<{
    unpublished: string; oldest: string | null; undelivered: string;
  }>>`
    select
      (select count(*)::text from outbox_events where published_at is null) as unpublished,
      (select min(occurred_at)::text from outbox_events where published_at is null) as oldest,
      (select count(*)::text from notifications where status <> 'sent') as undelivered
  `;

  return {
    queued: Number(counts?.queued ?? 0),
    running: Number(counts?.running ?? 0),
    stalled: Number(counts?.stalled ?? 0),
    dead: Number(counts?.dead ?? 0),
    abandoned: Number(counts?.abandoned ?? 0),
    oldestQueuedAt: counts?.oldest_queued ?? null,
    deadByType: byType.map((r) => ({
      jobType: r.job_type, count: Number(r.n), lastError: r.last_error,
    })),
    unpublishedOutbox: Number(backlog?.unpublished ?? 0),
    oldestUnpublishedAt: backlog?.oldest ?? null,
    undeliveredNotifications: Number(backlog?.undelivered ?? 0),
  };
}

export const jobFilterSchema = z.object({
  status: z.enum(['dead', 'abandoned', 'queued', 'running', 'succeeded']).default('dead'),
  jobType: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function listJobs(
  tx: Sql,
  authUserId: string,
  filter: z.input<typeof jobFilterSchema> = {},
): Promise<{ jobs: QueuedJob[]; total: number }> {
  await requirePlatformPermission(tx, authUserId, 'platform.operations.manage');
  const f = parsed(jobFilterSchema, filter);

  const where = f.jobType
    ? tx`j.status = ${f.status} and j.job_type = ${f.jobType}`
    : tx`j.status = ${f.status}`;

  const rows = await tx<Array<{
    id: string; job_type: string; status: string; organisation_name: string | null;
    attempts: number; max_attempts: number; last_error: string | null;
    created_at: string; run_after: string; decision_reason: string | null;
    decided_by_name: string | null; stalled: boolean;
  }>>`
    select j.id::text, j.job_type, j.status, o.name as organisation_name,
           j.attempts, j.max_attempts, j.last_error,
           j.created_at::text, j.run_after::text, j.decision_reason,
           by.full_name as decided_by_name,
           (j.status = 'running' and j.locked_at < now() - interval '15 minutes') as stalled
      from jobs j
      left join organisations o on o.id = j.organisation_id
      left join user_profiles by on by.auth_user_id = j.decided_by
     where ${where}
     order by j.created_at desc
     limit ${f.limit}
  `;

  const [counted] = await tx<{ n: string }[]>`
    select count(*)::text as n from jobs j where ${where}
  `;

  return {
    jobs: rows.map((r) => ({
      id: r.id,
      jobType: r.job_type,
      status: r.status,
      organisationName: r.organisation_name,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      lastError: r.last_error,
      createdAt: r.created_at,
      runAfter: r.run_after,
      decisionReason: r.decision_reason,
      decidedByName: r.decided_by_name,
      stalled: r.stalled,
    })),
    total: Number(counted?.n ?? 0),
  };
}

/**
 * One job, with every attempt it made.
 *
 * The attempt history is the difference between "it failed" and "it failed the
 * same way five times", which is the difference between a broken handler and a
 * database that was briefly away.
 */
export async function jobDetail(
  tx: Sql,
  authUserId: string,
  jobId: string,
): Promise<{
  job: QueuedJob & { payload: Record<string, unknown>; correlationId: string | null };
  attempts: Array<{ attempt: number; startedAt: string; finishedAt: string | null;
    outcome: string | null; error: string | null }>;
}> {
  await requirePlatformPermission(tx, authUserId, 'platform.operations.manage');

  const [row] = await tx<Array<{
    id: string; job_type: string; status: string; organisation_name: string | null;
    attempts: number; max_attempts: number; last_error: string | null; created_at: string;
    run_after: string; decision_reason: string | null; decided_by_name: string | null;
    stalled: boolean; payload: Record<string, unknown>; correlation_id: string | null;
  }>>`
    select j.id::text, j.job_type, j.status, o.name as organisation_name,
           j.attempts, j.max_attempts, j.last_error, j.created_at::text, j.run_after::text,
           j.decision_reason, by.full_name as decided_by_name, j.payload,
           j.correlation_id::text,
           (j.status = 'running' and j.locked_at < now() - interval '15 minutes') as stalled
      from jobs j
      left join organisations o on o.id = j.organisation_id
      left join user_profiles by on by.auth_user_id = j.decided_by
     where j.id = ${jobId}::bigint
  `;
  if (!row) throw notFound('Job');

  const attempts = await tx<Array<{
    attempt: number; started_at: string; finished_at: string | null;
    outcome: string | null; error: string | null;
  }>>`
    select attempt, started_at::text, finished_at::text, outcome, error
      from job_attempts where job_id = ${jobId}::bigint
     order by attempt
  `;

  return {
    job: {
      id: row.id,
      jobType: row.job_type,
      status: row.status,
      organisationName: row.organisation_name,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      runAfter: row.run_after,
      decisionReason: row.decision_reason,
      decidedByName: row.decided_by_name,
      stalled: row.stalled,
      payload: row.payload,
      correlationId: row.correlation_id,
    },
    attempts: attempts.map((a) => ({
      attempt: a.attempt,
      startedAt: a.started_at,
      finishedAt: a.finished_at,
      outcome: a.outcome,
      error: a.error,
    })),
  };
}

const decisionSchema = z.object({
  jobId: z.string().regex(/^\d+$/, 'A job id is a number.'),
  reason: z.string().trim()
    .min(5, 'Say what was fixed, so the next failure reads differently.').max(500),
});

/**
 * Running a dead job again.
 *
 * The attempt counter goes back to zero: this is a new life for the job, with
 * the full retry budget, because an operator only presses it after fixing
 * whatever killed it. Leaving the count would give the job one attempt and
 * then kill it again, which reads as "the fix did not work".
 *
 * It does NOT promise the handler is safe to run twice. A handler that failed
 * after doing half its work will do that half again, and the honest place to
 * say so is the screen — which does.
 */
export async function retryJob(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof decisionSchema>,
): Promise<void> {
  const actor = await requirePlatformPermission(
    tx, authUserId, 'platform.operations.manage',
  );
  const details = parsed(decisionSchema, input);

  const [job] = await tx<Array<{
    id: string; status: string; job_type: string; organisation_id: string | null;
  }>>`
    select id::text, status, job_type, organisation_id::text
      from jobs where id = ${details.jobId}::bigint
  `;
  if (!job) throw notFound('Job');
  if (!['dead', 'abandoned'].includes(job.status)) {
    throw conflict(
      `That job is ${job.status}, not dead. Only work the worker has given up on is run again here.`,
    );
  }

  await tx`
    update jobs
       set status = 'queued', attempts = 0, run_after = now(),
           locked_at = null, locked_by = null, completed_at = null,
           decided_by = ${authUserId}::uuid, decided_at = now(),
           decision_reason = ${details.reason}
     where id = ${details.jobId}::bigint
  `;

  await recordAudit(tx, {
    // Against the customer whose work it is, where there is one: a job that
    // ran again is a thing that happened to their account.
    organisationId: job.organisation_id,
    actorUserId: authUserId,
    action: 'platform.job_retried',
    resourceType: 'job',
    resourceId: null,
    reason: details.reason,
    before: { job: job.id, jobType: job.job_type, status: job.status },
    after: { job: job.id, status: 'queued', retriedBy: actor.fullName },
  });
}

/** Deciding that a dead job will never run. */
export async function abandonJob(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof decisionSchema>,
): Promise<void> {
  const actor = await requirePlatformPermission(
    tx, authUserId, 'platform.operations.manage',
  );
  const details = parsed(decisionSchema, input);

  const [job] = await tx<Array<{
    id: string; status: string; job_type: string; organisation_id: string | null;
  }>>`
    select id::text, status, job_type, organisation_id::text
      from jobs where id = ${details.jobId}::bigint
  `;
  if (!job) throw notFound('Job');
  if (job.status !== 'dead') {
    throw conflict(`That job is ${job.status}. Only a dead job can be abandoned.`);
  }

  // Deliberately not a delete: the row is the evidence of what went wrong, and
  // the status is what stops it being counted as outstanding for ever.
  await tx`
    update jobs
       set status = 'abandoned', decided_by = ${authUserId}::uuid, decided_at = now(),
           decision_reason = ${details.reason}
     where id = ${details.jobId}::bigint
  `;

  await recordAudit(tx, {
    organisationId: job.organisation_id,
    actorUserId: authUserId,
    action: 'platform.job_abandoned',
    resourceType: 'job',
    resourceId: null,
    reason: details.reason,
    before: { job: job.id, jobType: job.job_type, status: 'dead' },
    after: { job: job.id, status: 'abandoned', abandonedBy: actor.fullName },
  });
}

/**
 * Running every dead job of one kind again.
 *
 * The case this exists for: a handler was broken for an afternoon and two
 * hundred jobs died of the same cause. Retrying those one at a time is how an
 * operator gives up halfway and leaves a permanent red number on the home
 * page.
 */
export async function retryDeadJobsOfType(
  tx: Sql,
  authUserId: string,
  input: { jobType: string; reason: string },
): Promise<{ retried: number }> {
  const actor = await requirePlatformPermission(
    tx, authUserId, 'platform.operations.manage',
  );
  const details = parsed(
    z.object({
      jobType: z.string().trim().min(2).max(80),
      reason: z.string().trim().min(5, 'Say what was fixed.').max(500),
    }),
    input,
  );

  const requeued = await tx<{ id: string }[]>`
    update jobs
       set status = 'queued', attempts = 0, run_after = now(),
           locked_at = null, locked_by = null, completed_at = null,
           decided_by = ${authUserId}::uuid, decided_at = now(),
           decision_reason = ${details.reason}
     where status = 'dead' and job_type = ${details.jobType}
     returning id::text
  `;
  if (requeued.length === 0) {
    throw conflict(`There is no dead work of type "${details.jobType}". Nothing was changed.`);
  }

  await recordAudit(tx, {
    // No single organisation: this crosses customers by definition, which is
    // what makes it a platform action rather than something done to one of
    // them.
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.jobs_retried_in_bulk',
    resourceType: 'job',
    resourceId: null,
    reason: details.reason,
    after: {
      jobType: details.jobType, retried: requeued.length, retriedBy: actor.fullName,
    },
  });

  return { retried: requeued.length };
}
