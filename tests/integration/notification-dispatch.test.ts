/**
 * Whether a notice ever reaches a person.
 *
 * The worker has had a `notify` handler since migration 0006. It wrote the
 * template's own text — `{{reference}}` and all — into `notifications` with no
 * `recipient_user_id`, which the inbox reads by, and then recorded the row as
 * **sent**. Five event types went through it. Nobody has ever received one,
 * and every screen and alert believed otherwise.
 *
 * What these tests pin:
 *
 *   1. a notice is addressed to the people it is about, and they can read it
 *      through the inbox they actually use;
 *   2. an unresolved placeholder is a refusal, not a message;
 *   3. the schema refuses both failures directly, so a future call site that
 *      forgets cannot repeat them;
 *   4. a redelivered event writes one notice, not two;
 *   5. where there is nobody who could read it, nothing is written and the
 *      reason says so — a resident without portal access is a fact about this
 *      product, not a silent drop;
 *   6. an email notice is `queued` until a provider acknowledges it, and the
 *      delivery pass records the adapter's own word.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, createResident, createStandaloneHouse, countUnreadNotifications,
  dispatchEventNotice, draftLease, listMyNotifications, noticesAwaitingDelivery,
  parseMajorToMinor, recordNoticeDelivery, renderNotice,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, grantPortalAccess, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

/**
 * The worker's connection: no session and no RLS, which is how the real one
 * runs — there is nobody signed in when a background pass sends a message.
 * Same shape the dunning tests use for the chasing pass.
 */
const asWorker = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
  ownerSql().begin(async (tx) => fn(tx as never));

