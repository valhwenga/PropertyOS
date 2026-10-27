/**
 * The job queue, as something an operator can act on.
 *
 * `failJob` has moved exhausted work to `dead` since the worker was written,
 * and the platform home page counted those rows under "needs an operator to
 * inspect" with nothing to inspect them with. At pilot the first dead job
 * meant somebody opening a database connection.
 *
 * What these pin:
 *   1. an operator can SEE dead work — jobs are keyed on membership and an
 *      operator is a member of nothing, so this needed real policies;
 *   2. running one again gives it a full retry budget, because the operator
 *      only presses it after fixing the cause;
 *   3. an abandoned job is inert to the worker, which is the whole claim
 *      behind not deleting it;
 *   4. one broken handler is reported as one cause, not a hundred failures;
 *   5. every decision is recorded against the customer it affects.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  abandonJob, jobDetail, listJobs, queueHealth, retryDeadJobsOfType, retryJob,
} from '@propertyos/domain';
import {
  as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

async function createOperator(name: string, roles = ['platform_admin']): Promise<string> {
  const authUserId = await createAuthUser(name, {
    platformOperator: true, platformRoles: roles,
  });
  await ownerSql()`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
    values (${authUserId}, 'totp', 'JBSWY3DPEHPK3PXP', now())
    on conflict (auth_user_id, factor_type) do update set verified_at = now()
  `;
  return authUserId;
}

/** A job the worker has given up on, with a failure history behind it. */
async function createDeadJob(
  organisationId: string,
  jobType: string,
  error = 'relation "nowhere" does not exist',
): Promise<string> {
  const [job] = await ownerSql()<{ id: string }[]>`
    insert into jobs (
      organisation_id, job_type, payload, status, attempts, max_attempts,
      last_error, completed_at
    ) values (
      ${organisationId}, ${jobType},
      ${ownerSql().json({ resourceId: '00000000-0000-0000-0000-000000000001' } as never)},
      'dead', 5, 5, ${error}, now()
    )
    returning id::text
  `;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await ownerSql()`
      insert into job_attempts (job_id, attempt, finished_at, outcome, error)
      values (${job!.id}::bigint, ${attempt}, now(), ${attempt === 5 ? 'dead' : 'failed'}, ${error})
    `;
  }
  return job!.id;
}

