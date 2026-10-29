/**
 * What becomes of a message after the provider accepts it.
 *
 * Until this existed, `sent` was the last thing the product ever learned.
 * Acceptance is not arrival: the mailbox may not exist, may be full, or the
 * recipient may mark the message as spam, and all of that arrives afterwards
 * by webhook. So a resident who moved out two years ago was still sent a
 * reminder every month, it was still recorded as sent, and the landlord — the
 * one person who could fix it — was never told.
 *
 * What these tests pin:
 *
 *   1. an event that cannot be verified is recorded and changes NOTHING,
 *      because otherwise anybody who can post to the endpoint can silence a
 *      landlord's own rent reminders by marking their address dead;
 *   2. a replay is refused on its timestamp, and a retry of a real event is
 *      recorded once;
 *   3. a bounce does not rewrite the send — the message WAS accepted, and
 *      `sent` stays true beside `bounced_at`;
 *   4. a hard bounce and a complaint stop future mail to that address; a SOFT
 *      bounce does not, because a full mailbox on Friday is not a dead address;
 *   5. a landlord learns their own resident's address is in trouble, in
 *      generalised words, and learns nothing about any other customer's;
 *   6. lifting is a recorded act with a person and a reason, and resends
 *      nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { withPrivilegedActor } from '@propertyos/db';
import {
  createResident, ingestEmailEvent, liftSuppression, listSuppressions,
  noticesAwaitingDelivery, residentAddressesInTrouble, suppressUndeliverableNotices,
} from '@propertyos/domain';
// From the integrations package, where the provider lives: the domain layer
// does not import an adapter, and this is the same pair the route uses.
import { readResendEvent as parse, verifyResendWebhook as verify } from '@propertyos/integrations';
import {
  addMember, as, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

const SECRET = `whsec_${Buffer.from('a-test-signing-secret-32-bytes!!').toString('base64')}`;

/** Signs a body the way the provider does, which is the only way to test that
 *  the verification accepts the real thing as well as refusing the rest. */
function sign(body: string, id = randomUUID(), at = Math.floor(Date.now() / 1000)): {
  id: string; timestamp: string; signature: string;
} {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key).update(`${id}.${at}.${body}`).digest('base64');
  return { id, timestamp: String(at), signature: `v1,${mac}` };
}

const asWorker = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
  ownerSql().begin(async (tx) => fn(tx as never));

/** An operator with a verified second factor, which platform work requires. */
const asOperator = <T>(operator: string, fn: (tx: never) => Promise<T>): Promise<T> =>
  withPrivilegedActor({ authUserId: operator, assuranceLevel: 'aal2' },
    ({ tx }) => fn(tx as never));

/** A notice the provider has already accepted, with its message id on it. */
async function sentNotice(
  org: OrganisationFixture, recipient: string, address: string, messageId: string,
): Promise<string> {
  const [row] = await ownerSql()<{ id: string }[]>`
    insert into notifications (
      organisation_id, channel, recipient_user_id, recipient_email, title, subject,
      body, status, provider, provider_message_id, sent_at, attempts
    ) values (
      ${org.organisationId}, 'email', ${recipient}, ${address},
      'Your invoice is overdue', 'SPK-1 is overdue', 'Please settle it.', 'sent',
      'resend', ${messageId}, now(), 1
    )
    returning id::text
  `;
  return row!.id;
}

