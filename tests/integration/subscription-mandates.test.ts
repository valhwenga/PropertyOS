/**
 * A customer's standing authority for Spike to collect by debit order.
 *
 * The authorisation record is the regulated artefact here: it is what you must
 * be able to produce if a payer disputes a debit, and it is the thing that
 * must be impossible to fabricate after the fact. So these tests are mostly
 * about what cannot be done to it.
 *
 * What they pin:
 *
 *   1. a request authorises nothing — it is `requested` until the payer's bank
 *      says otherwise, and the insert policy refuses a row that claims more;
 *   2. only a VERIFIED provider event can authenticate one, asserted against
 *      the database rather than through the code that is supposed to be
 *      careful;
 *   3. the terms a payer agreed to cannot be edited, at all, by anybody;
 *   4. one live mandate per customer, so two authorities never exist over one
 *      account;
 *   5. the payer can withdraw it, and a withdrawal arriving unprompted from
 *      their own bank is recorded as theirs;
 *   6. the account number is sealed, and the last four are all a screen gets.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withPrivilegedActor } from '@propertyos/db';
import {
  cancelMandate, ingestMandateEvent, liveMandate, openMandateAccountNumber,
  organisationMandates, requestMandate, type IncomingMandateEvent,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const PROVIDER = 'sandbox';
const ACCOUNT = '62001234567';

function mandateEvent(
  reference: string,
  status: IncomingMandateEvent['status'],
  eventId = `mevt-${randomUUID().slice(0, 12)}`,
): IncomingMandateEvent {
  return {
    providerEventId: eventId,
    eventType: `mandate.${status}`,
    reference,
    providerReference: `dc-${randomUUID().slice(0, 8)}`,
    status,
    reason: status === 'rejected' ? 'The payer declined it in their banking app' : null,
  };
}

const ingest = (event: IncomingMandateEvent | null, verified = true) =>
  ownerSql().begin(async (tx) => ingestMandateEvent(tx as never, {
    provider: PROVIDER, signatureVerified: verified, payload: { raw: 'as it arrived' }, event,
  }));

const request = (org: OrganisationFixture, authUserId: string, amountMinor = 150_000) =>
  as(authUserId, (tx) => requestMandate(tx, authUserId, {
    organisationId: org.organisationId,
    provider: PROVIDER,
    authorisedAmountMinor: amountMinor,
    currencyCode: 'ZAR',
    collectionDay: 1,
    firstCollectionOn: '2026-12-01',
    accountHolder: 'Mandated Properties (Pty) Ltd',
    bankName: 'Standard Bank',
    branchCode: '051001',
    accountType: 'cheque',
    accountNumber: ACCOUNT,
  }));

describe('a mandate to collect', () => {
  let org: OrganisationFixture;
  let member: string;

  beforeAll(async () => {
    org = await createOrganisation('Mandated Properties', { planKey: 'starter' });
    member = await addMember(org.organisationId, 'Ordinary Member', ['property_manager']);
  });

  beforeEach(async () => {
    await ownerSql()`
      delete from subscription_mandates where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`delete from webhook_events where provider = ${PROVIDER}`;
  });

  afterAll(async () => {
    await ownerSql()`
      delete from subscription_mandates where organisation_id = ${org.organisationId}::uuid
    `;
    await ownerSql()`delete from webhook_events where provider = ${PROVIDER}`;
    await closeOwner();
  });

  it('requests one that authorises nothing yet', async () => {
    const { reference } = await request(org, org.adminUserId);
    expect(reference).toMatch(/^MAN-/);

    const mandate = await as(org.adminUserId, (tx) => liveMandate(tx, org.organisationId));
    expect(mandate?.status).toBe('requested');
    expect(mandate?.authenticatedAt).toBeNull();
    expect(mandate?.authorisedAmountMinor).toBe(150_000);
    expect(mandate?.collectionDay).toBe(1);

    // The account number is sealed. What a screen gets is four digits.
    expect(mandate?.accountNumberLast4).toBe('4567');
    expect(JSON.stringify(mandate)).not.toContain(ACCOUNT);

    const [stored] = await ownerSql()<{ cipher: string }[]>`
      select encode(account_number_cipher, 'hex') as cipher from subscription_mandates
      where reference = ${reference}
    `;
    expect(stored?.cipher).toBeTruthy();
    expect(stored?.cipher).not.toContain(Buffer.from(ACCOUNT).toString('hex'));

    // And the one caller that needs the whole thing can still have it.
    const opened = await ownerSql().begin(async (tx) =>
      openMandateAccountNumber(tx as never, mandate!.id));
    expect(opened).toBe(ACCOUNT);
  });

  it('is refused to somebody who does not administer the account', async () => {
    await expect(request(org, member)).rejects.toThrow();
  });

  it('cannot be inserted already authenticated', async () => {
    // Straight at the table as the administrator, bypassing the domain: the
    // insert policy has to refuse the shape.
    await expect(as(org.adminUserId, (tx) => tx`
      insert into subscription_mandates (
        organisation_id, provider, reference, authorised_amount_minor, currency_code,
        collection_day, first_collection_on, account_holder, bank_name, branch_code,
        account_type, account_number_cipher, account_number_last4, status, requested_by,
        authenticated_at
      ) values (
        ${org.organisationId}::uuid, ${PROVIDER}, 'MAN-FORGED', 150000, 'ZAR', 1,
        '2026-12-01'::date, 'Forged', 'Standard Bank', '051001', 'cheque',
        '\\x00'::bytea, '4567', 'authenticated', ${org.adminUserId}::uuid, now()
      )
    `)).rejects.toThrow();
  });

  it('is authenticated only by a verified event', async () => {
    const { reference } = await request(org, org.adminUserId);

    // Unverified: recorded, changes nothing.
    expect(await ingest(mandateEvent(reference, 'authenticated'), false))
      .toMatchObject({ outcome: 'unverified' });
    let mandate = await as(org.adminUserId, (tx) => liveMandate(tx, org.organisationId));
    expect(mandate?.status).toBe('requested');

    // The database refuses the state directly too, not just this path.
    const [unverified] = await ownerSql()<{ id: string }[]>`
      select id::text from webhook_events where signature_verified = false limit 1
    `;
    await expect(ownerSql()`
      update subscription_mandates
         set status = 'authenticated', authenticated_at = now(),
             authentication_event_id = ${unverified!.id}::uuid
       where reference = ${reference}
    `).rejects.toThrow(/signature was verified/i);

    // Verified: authority exists.
    const event = mandateEvent(reference, 'authenticated');
    expect(await ingest(event)).toMatchObject({ outcome: 'recorded', status: 'authenticated' });
    mandate = await as(org.adminUserId, (tx) => liveMandate(tx, org.organisationId));
    expect(mandate?.status).toBe('authenticated');
    expect(mandate?.authenticatedAt).toBeTruthy();
    expect(mandate?.providerReference).toBe(event.providerReference);

    // A replay settles nothing new.
    expect(await ingest(event)).toMatchObject({ outcome: 'duplicate' });
  });

  it('will not let anybody change what the payer agreed to', async () => {
    const { reference } = await request(org, org.adminUserId);
    await ingest(mandateEvent(reference, 'authenticated'));

    for (const [field, change] of [
      ['the amount', ownerSql()`
        update subscription_mandates set authorised_amount_minor = 900000
        where reference = ${reference}`],
      ['the day', ownerSql()`
        update subscription_mandates set collection_day = 25 where reference = ${reference}`],
      ['the account', ownerSql()`
        update subscription_mandates set account_number_cipher = '\\x01'::bytea
        where reference = ${reference}`],
    ] as const) {
      await expect(change, field).rejects.toThrow(/terms cannot be changed/i);
    }

    const mandate = await as(org.adminUserId, (tx) => liveMandate(tx, org.organisationId));
    expect(mandate?.authorisedAmountMinor).toBe(150_000);
    expect(mandate?.collectionDay).toBe(1);
  });

  it('allows one live mandate at a time, and a replacement after cancelling', async () => {
    const first = await request(org, org.adminUserId);
    await ingest(mandateEvent(first.reference, 'authenticated'));

    await expect(request(org, org.adminUserId)).rejects.toThrow(/already has a live/i);

    // Cancelling is the payer withdrawing authority, and is recorded as
    // theirs. Run the way the Server Action runs it: privileged, because the
    // table has no UPDATE policy for the application role, but with the
    // caller's own identity still on the transaction so the permission check
    // in `cancelMandate` is a real one.
    await withPrivilegedActor(
      { authUserId: org.adminUserId, assuranceLevel: 'aal2' },
      async ({ tx }) => cancelMandate(tx as never, org.adminUserId, {
        mandateId: (await liveMandate(tx as never, org.organisationId))!.id,
        reason: 'Changing to the new business account',
      }),
    );

    const cancelled = (await as(org.adminUserId, (tx) =>
      organisationMandates(tx, org.organisationId)))[0];
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelledByPayer).toBe(true);
    expect(cancelled?.cancellationReason).toContain('new business account');

    // And now another may be requested.
    const second = await request(org, org.adminUserId, 200_000);
    expect(second.reference).not.toBe(first.reference);
    const history = await as(org.adminUserId, (tx) =>
      organisationMandates(tx, org.organisationId));
    expect(history).toHaveLength(2);
  });

  it('records a withdrawal that arrives from the payer own bank', async () => {
    const { reference } = await request(org, org.adminUserId);
    await ingest(mandateEvent(reference, 'authenticated'));

    // A payer can cancel a debit order authority at their bank without telling
    // the beneficiary. Arriving unprompted is normal, not an anomaly.
    expect(await ingest(mandateEvent(reference, 'cancelled')))
      .toMatchObject({ outcome: 'recorded', status: 'cancelled' });

    const mandate = (await as(org.adminUserId, (tx) =>
      organisationMandates(tx, org.organisationId)))[0];
    expect(mandate?.status).toBe('cancelled');
    expect(mandate?.cancelledByPayer).toBe(true);
    expect(mandate?.cancellationReason).toMatch(/their bank/i);
  });

  it('records a rejection with the reason the bank gave', async () => {
    const { reference } = await request(org, org.adminUserId);
    expect(await ingest(mandateEvent(reference, 'rejected')))
      .toMatchObject({ outcome: 'recorded', status: 'rejected' });

    const mandate = (await as(org.adminUserId, (tx) =>
      organisationMandates(tx, org.organisationId)))[0];
    expect(mandate?.status).toBe('rejected');
    expect(mandate?.rejectionReason).toContain('declined it in their banking app');

    // A rejected mandate is not live, so another may be requested.
    await expect(request(org, org.adminUserId)).resolves.toBeTruthy();
  });

  it('keeps an event for a reference it has never heard of', async () => {
    expect(await ingest(mandateEvent('MAN-not-ours', 'authenticated')))
      .toMatchObject({ outcome: 'unknown_reference' });
  });
});
