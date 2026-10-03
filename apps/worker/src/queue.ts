import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, unknown>>;

export interface Job {
  id: string;
  organisationId: string | null;
  jobType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  correlationId: string | null;
}

/**
 * Claims one job.
 *
 * `FOR UPDATE SKIP LOCKED` lets several workers run concurrently without ever
 * handing the same job to two of them. The claim and the status change happen in
 * one statement, so a worker that dies immediately after claiming leaves the job
 * locked only until its lease expires (see `reclaimStalled`).
 */
export async function claimJob(sql: Sql, workerId: string): Promise<Job | null> {
  const [row] = await sql<
    {
      id: string; organisation_id: string | null; job_type: string;
      payload: Record<string, unknown>; attempts: number; max_attempts: number;
      correlation_id: string | null;
    }[]
  >`
    update jobs set
      status = 'running',
      locked_at = now(),
      locked_by = ${workerId},
      attempts = attempts + 1
    where id = (
      select id from jobs
      where status = 'queued' and run_after <= now()
      order by run_after, id
      for update skip locked
      limit 1
    )
    returning id, organisation_id, job_type, payload, attempts, max_attempts, correlation_id
  `;
  if (!row) return null;
  return {
    id: row.id,
    organisationId: row.organisation_id,
    jobType: row.job_type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    correlationId: row.correlation_id,
  };
}

export async function completeJob(sql: Sql, job: Job): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update jobs set status = 'succeeded', completed_at = now(), locked_at = null, locked_by = null
      where id = ${job.id}
    `;
    await tx`
      insert into job_attempts (job_id, attempt, finished_at, outcome)
      values (${job.id}, ${job.attempts}, now(), 'succeeded')
    `;
  });
}

/**
 * Records a failure.
 *
 * Retries use exponential backoff with a cap. Once `max_attempts` is reached the
 * job moves to `dead` — a poison queue an operator can inspect — rather than
 * looping forever or being silently discarded.
 */
export async function failJob(sql: Sql, job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const backoffSeconds = Math.min(2 ** job.attempts * 5, 3600);

  await sql.begin(async (tx) => {
    await tx`
      update jobs set
        status = ${exhausted ? 'dead' : 'queued'},
        run_after = now() + (${backoffSeconds} || ' seconds')::interval,
        last_error = ${message.slice(0, 2000)},
        locked_at = null, locked_by = null,
        completed_at = ${exhausted ? tx`now()` : null}
      where id = ${job.id}
    `;
    await tx`
      insert into job_attempts (job_id, attempt, finished_at, outcome, error)
      values (${job.id}, ${job.attempts}, now(),
              ${exhausted ? 'dead' : 'failed'}, ${message.slice(0, 2000)})
    `;
  });
}

/**
 * Returns jobs whose worker died mid-flight to the queue.
 * Without this, a container restart would strand every in-flight job.
 */
export async function reclaimStalled(sql: Sql, leaseMinutes = 15): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update jobs set status = 'queued', locked_at = null, locked_by = null
    where status = 'running' and locked_at < now() - (${leaseMinutes} || ' minutes')::interval
    returning id
  `;
  return rows.length;
}