describe('What becomes of a message after it is accepted', () => {
  let org: OrganisationFixture;
  let other: OrganisationFixture;

  beforeAll(async () => {
    org = await createOrganisation('Bouncing Co');
    other = await createOrganisation('Unbothered Co');
  });

  afterAll(async () => { await closeOwner(); });

  it('refuses an event it cannot verify, and refuses a replay', () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'x' } });

    expect(verify(SECRET, sign(body), body).verified).toBe(true);

    // No secret: the endpoint cannot vouch for anything, so it vouches for
    // nothing. An endpoint that accepts unsigned events is an endpoint anybody
    // can use to mark a landlord's address dead.
    const noSecret = verify(undefined, sign(body), body);
    expect(noSecret.verified).toBe(false);
    if (!noSecret.verified) expect(noSecret.reason).toMatch(/RESEND_WEBHOOK_SECRET/);

    // A body that changed after signing.
    const tampered = verify(SECRET, sign(body), `${body} `);
    expect(tampered.verified).toBe(false);

    // A signature from six minutes ago: a captured request must not be
    // replayable forever.
    const old = sign(body, randomUUID(), Math.floor(Date.now() / 1000) - 360);
    const replayed = verify(SECRET, old, body);
    expect(replayed.verified).toBe(false);
    if (!replayed.verified) expect(replayed.reason).toMatch(/replay/);

    // A secret mid-rotation signs with two, and either should pass.
    const good = sign(body);
    const rotated = verify(
      SECRET, { ...good, signature: `v1,ZGVhZGJlZWY= ${good.signature}` }, body,
    );
    expect(rotated.verified).toBe(true);
  });

  it('records an unverified event and changes nothing', async () => {
    const messageId = `msg_${randomUUID()}`;
    const noticeId = await sentNotice(org, org.adminUserId, 'unverified@bouncing.invalid', messageId);

    const outcome = await asWorker((tx) => ingestEmailEvent(tx, {
      provider: 'resend',
      providerEventId: `evt_${randomUUID()}`,
      event: parse({ type: 'email.bounced', data: { email_id: messageId, bounce: { type: 'Hard' } } }),
      payload: { forged: true },
      signatureVerified: false,
      verificationReason: 'The signature does not match.',
    }));

    expect(outcome.unverified).toBe(true);

    const [notice] = await ownerSql()<{ status: string; bounced_at: string | null }[]>`
      select status, bounced_at::text from notifications where id = ${noticeId}::uuid
    `;
    expect(notice?.bounced_at).toBeNull();

    // And nothing was suppressed, which is the attack this refuses.
    const [suppressed] = await ownerSql()<{ n: string }[]>`
      select count(*)::text as n from email_suppressions
       where address = 'unverified@bouncing.invalid'
    `;
    expect(Number(suppressed?.n)).toBe(0);

    // The event itself is kept, with why it was not acted on.
    const [recorded] = await ownerSql()<{ signature_verified: boolean; processing_result: string }[]>`
      select signature_verified, processing_result from webhook_events
       where provider = 'resend' order by received_at desc limit 1
    `;
    expect(recorded?.signature_verified).toBe(false);
    expect(recorded?.processing_result).toMatch(/not verified/);
  });

  it('records a hard bounce beside the send, and stops sending there', async () => {
    const address = `gone-${randomUUID().slice(0, 8)}@bouncing.invalid`;
    const messageId = `msg_${randomUUID()}`;
    const noticeId = await sentNotice(org, org.adminUserId, address, messageId);

    const outcome = await asWorker((tx) => ingestEmailEvent(tx, {
      provider: 'resend',
      providerEventId: `evt_${randomUUID()}`,
      event: parse({
        type: 'email.bounced',
        data: {
          email_id: messageId, to: [address],
          bounce: { type: 'Permanent', subType: 'General', message: 'The mailbox does not exist.' },
        },
      }),
      payload: {},
      signatureVerified: true,
    }));
    expect(outcome.suppressed).toBe(true);
    expect(outcome.notificationId).toBe(noticeId);

    const [notice] = await ownerSql()<{
      status: string; bounced_at: string | null; bounce_kind: string; bounce_detail: string;
      sent_at: string | null;
    }[]>`
      select status, bounced_at::text, bounce_kind, bounce_detail, sent_at::text
        from notifications where id = ${noticeId}::uuid
    `;
    // The send is NOT rewritten: the provider did accept it, and "accepted and
    // then bounced" says more than "failed".
    expect(notice?.status).toBe('sent');
    expect(notice?.sent_at).not.toBeNull();
    expect(notice?.bounced_at).not.toBeNull();
    expect(notice?.bounce_kind).toBe('hard');
    expect(notice?.bounce_detail).toContain('does not exist');

    // Nothing queued for that address will go out, and it does not sit queued
    // forever either.
    const [queued] = await ownerSql()<{ id: string }[]>`
      insert into notifications (
        organisation_id, channel, recipient_user_id, recipient_email, title, subject, body, status
      ) values (
        ${org.organisationId}, 'email', ${org.adminUserId}, ${address},
        'Final notice', 'SPK-2 is overdue', 'Please settle it.', 'queued'
      )
      returning id::text
    `;
    const waiting = await asWorker((tx) => noticesAwaitingDelivery(tx, { limit: 200 }));
    expect(waiting.some((n) => n.id === queued!.id)).toBe(false);

    const { suppressed } = await asWorker((tx) => suppressUndeliverableNotices(tx));
    expect(suppressed).toBeGreaterThan(0);
    const [after] = await ownerSql()<{ status: string; last_error: string }[]>`
      select status, last_error from notifications where id = ${queued!.id}::uuid
    `;
    expect(after?.status).toBe('suppressed');
    expect(after?.last_error).toMatch(/hard_bounce/);
  });

  it('does not suppress on a soft bounce, which is only today trouble', async () => {
    const address = `full-${randomUUID().slice(0, 8)}@bouncing.invalid`;
    const messageId = `msg_${randomUUID()}`;
    await sentNotice(org, org.adminUserId, address, messageId);

    const outcome = await asWorker((tx) => ingestEmailEvent(tx, {
      provider: 'resend',
      providerEventId: `evt_${randomUUID()}`,
      event: parse({
        type: 'email.bounced',
        data: {
          email_id: messageId, to: [address],
          bounce: { type: 'Transient', subType: 'MailboxFull', message: 'Mailbox full.' },
        },
      }),
      payload: {},
      signatureVerified: true,
    }));
    // Recorded, so an operator can see it, and NOT suppressed: a mailbox full
    // on Friday is not a dead address, and stopping a landlord's mail over a
    // weekend because of one is worse than the bounce.
    expect(outcome.suppressed).toBe(false);
    const [row] = await ownerSql()<{ n: string }[]>`
      select count(*)::text as n from email_suppressions where address = ${address}
    `;
    expect(Number(row?.n)).toBe(0);
  });

  it('acts once on an event the provider sends twice', async () => {
    const address = `twice-${randomUUID().slice(0, 8)}@bouncing.invalid`;
    const messageId = `msg_${randomUUID()}`;
    await sentNotice(org, org.adminUserId, address, messageId);
    const eventId = `evt_${randomUUID()}`;
    const event = parse({
      type: 'email.bounced',
      data: { email_id: messageId, to: [address], bounce: { type: 'Permanent' } },
    });

    const first = await asWorker((tx) => ingestEmailEvent(tx, {
      provider: 'resend', providerEventId: eventId, event, payload: {}, signatureVerified: true,
    }));
    const second = await asWorker((tx) => ingestEmailEvent(tx, {
      provider: 'resend', providerEventId: eventId, event, payload: {}, signatureVerified: true,
    }));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const [rows] = await ownerSql()<{ n: string }[]>`
      select count(*)::text as n from email_suppressions where address = ${address}
    `;
    expect(Number(rows?.n)).toBe(1);
  });

  it('counts a second bounce on an address already suppressed', async () => {
    const address = `again-${randomUUID().slice(0, 8)}@bouncing.invalid`;
    for (const _ of [1, 2]) {
      const messageId = `msg_${randomUUID()}`;
      await sentNotice(org, org.adminUserId, address, messageId);
      await asWorker((tx) => ingestEmailEvent(tx, {
        provider: 'resend',
        providerEventId: `evt_${randomUUID()}`,
        event: parse({
          type: 'email.bounced',
          data: { email_id: messageId, to: [address], bounce: { type: 'Permanent' } },
        }),
        payload: {}, signatureVerified: true,
      }));
    }
    const [row] = await ownerSql()<{ events: number; n: string }[]>`
      select events, count(*) over ()::text as n from email_suppressions
       where address = ${address} and lifted_at is null
    `;
    expect(Number(row?.n)).toBe(1);
    expect(row?.events).toBe(2);
  });

  it('tells a landlord about their own resident, in words that name nobody else', async () => {
    const address = `tenant-${randomUUID().slice(0, 8)}@bouncing.invalid`;

    // A resident of one customer, with that address.
    await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Bounced', lastName: 'Tenant', email: address,
      }));

    // The person complained — about a message from this customer or another,
    // which is exactly the thing the generalised wording hides.
    await ownerSql()`
      insert into email_suppressions (address, kind, reason)
      values (${address}, 'complaint', 'The recipient marked the message as spam.')
      on conflict (address) where lifted_at is null do nothing
    `;

    const mine = await as(org.adminUserId, (tx) =>
      residentAddressesInTrouble(tx, org.organisationId));
    const found = mine.find((r) => r.address === address);
    expect(found).toBeDefined();
    // "asked not to receive" — true, actionable, and it names no other
    // customer and no complaint.
    expect(found!.trouble).toBe('asked_not_to_receive');

    // The other customer learns nothing, even asking about the same address:
    // the function answers only for addresses on the asker's own residents, so
    // it cannot be used to ask whether a stranger has complained.
    const theirs = await as(other.adminUserId, (tx) =>
      residentAddressesInTrouble(tx, other.organisationId));
    expect(theirs.some((r) => r.address === address)).toBe(false);

    // And nobody in a customer organisation can read the list itself.
    const blind = await as(org.adminUserId, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from email_suppressions`);
    expect(Number(blind[0]?.n)).toBe(0);

    // Not even a member who cannot read residents can use the function.
    const caretaker = await addMember(org.organisationId, 'No Resident Access', ['contractor']);
    const nothing = await as(caretaker, (tx) =>
      residentAddressesInTrouble(tx, org.organisationId));
    expect(nothing).toHaveLength(0);
  });

  it('lifts a suppression with a person and a reason, and resends nothing', async () => {
    const operator = await createAuthUser('Suppression Operator', {
      platformOperator: true, platformRoles: ['platform_admin'],
    });
    await ownerSql()`
      insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
      values (${operator}, 'totp', 'JBSWY3DPEHPK3PXP', now())
      on conflict (auth_user_id, factor_type) do update set verified_at = now()
    `;

    const address = `fixed-${randomUUID().slice(0, 8)}@bouncing.invalid`;
    const [row] = await ownerSql()<{ id: string }[]>`
      insert into email_suppressions (address, kind, reason, organisation_id)
      values (${address}, 'hard_bounce', 'The mailbox does not exist.', ${org.organisationId})
      returning id::text
    `;

    // A suppressed notice from before the lift, which must stay suppressed.
    const [stale] = await ownerSql()<{ id: string }[]>`
      insert into notifications (
        organisation_id, channel, recipient_user_id, recipient_email, title, body,
        status, last_error
      ) values (
        ${org.organisationId}, 'email', ${org.adminUserId}, ${address},
        'An old reminder', 'Please settle it.', 'suppressed', 'Not sent: hard_bounce'
      )
      returning id::text
    `;

    await asOperator(operator, (tx) => liftSuppression(tx, operator, {
      suppressionId: row!.id, reason: 'Landlord confirmed the mailbox was restored',
    }));

    const live = await asOperator(operator, (tx) => listSuppressions(tx, operator));
    expect(live.some((s) => s.address === address)).toBe(false);

    const history = await asOperator(operator,
      (tx) => listSuppressions(tx, operator, { includeLifted: true }));
    const lifted = history.find((s) => s.address === address);
    expect(lifted?.liftedReason).toContain('mailbox was restored');
    expect(lifted?.liftedByName).toBe('Suppression Operator');

    // Lifting does not resend: a three-month-old rent reminder going out
    // because an address came back is not what anybody meant.
    const [unchanged] = await ownerSql()<{ status: string }[]>`
      select status from notifications where id = ${stale!.id}::uuid
    `;
    expect(unchanged?.status).toBe('suppressed');

    // A reason is required, and the row is already lifted, so both refusals.
    await expect(asOperator(operator, (tx) => liftSuppression(tx, operator, {
      suppressionId: row!.id, reason: 'no',
    }))).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(asOperator(operator, (tx) => liftSuppression(tx, operator, {
      suppressionId: row!.id, reason: 'Trying it a second time',
    }))).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('records a delivery, which is a different fact from being sent', async () => {
    const messageId = `msg_${randomUUID()}`;
    const noticeId = await sentNotice(
      org, org.adminUserId, `ok-${randomUUID().slice(0, 8)}@bouncing.invalid`, messageId,
    );

    await asWorker((tx) => ingestEmailEvent(tx, {
      provider: 'resend',
      providerEventId: `evt_${randomUUID()}`,
      event: parse({ type: 'email.delivered', data: { email_id: messageId } }),
      payload: {}, signatureVerified: true,
    }));

    const [notice] = await ownerSql()<{ delivered_at: string | null; status: string }[]>`
      select delivered_at::text, status from notifications where id = ${noticeId}::uuid
    `;
    // `sent_at` was when OUR provider took it; `delivered_at` is when the
    // receiving server did. Two different claims, and only one of them means
    // it arrived.
    expect(notice?.delivered_at).not.toBeNull();
    expect(notice?.status).toBe('sent');
  });

  it('does not throw on an event shape it does not know', async () => {
    const outcome = await asWorker((tx) => ingestEmailEvent(tx, {
      provider: 'resend',
      providerEventId: `evt_${randomUUID()}`,
      event: parse({ type: 'email.opened', data: { email_id: 'nothing-matches-this' } }),
      payload: {}, signatureVerified: true,
    }));
    expect(outcome.summary).toMatch(/no action/);

    // And on nothing at all, because a webhook handler that throws on a
    // changed payload is a webhook handler that retries forever.
    const empty = parse(undefined);
    expect(empty.kind).toBe('other');
    expect(empty.providerMessageId).toBeNull();
  });
});
