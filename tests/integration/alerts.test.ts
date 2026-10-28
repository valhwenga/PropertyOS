/**
 * Telling somebody.
 *
 * Every signal this product had was a screen somebody had to remember to open,
 * and the counts were right and unread. These tests pin the part that leaves
 * the building.
 *
 * What they pin:
 *
 *   1. the conditions fire on the real state of the database, and an empty
 *      result is the good state rather than a broken query;
 *   2. silencing stops the telling and does NOT hide the condition — a
 *      colleague must be able to see that somebody quietened it, and until
 *      when;
 *   3. a condition that is still true does not raise a notice every five
 *      minutes: the repeat window holds;
 *   4. a notice is addressed to the operators who can act on it, with the
 *      delivery outcome recorded against each one — so "was anybody actually
 *      told" has an answer;
 *   5. an operator without the permission can read what is wrong and cannot
 *      silence it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  platformAlerts, raiseAlertNotices, recentAlertNotices, recordNoticeOutcome,
  silenceAlert, unsilenceAlert,
} from '@propertyos/domain';
import {
  as, asPlatformOperator, closeOwner, createAuthUser, ownerSql,
} from '../support/factories.js';

async function createOperator(name: string, roles: string[]): Promise<string> {
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

/** A handler that failed for good: the commonest real condition. */
async function seedDeadJob(): Promise<void> {
  await ownerSql()`
    insert into jobs (job_type, payload, status, attempts, max_attempts, last_error)
    values (
      'alerts.spec.broken', '{}'::jsonb, 'dead', 5, 5,
      'TypeError: handler is not a function'
    )
  `;
}

