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
import { log, WORKER_ID } from './logger';
import { claimJob, completeJob, failJob, reclaimStalled, type Sql } from './queue';
import { publishOutbox } from './outbox';
import { watchForTrouble } from './watch';


const POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
/**
 * How often the worker asks what is wrong and tells somebody.
 *
 * Five minutes rather than every tick: the conditions are counts over whole
 * tables, and the repeat window that stops a notice being sent twice is hours
 * long, so asking more often would cost queries and change nothing.
 */
const WATCH_MS = Number(process.env.WORKER_WATCH_INTERVAL_MS ?? 300_000);

/**
 * Drain and stop, instead of polling for ever.
 *
 * A long-running process is the right shape on a server and an impossible one
 * on a host that only runs things on a schedule. In drain mode the worker
 * claims everything that is ready, publishes the outbox, and exits — so the
 * same binary can be a daemon on one deployment and a cron job on another,
 * with no second implementation to drift.
 *
 * The time limit is a safety rail: a queue that keeps filling must not keep
 * one scheduled run alive for ever.
 */
const DRAIN = process.argv.includes('--drain') || process.env.WORKER_DRAIN === '1';
const DRAIN_LIMIT_MS = Number(process.env.WORKER_DRAIN_LIMIT_MS ?? 120_000);

let running = true;

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

  log('info', 'worker started', { pollIntervalMs: POLL_MS, mode: DRAIN ? 'drain' : 'poll' });

  if (DRAIN) {
    const until = Date.now() + DRAIN_LIMIT_MS;
    let done = 0;
    while (Date.now() < until) {
      if (!await tick(sql)) break;   // nothing claimed: the queue is empty
      done += 1;
    }
    log('info', 'drained', { jobs: done, stoppedEarly: Date.now() >= until });
    await sql.end({ timeout: 10 });
    return;
  }

  const stop = () => { running = false; log('info', 'shutting down'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let sinceReclaim = Date.now();
  // Deliberately in the past, so the first pass runs at startup: a worker that
  // has just restarted is exactly when somebody wants to know what it found.
  let sinceWatch = Date.now() - WATCH_MS;
  while (running) {
    try {
      const didWork = await tick(sql);
      if (!didWork) await new Promise((r) => setTimeout(r, POLL_MS));
      if (Date.now() - sinceReclaim > 60_000) {
        await reclaimStalled(sql);
        sinceReclaim = Date.now();
      }
      if (Date.now() - sinceWatch > WATCH_MS) {
        sinceWatch = Date.now();
        // Never allowed to stop the queue: a mail provider that is down is not
        // a reason for rent charges to stop posting.
        try {
          await watchForTrouble(sql, log);
        } catch (error) {
          log('error', 'watch pass failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