describe('the job queue', () => {
  let operator: string;
  let org: OrganisationFixture;
  let stamp: string;

  beforeAll(async () => {
    operator = await createOperator('Spike Operations');
    org = await createOrganisation('Queue Co');
    stamp = Date.now().toString(36);
  });

  afterAll(async () => {
    await ownerSql()`delete from jobs where job_type like ${`test.${stamp}%`}`;
    await closeOwner();
  });

  it('shows an operator the dead work, with the error that killed it', async () => {
    const jobId = await createDeadJob(org.organisationId, `test.${stamp}.broken`);

    const { jobs, total } = await asPlatformOperator(operator, (tx) =>
      listJobs(tx, operator, { status: 'dead', jobType: `test.${stamp}.broken` }),
    );
    expect(total).toBe(1);
    expect(jobs[0]!.id).toBe(jobId);
    expect(jobs[0]!.organisationName).toBe('Queue Co');
    expect(jobs[0]!.lastError).toContain('does not exist');
    expect(jobs[0]!.attempts).toBe(5);

    // And the attempt history, which is what tells "it failed" from "it failed
    // the same way five times".
    const detail = await asPlatformOperator(operator, (tx) =>
      jobDetail(tx, operator, jobId),
    );
    expect(detail.attempts).toHaveLength(5);
    expect(detail.attempts[4]!.outcome).toBe('dead');
    // The payload is identifiers, which is what makes showing it acceptable.
    expect(detail.job.payload).toHaveProperty('resourceId');
  });

  it('gives a job run again the full retry budget', async () => {
    const jobId = await createDeadJob(org.organisationId, `test.${stamp}.retry`);

    await asPlatformOperator(operator, (tx) =>
      retryJob(tx, operator, {
        jobId, reason: 'SPK-9300: the missing table was created, this can run.',
      }),
    );

    const [after] = await ownerSql()<Array<{
      status: string; attempts: number; locked_at: string | null; decision_reason: string;
    }>>`
      select status, attempts, locked_at::text, decision_reason
        from jobs where id = ${jobId}::bigint
    `;
    expect(after!.status).toBe('queued');
    // Zero, not five: leaving the count would give it one attempt and kill it
    // again, which reads as "the fix did not work".
    expect(after!.attempts).toBe(0);
    expect(after!.locked_at).toBeNull();
    expect(after!.decision_reason).toContain('SPK-9300');

    // And it is claimable by the worker again, which is the point.
    const claimable = await ownerSql()`
      select id from jobs
       where id = ${jobId}::bigint and status = 'queued' and run_after <= now()
    `;
    expect(claimable).toHaveLength(1);
  });

  it('makes an abandoned job inert without destroying the evidence', async () => {
    const jobId = await createDeadJob(org.organisationId, `test.${stamp}.abandon`);

    await asPlatformOperator(operator, (tx) =>
      abandonJob(tx, operator, {
        jobId, reason: 'SPK-9301: the lease it refers to was deleted; this can never run.',
      }),
    );

    // The worker claims `status = 'queued'` and nothing else, so this is the
    // assertion that the status alone makes it inert.
    const claimable = await ownerSql()`
      select id from jobs where id = ${jobId}::bigint and status = 'queued'
    `;
    expect(claimable).toHaveLength(0);

    // The row and its history survive: it is the evidence of what went wrong.
    const detail = await asPlatformOperator(operator, (tx) =>
      jobDetail(tx, operator, jobId),
    );
    expect(detail.job.status).toBe('abandoned');
    expect(detail.job.decisionReason).toContain('SPK-9301');
    expect(detail.job.decidedByName).toBe('Spike Operations');
    expect(detail.attempts).toHaveLength(5);

    // It no longer counts as outstanding, which is why a status beats a
    // deletion and beats leaving it dead.
    const health = await asPlatformOperator(operator, (tx) => queueHealth(tx, operator));
    expect(health.abandoned).toBeGreaterThan(0);
    expect(health.deadByType.some((d) => d.jobType === `test.${stamp}.abandon`)).toBe(false);

    // Abandoning twice is a refusal, not a silent success.
    await expect(
      asPlatformOperator(operator, (tx) =>
        abandonJob(tx, operator, { jobId, reason: 'Trying it again, which should refuse.' }),
      ),
    ).rejects.toThrow(/abandoned/);
  });

  it('reports one broken handler as one cause, not a hundred failures', async () => {
    const jobType = `test.${stamp}.bulk`;
    for (let i = 0; i < 4; i += 1) {
      await createDeadJob(org.organisationId, jobType, 'TypeError: handler is not a function');
    }

    const health = await asPlatformOperator(operator, (tx) => queueHealth(tx, operator));
    const cause = health.deadByType.find((d) => d.jobType === jobType)!;
    expect(cause.count).toBe(4);
    expect(cause.lastError).toContain('TypeError');

    // And all four run again in one decision, because retrying two hundred by
    // hand is how somebody gives up halfway.
    const { retried } = await asPlatformOperator(operator, (tx) =>
      retryDeadJobsOfType(tx, operator, {
        jobType, reason: 'SPK-9302: the handler was registered, these can run.',
      }),
    );
    expect(retried).toBe(4);

    const stillDead = await ownerSql()`
      select id from jobs where job_type = ${jobType} and status = 'dead'
    `;
    expect(stillDead).toHaveLength(0);

    // Nothing of that type left to retry, said as a refusal.
    await expect(
      asPlatformOperator(operator, (tx) =>
        retryDeadJobsOfType(tx, operator, { jobType, reason: 'Nothing left to do.' }),
      ),
    ).rejects.toThrow(/no dead work/);
  });

  it('refuses to run work the worker has not given up on', async () => {
    const [queued] = await ownerSql()<{ id: string }[]>`
      insert into jobs (organisation_id, job_type, status)
      values (${org.organisationId}, ${`test.${stamp}.live`}, 'queued')
      returning id::text
    `;
    await expect(
      asPlatformOperator(operator, (tx) =>
        retryJob(tx, operator, {
          jobId: queued!.id, reason: 'It has not failed yet, so there is nothing to retry.',
        }),
      ),
    ).rejects.toThrow(/not dead/);
  });

  it('keeps the queue to operators who hold the permission', async () => {
    const billing = await createOperator('Spike Billing Only', ['platform_billing']);
    await expect(
      asPlatformOperator(billing, (tx) => queueHealth(tx, billing)),
    ).rejects.toThrow(/platform role does not include this/i);

    // And the rows themselves: jobs are keyed on membership, so a platform
    // reader without this permission sees nothing through the policies either.
    const leaked = await as(billing, (tx) => tx`select id from jobs limit 1`);
    expect(leaked).toHaveLength(0);

    // Support holds it on purpose: a queue that backs up is firefighting, and
    // the person awake is usually support.
    const support = await createOperator('Spike Support Ops', ['platform_support']);
    const health = await asPlatformOperator(support, (tx) => queueHealth(tx, support));
    expect(health).toHaveProperty('dead');
  });

  it('records each decision against the customer it affects', async () => {
    const trail = await ownerSql()<Array<{ action: string; organisation_id: string | null }>>`
      select action, organisation_id from audit_events
       where action like 'platform.job%'
       order by occurred_at
    `;
    const retried = trail.find((t) => t.action === 'platform.job_retried');
    expect(retried?.organisation_id).toBe(org.organisationId);

    // The bulk retry crosses customers by definition, so it belongs to none.
    const bulk = trail.find((t) => t.action === 'platform.jobs_retried_in_bulk');
    expect(bulk).toBeDefined();
    expect(bulk!.organisation_id).toBeNull();
  });
});