describe('something tells somebody', () => {
  let admin: string;
  let viewerOnly: string;

  beforeAll(async () => {
    admin = await createOperator('Spike Watcher', ['platform_admin']);
    // `platform_viewer` can read the console and holds no operations
    // permission, which is the interesting half of the permission test.
    viewerOnly = await createOperator('Spike Observer', ['platform_viewer']);
  });

  beforeEach(async () => {
    await ownerSql()`delete from jobs where job_type like 'alerts.spec.%'`;
    await ownerSql()`delete from platform_alert_silences`;
    await ownerSql()`delete from platform_alert_notices`;
  });

  afterAll(async () => {
    await ownerSql()`delete from jobs where job_type like 'alerts.spec.%'`;
    await ownerSql()`delete from platform_alert_silences`;
    await ownerSql()`delete from platform_alert_notices`;
    await closeOwner();
  });

  it('says what is wrong', async () => {
    // Deliberately no assertion that the list is EMPTY beforehand. Other
    // suites in this run are creating and killing jobs of their own, so a
    // globally quiet database is not a property this file can rely on — it
    // would be a test that passes or fails depending on what else is running.
    // "Nothing is wrong" on a quiet system is asserted in the browser spec,
    // against the demo database.
    await seedDeadJob();

    const loud = await asPlatformOperator(admin, (tx) => platformAlerts(tx, admin));
    const dead = loud.find((a) => a.key === 'jobs.dead');
    expect(dead?.severity).toBe('critical');
    expect(dead?.summary).toContain('given up on');
    // It says where to go, because an alert that does not is a riddle.
    expect(dead?.href).toBe('/platform/jobs');
    expect(dead?.silencedUntil).toBeNull();
  });

  it('is readable by an operator who cannot act on it, and silenced by one who can', async () => {
    await seedDeadJob();

    // Reading is for any operator: a viewer who can see the console can see
    // what is wrong with it.
    const seen = await asPlatformOperator(viewerOnly, (tx) =>
      platformAlerts(tx, viewerOnly));
    expect(seen.some((a) => a.key === 'jobs.dead')).toBe(true);

    await expect(asPlatformOperator(viewerOnly, (tx) => silenceAlert(tx, viewerOnly, {
      alertKey: 'jobs.dead', hours: 24, reason: 'I would rather not see it',
    }))).rejects.toThrow(/platform role/i);

    // And a reason is not optional, nor is an open-ended silence.
    await expect(asPlatformOperator(admin, (tx) => silenceAlert(tx, admin, {
      alertKey: 'jobs.dead', hours: 24, reason: 'no',
    }))).rejects.toThrow(/why/i);
    await expect(asPlatformOperator(admin, (tx) => silenceAlert(tx, admin, {
      alertKey: 'jobs.dead', hours: 10_000, reason: 'Known for ever, do not tell me',
    }))).rejects.toThrow(/thirty days/i);
  });

  it('silencing stops the telling and keeps the condition visible', async () => {
    await seedDeadJob();
    await asPlatformOperator(admin, (tx) => silenceAlert(tx, admin, {
      alertKey: 'jobs.dead', hours: 24,
      reason: 'Known: the handler fix deploys on Thursday, SPK-7310',
    }));

    // Still there, marked, with who and why: a colleague must be able to see
    // that somebody quietened it rather than find a list with a hole in it.
    const listed = await asPlatformOperator(admin, (tx) => platformAlerts(tx, admin));
    const dead = listed.find((a) => a.key === 'jobs.dead');
    expect(dead).toBeDefined();
    expect(dead?.silencedUntil).toBeTruthy();
    expect(dead?.silencedByName).toBe('Spike Watcher');
    expect(dead?.silenceReason).toContain('SPK-7310');

    // And it raises nothing while silenced.
    const { notices } = await ownerSql().begin(async (tx) =>
      raiseAlertNotices(tx as never));
    expect(notices.some((n) => n.alertKey === 'jobs.dead')).toBe(false);

    // Lifted, it is loud again.
    await asPlatformOperator(admin, (tx) => unsilenceAlert(tx, admin, {
      alertKey: 'jobs.dead',
    }));
    const after = await asPlatformOperator(admin, (tx) => platformAlerts(tx, admin));
    expect(after.find((a) => a.key === 'jobs.dead')?.silencedUntil).toBeNull();
  });

  it('addresses the people who can act, and holds the repeat window', async () => {
    await seedDeadJob();

    const first = await ownerSql().begin(async (tx) => raiseAlertNotices(tx as never));
    const mine = first.notices.filter((n) => n.alertKey === 'jobs.dead');
    expect(mine.length).toBeGreaterThan(0);

    // The admin holds platform.operations.manage; the viewer does not, so no
    // notice is addressed to them.
    const addressed = new Set(mine.map((n) => n.recipientEmail));
    const [adminEmail] = await ownerSql()<{ email: string }[]>`
      select email from auth.users where id = ${admin}::uuid
    `;
    const [viewerEmail] = await ownerSql()<{ email: string }[]>`
      select email from auth.users where id = ${viewerOnly}::uuid
    `;
    expect(addressed.has(adminEmail!.email)).toBe(true);
    expect(addressed.has(viewerEmail!.email)).toBe(false);

    // Still true five minutes later, and it does not say it again.
    const second = await ownerSql().begin(async (tx) => raiseAlertNotices(tx as never));
    expect(second.notices.some((n) => n.alertKey === 'jobs.dead')).toBe(false);
  });

  it('records whether anybody was actually told', async () => {
    await seedDeadJob();
    const { notices } = await ownerSql().begin(async (tx) => raiseAlertNotices(tx as never));
    const notice = notices.find((n) => n.alertKey === 'jobs.dead')!;

    // What the worker does with the sink adapter: nothing was delivered, and
    // the reason is kept rather than logged and lost.
    await ownerSql().begin(async (tx) => recordNoticeOutcome(tx as never, {
      noticeId: notice.id, status: 'undeliverable', provider: 'sink',
      error: 'EMAIL_PROVIDER is not set to "smtp". Messages are recorded locally.',
    }));

    const log = await asPlatformOperator(admin, (tx) => recentAlertNotices(tx, admin));
    const entry = log.find((n) => n.alertKey === 'jobs.dead');
    expect(entry?.sent).toBe(0);
    expect(entry?.undelivered).toBeGreaterThan(0);
    expect(entry?.lastError).toContain('EMAIL_PROVIDER');

    // An operator who cannot act on alerts cannot read the delivery log
    // either: it carries colleagues' addresses.
    await expect(asPlatformOperator(viewerOnly, (tx) =>
      recentAlertNotices(tx, viewerOnly))).rejects.toThrow(/platform role/i);
  });

  it('is not readable by a customer, however many jobs are dead', async () => {
    await seedDeadJob();
    const landlord = await createAuthUser('Ordinary Landlord');
    await expect(as(landlord, (tx) => platformAlerts(tx, landlord))).rejects.toThrow();
  });
});
