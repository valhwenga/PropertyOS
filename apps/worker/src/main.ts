/**
 * PropertyOS background worker.
 *
 * A separate PROCESS that shares the domain packages — not an independently
 * owned service. It claims durable PostgreSQL jobs, publishes the transactional
 * outbox, and retries with bounded backoff.
 *
 * Trust boundary: the worker uses the privileged connection, but it derives
 * organisation scope from the stored job row it claimed — never from anything a
 * browser supplied. A job payload is data the worker wrote for itself.
 */
import postgres from 'postgres';
import { HANDLERS } from './handlers';
import { claimJob, completeJob, failJob, reclaimStalled, type Sql } from './queue';
import { publishOutbox } from './outbox';

const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);

let running = true;

function log(level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) {
  // Structured, and deliberately free of personal data.
  process.stdout.write(`${JSON.stringify({
    level, worker: WORKER_ID, message, timestamp: new Date().toISOString(), ...extra,
  })}\n`);
}

async function tick(sql: Sql): Promise<boolean> {
  const published = await publishOutbox(sql);
  if (published > 0) log('info', 'outbox published', { count: published });

  const job = await claimJob(sql, WORKER_ID);
  if (!job) return false;

  const handler = HANDLERS[job.jobType];
  if (!handler) {
    await failJob(sql, job, new Error(`No handler registered for job type "${job.jobType}"`));
    log('warn', 'unhandled job type', { jobId: job.id, jobType: job.jobType });
    return true;
  }

  try {
    await handler(sql, job);
    await completeJob(sql, job);
    log('info', 'job succeeded', { jobId: job.id, jobType: job.jobType, attempt: job.attempts });
  } catch (error) {
    await failJob(sql, job, error);
    log('error', 'job failed', {
      jobId: job.id, jobType: job.jobType, attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for the worker.');
  const sql = postgres(url, { max: 4, onnotice: () => {} }) as Sql;

  const reclaimed = await reclaimStalled(sql);
  if (reclaimed > 0) log('warn', 'reclaimed stalled jobs after restart', { count: reclaimed });

  log('info', 'worker started', { pollIntervalMs: POLL_MS });

  const stop = () => { running = false; log('info', 'shutting down'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let sinceReclaim = Date.now();
  while (running) {
    try {
      const didWork = await tick(sql);
      if (!didWork) await new Promise((r) => setTimeout(r, POLL_MS));
      if (Date.now() - sinceReclaim > 60_000) {
        await reclaimStalled(sql);
        sinceReclaim = Date.now();
      }
    } catch (error) {
      log('error', 'worker loop error', {
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  await sql.end({ timeout: 10 });
}

main().catch((error: unknown) => {
  log('error', 'worker crashed', { error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
});