describe('Notices that reach somebody', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let residentId: string;
  let residentUser: string;
  let unitId: string;

  beforeAll(async () => {
    org = await createOrganisation('Notified Co');
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Notice House', code: `NTC${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '7 Notice Road', city: 'Durban',
      }));
    unitId = house.unitId;
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Sipho', lastName: 'Ndlovu',
      }));
    residentId = resident.residentId;
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('9500'), depositRequiredMinor: R('9500'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }));
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Signed offline for this fixture.',
      }));
  });

  afterAll(async () => { await closeOwner(); });

  it('refuses a message with a placeholder nobody filled in', () => {
    expect(renderNotice('Request {{reference}} logged', { reference: 'MT-0007' }))
      .toBe('Request MT-0007 logged');

    // The refusal names what was missing, because a developer reading
    // "validation failed" learns nothing.
    expect(() => renderNotice('Hello {{resident_name}}, you owe {{amount}}', { amount: 'R1' }))
      .toThrowError(/resident_name/);

    // An empty string is a missing variable, not a value. "You owe " is worse
    // than no message at all.
    expect(() => renderNotice('You owe {{amount}}', { amount: '' })).toThrowError(/amount/);
  });

  it('addresses a maintenance notice to the resident, who can read it', async () => {
    const [ticket] = await ownerSql()<{ id: string; reference: string }[]>`
      insert into maintenance_tickets (
        organisation_id, reference, property_id, unit_id, lease_id,
        reported_by_resident, category, description, urgency, status
      )
      select ${org.organisationId}, ${`MT-${Date.now().toString().slice(-6)}`},
             u.property_id, ${unitId}, ${leaseId},
             ${residentId}, 'plumbing', 'The geyser is dripping', 'normal', 'submitted'
        from units u where u.id = ${unitId}
      returning id::text, reference
    `;

    // Portal access first: without it there is nobody who could read a notice,
    // which the next test is about.
    residentUser = await grantPortalAccess(
      org.organisationId, leaseId, residentId, 'Sipho Portal',
    );

    const outcome = await asWorker((tx) => dispatchEventNotice(tx, {
      organisationId: org.organisationId,
      eventType: 'maintenance.ticket.created',
      resourceType: 'maintenance_ticket',
      resourceId: ticket!.id,
      payload: { reference: ticket!.reference, urgency: 'normal' },
      outboxId: `test-${ticket!.id}`,
    }));
    expect(outcome.posted).toBe(1);

    // Read through the inbox the resident actually uses, under their own
    // identity: a notice they cannot see is not a notice.
    const inbox = await as(residentUser, (tx) => listMyNotifications(tx, residentUser));
    const notice = inbox.find((n) => n.body.includes(ticket!.reference));
    expect(notice).toBeDefined();
    expect(notice!.title).toContain(ticket!.reference);
    expect(notice!.body).not.toContain('{{');
    expect(notice!.linkPath).toBe(`/portal/${leaseId}/requests/${ticket!.id}`);
    expect(await as(residentUser, (tx) => countUnreadNotifications(tx, residentUser)))
      .toBeGreaterThan(0);

    // The same event again writes nothing: at-least-once delivery, one
    // message.
    const again = await asWorker((tx) => dispatchEventNotice(tx, {
      organisationId: org.organisationId,
      eventType: 'maintenance.ticket.created',
      resourceType: 'maintenance_ticket',
      resourceId: ticket!.id,
      payload: { reference: ticket!.reference },
      outboxId: `test-${ticket!.id}`,
    }));
    expect(again.posted).toBe(0);
    const afterwards = await as(residentUser, (tx) => listMyNotifications(tx, residentUser));
    expect(afterwards.filter((n) => n.body.includes(ticket!.reference))).toHaveLength(1);
  });

  it('writes nothing, and says why, when nobody could read it', async () => {
    // A second lease whose resident has no portal login at all.
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Unreachable', lastName: 'Tenant',
      }));
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Silent House', code: `SIL${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '9 Silent Street', city: 'Durban',
      }));
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('7000'), depositRequiredMinor: R('7000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }));

    const outcome = await asWorker((tx) => dispatchEventNotice(tx, {
      organisationId: org.organisationId,
      eventType: 'payment.evidence.submitted',
      resourceType: 'payment_evidence',
      resourceId: null,
      payload: { leaseId: lease.leaseId, claimedAmountMinor: '700000' },
      outboxId: `test-silent-${lease.leaseId}`,
    }));
    expect(outcome.posted).toBe(0);
    expect(outcome.skipped).toMatch(/portal access/i);

    const [count] = await ownerSql()<{ n: string }[]>`
      select count(*)::text as n from notifications
       where organisation_id = ${org.organisationId}::uuid
         and dedupe_key = ${`outbox-test-silent-${lease.leaseId}:null`}
    `;
    expect(Number(count?.n)).toBe(0);
  });

  it('tells everyone who runs the organisation about Spike asking to read it', async () => {
    const outcome = await asWorker((tx) => dispatchEventNotice(tx, {
      organisationId: org.organisationId,
      eventType: 'platform.support_session.requested',
      resourceType: 'support_session',
      resourceId: null,
      payload: { reason: 'Looking at a billing query' },
      outboxId: 'test-support-1',
    }));
    expect(outcome.posted).toBeGreaterThan(0);

    const inbox = await as(org.adminUserId, (tx) => listMyNotifications(tx, org.adminUserId));
    const notice = inbox.find((n) => n.title.includes('Spike support'));
    expect(notice).toBeDefined();
    expect(notice!.linkPath).toContain('/settings/support-access');

    // The resident is not told: it is not their account.
    const residentInbox = await as(residentUser, (tx) => listMyNotifications(tx, residentUser));
    expect(residentInbox.some((n) => n.title.includes('Spike support'))).toBe(false);
  });

  it('keeps an email notice queued until a provider says otherwise', async () => {
    const [notice] = await ownerSql()<{ id: string }[]>`
      insert into notifications (
        organisation_id, channel, recipient_user_id, recipient_email, title, subject,
        body, status
      ) values (
        ${org.organisationId}, 'email', ${org.adminUserId}, 'billing@notified.invalid',
        'Your invoice is overdue', 'SPK-1 is 12 days overdue',
        'Invoice SPK-1 was due on 2026-01-01 and R1,150.00 is still outstanding.', 'queued'
      )
      returning id::text
    `;

    const waiting = await asWorker((tx) => noticesAwaitingDelivery(tx));
    expect(waiting.some((n) => n.id === notice!.id)).toBe(true);

    // The sink's answer, which is the state this product is actually in: the
    // message was taken and thrown away, and that is NOT `sent`.
    await asWorker((tx) => recordNoticeDelivery(tx, {
      notificationId: notice!.id,
      status: 'development_sink',
      provider: 'sink',
      detail: 'EMAIL_PROVIDER is not set to "smtp".',
    }));

    const [after] = await ownerSql()<{ status: string; sent_at: string | null; last_error: string }[]>`
      select status, sent_at::text, last_error from notifications where id = ${notice!.id}::uuid
    `;
    expect(after?.status).toBe('development_sink');
    expect(after?.sent_at).toBeNull();
    expect(after?.last_error).toMatch(/EMAIL_PROVIDER/);

    // And it is no longer waiting, so the pass does not try it forever.
    const stillWaiting = await asWorker((tx) => noticesAwaitingDelivery(tx));
    expect(stillWaiting.some((n) => n.id === notice!.id)).toBe(false);
  });

  it('does not spend an attempt when the provider says "ask again shortly"', async () => {
    const [notice] = await ownerSql()<{ id: string }[]>`
      insert into notifications (
        organisation_id, channel, recipient_user_id, recipient_email, title, subject,
        body, status
      ) values (
        ${org.organisationId}, 'email', ${org.adminUserId}, 'billing@notified.invalid',
        'Final notice', 'SPK-2 is 10 days overdue', 'Please settle SPK-2.', 'queued'
      )
      returning id::text
    `;

    // A rate limit is not a refusal. Four attempts is the whole budget for a
    // message, and spending one of them on "we are busy" is how real mail ends
    // up marked failed and never sent.
    await asWorker((tx) => recordNoticeDelivery(tx, {
      notificationId: notice!.id,
      status: 'failed',
      provider: 'resend',
      detail: 'Resend answered 429 (rate_limit_exceeded): Too many requests.',
      keepQueued: true,
    }));

    const [after] = await ownerSql()<{
      status: string; attempts: number; last_error: string; provider: string;
    }[]>`
      select status, attempts, last_error, provider from notifications
       where id = ${notice!.id}::uuid
    `;
    expect(after?.status).toBe('queued');
    expect(after?.attempts).toBe(0);
    // Recorded all the same, so the console says what happened rather than
    // showing a row that looks untouched.
    expect(after?.last_error).toMatch(/429/);
    expect(after?.provider).toBe('resend');

    // Still waiting, which is the point: the next pass picks it up.
    const waiting = await asWorker((tx) => noticesAwaitingDelivery(tx));
    expect(waiting.some((n) => n.id === notice!.id)).toBe(true);
  });

  it('will not store a notice nobody can read, or one with a placeholder in it', async () => {
    // The two states the old handler wrote, now refused by the database rather
    // than by whoever remembers.
    await expect(ownerSql()`
      insert into notifications (organisation_id, channel, recipient_email, title, body, status)
      values (${org.organisationId}, 'in_app', 'someone@notified.invalid',
              'Unreadable', 'Nobody can open this.', 'sent')
    `).rejects.toThrow(/in_app_notice_has_a_reader/);

    await expect(ownerSql()`
      insert into notifications (organisation_id, channel, recipient_user_id, title, body, status)
      values (${org.organisationId}, 'in_app', ${org.adminUserId},
              'Maintenance request {{reference}}', 'Logged.', 'sent')
    `).rejects.toThrow(/notice_is_rendered/);

    await expect(ownerSql()`
      insert into notifications (organisation_id, channel, recipient_user_id, title, body, status)
      values (${org.organisationId}, 'in_app', ${org.adminUserId},
              'Logged', 'Your request {{reference}} is logged.', 'sent')
    `).rejects.toThrow(/notice_is_rendered/);
  });

  it('declares the variables each template needs, derived from its own text', async () => {
    const rows = await ownerSql()<{ key: string; variables: string[]; body: string }[]>`
      select key, variables, body from notification_templates order by key
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const used = [...new Set(
        [...row.body.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]!),
      )];
      // Every placeholder in the text is declared. The reverse would be a
      // variable nobody uses, which is harmless; this direction is the one
      // that reaches a person.
      for (const name of used) expect(row.variables).toContain(name);
    }

    // And the two bodies that carried a literal backslash-n since 0008 are
    // real newlines now. Nothing had rendered them, so nobody had seen it.
    const literal = rows.filter((r) => r.body.includes('\\n'));
    expect(literal).toHaveLength(0);
  });
});
