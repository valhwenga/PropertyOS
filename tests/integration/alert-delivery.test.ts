/**
 * The worker's watch pass, which is the part that actually leaves the building.
 *
 * Tested through the real function rather than a copy of its logic, because
 * the thing worth asserting is the behaviour nobody wants to discover in
 * production: that a mail provider which is absent or broken does not stop the
 * queue, and does not let the product believe it has told somebody.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { raiseAlertNotices } from '@propertyos/domain';
import { ownerSql, closeOwner, createAuthUser } from '../support/factories.js';
import { watchForTrouble } from '../../apps/worker/src/watch';

function silentLog(): (
  level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>
) => void {
  return () => {};
}

describe('the watch pass', () => {
  let operator: string;

  beforeAll(async () => {
    operator = await createAuthUser('Spike On Call', {
      platformOperator: true, platformRoles: ['platform_admin'],
    });
  });

  beforeEach(async () => {
    await ownerSql()`delete from jobs where job_type like 'watch.spec.%'`;
    await ownerSql()`delete from platform_alert_notices`;
    await ownerSql()`delete from platform_alert_silences`;
  });

  afterAll(async () => {
    await ownerSql()`delete from jobs where job_type like 'watch.spec.%'`;
    await ownerSql()`delete from platform_alert_notices`;
    await closeOwner();
  });

  it('raises and records, without a mail provider and without throwing', async () => {
    await ownerSql()`
      insert into jobs (job_type, payload, status, attempts, max_attempts, last_error)
      values ('watch.spec.broken', '{}'::jsonb, 'dead', 5, 5, 'ReferenceError: nope')
    `;

    // The whole point: no EMAIL_PROVIDER is configured in the test
    // environment, and this must not throw. A provider that is down is not a
    // reason for rent charges to stop posting.
    const sent = await watchForTrouble(ownerSql() as never, silentLog());
    expect(sent).toBeGreaterThan(0);

    const rows = await ownerSql()<{
      alert_key: string; status: string; recipient_email: string; last_error: string | null;
      sent_at: string | null;
    }[]>`
      select alert_key, status, recipient_email, last_error, sent_at::text
      from platform_alert_notices where alert_key = 'jobs.dead'
    `;
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // Not 'sent', and the reason is on the row rather than in a log nobody
      // reads. This is the state the console shows as "0 of 2 delivered".
      expect(row.status).toBe('undeliverable');
      expect(row.sent_at).toBeNull();
      expect(row.last_error).toMatch(/EMAIL_PROVIDER|smtp/i);
      expect(row.recipient_email).toContain('@');
    }
  });

  it('does not say the same thing twice inside the repeat window', async () => {
    await ownerSql()`
      insert into jobs (job_type, payload, status, attempts, max_attempts, last_error)
      values ('watch.spec.broken', '{}'::jsonb, 'dead', 5, 5, 'ReferenceError: nope')
    `;
    await watchForTrouble(ownerSql() as never, silentLog());

    const count = async () => {
      const [row] = await ownerSql()<{ count: string }[]>`
        select count(*)::text from platform_alert_notices where alert_key = 'jobs.dead'
      `;
      return Number(row?.count);
    };
    const afterFirst = await count();
    expect(afterFirst).toBeGreaterThan(0);

    // The condition is still true, and the worker's next pass five minutes
    // later tells nobody again. Counted by alert key rather than by the pass's
    // return value: other suites in this run raise conditions of their own,
    // and a total is not this file's to assert.
    await watchForTrouble(ownerSql() as never, silentLog());
    expect(await count()).toBe(afterFirst);
  });

  it('tells nobody when there is nobody to tell, and does not lose the condition', async () => {
    await ownerSql()`
      insert into jobs (job_type, payload, status, attempts, max_attempts, last_error)
      values ('watch.spec.broken', '{}'::jsonb, 'dead', 5, 5, 'ReferenceError: nope')
    `;

    // Inside a transaction that is rolled back, for two reasons. The schema
    // refuses to leave the platform with no administrator — a constraint
    // trigger from 0072, doing its job — so the way to produce "nobody to
    // tell" is to take the PERMISSION away rather than the people. And doing
    // that to global configuration must not be visible to anything else, so it
    // never commits.
    const sentinel = new Error('rollback');
    let noticesRaised = -1;
    let conditionsLeft = -1;
    await ownerSql().begin(async (tx) => {
      await tx`
        delete from platform_role_permissions
        where permission_key = 'platform.operations.manage'
      `;
      const { notices, recipients } = await raiseAlertNotices(tx as never);
      expect(recipients).toBe(0);
      noticesRaised = notices.length;

      const [left] = await tx<{ count: string }[]>`
        select count(*)::text from app.platform_alert_conditions()
        where alert_key = 'jobs.dead'
      `;
      conditionsLeft = Number(left?.count);
      throw sentinel;
    }).catch((error: unknown) => {
      if (error !== sentinel) throw error;
    });

    // No notices addressed to nobody: a queue of undeliverable rows is not an
    // improvement on silence.
    expect(noticesRaised).toBe(0);
    // And the condition is untouched, so it is raised the moment somebody can
    // receive it.
    expect(conditionsLeft).toBe(1);

    const [after] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from platform_alert_notices
    `;
    expect(Number(after?.count)).toBe(0);
    expect(operator).toBeTruthy();
  });
});
