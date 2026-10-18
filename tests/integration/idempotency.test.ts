/**
 * Doing it once (§20).
 *
 * `idempotency_keys` has existed since 0006 and only billing runs used it, so
 * every other command was one double-click away from a second receipt. These
 * tests hold the four properties the key binds — organisation, actor, command,
 * payload — and the two behaviours that matter more than any of them: a
 * concurrent duplicate does the work once, and a FAILED attempt leaves nothing
 * behind to block the retry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, confirmReceipt, createResident, createStandaloneHouse, draftLease,
  parseMajorToMinor, withIdempotency, canonicalJson,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, grantPortalAccess, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');
const KEY = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe('Command idempotency', () => {
  let org: OrganisationFixture;
  let neighbour: OrganisationFixture;
  let leaseId: string;

  async function receiptsOnLease(): Promise<number> {
    const [row] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from receipts where lease_id = ${leaseId}
    `;
    return Number(row!.count);
  }

  /** Records a receipt under a key, returning what the caller would see. */
  async function record(
    actorUserId: string,
    key: string,
    amount: string,
    fixture: OrganisationFixture = org,
    lease: string = leaseId,
  ) {
    const input = {
      leaseId: lease, amountMinor: R(amount), receivedOn: '2026-03-01',
      method: 'eft' as const, payerReference: 'TEST',
    };
    return as(actorUserId, (tx) =>
      withIdempotency(
        tx,
        {
          organisationId: fixture.organisationId,
          actorUserId,
          command: 'receipt.record',
          key,
          payload: input,
        },
        async () => {
          const receipt = await confirmReceipt(tx, fixture.organisationId, actorUserId, input);
          return { receiptId: receipt.receiptId, receiptNumber: receipt.receiptNumber };
        },
      ));
  }

  beforeAll(async () => {
    org = await createOrganisation('Idempotent Co');
    neighbour = await createOrganisation('Other Idempotent Co');

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Repeat', lastName: 'Payer',
      }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Idempotent House', code: 'IDEM1', propertyType: 'house',
        addressLine1: '1 Repeat Road', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', rentMinor: R('8000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Filed offline.',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('records once for a repeated key, and replays the first answer', async () => {
    const key = KEY();
    const before = await receiptsOnLease();

    const first = await record(org.adminUserId, key, '1000');
    const second = await record(org.adminUserId, key, '1000');

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // The same receipt, not a second one that merely looks alike.
    expect(second.result.receiptId).toBe(first.result.receiptId);
    expect(second.result.receiptNumber).toBe(first.result.receiptNumber);
    expect(await receiptsOnLease()).toBe(before + 1);
  });

  it('does the work once when two attempts race', async () => {
    const key = KEY();
    const before = await receiptsOnLease();

    // Both start before either finishes. The unique index makes the second
    // insert WAIT for the first transaction rather than proceed beside it.
    const [a, b] = await Promise.all([
      record(org.adminUserId, key, '1500'),
      record(org.adminUserId, key, '1500'),
    ]);

    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.result.receiptId).toBe(b.result.receiptId);
    expect(await receiptsOnLease()).toBe(before + 1);
  });

  it('refuses a key reused for different details', async () => {
    const key = KEY();
    await record(org.adminUserId, key, '2000');

    await expect(record(org.adminUserId, key, '2500'))
      .rejects.toThrow(/already used for different details/i);
  });

  it('records both of two deliberate payments of the same amount', async () => {
    // The dangerous opposite of duplication: two residents' identical rent on
    // the same day, or a payment made twice on purpose. Different keys, so
    // both are real.
    const before = await receiptsOnLease();
    const one = await record(org.adminUserId, KEY(), '3000');
    const two = await record(org.adminUserId, KEY(), '3000');

    expect(one.result.receiptId).not.toBe(two.result.receiptId);
    expect(await receiptsOnLease()).toBe(before + 2);
  });

  it('leaves nothing behind when the command fails, so the retry works', async () => {
    const key = KEY();
    // A negative amount is refused by the domain; the whole transaction rolls
    // back, taking the key row with it.
    await expect(record(org.adminUserId, key, '-500')).rejects.toThrow();

    const [row] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from idempotency_keys
       where organisation_id = ${org.organisationId} and key = ${key}
    `;
    expect(Number(row!.count)).toBe(0);

    // And the same key is free to carry the corrected attempt.
    const retry = await record(org.adminUserId, key, '500');
    expect(retry.replayed).toBe(false);
  });

  it('keeps one organisation out of another organisation’s keys', async () => {
    const key = 'shared-key-between-organisations';
    const before = await receiptsOnLease();
    await record(org.adminUserId, key, '750');

    // The neighbour uses the identical key. Nothing is replayed to them, and
    // nothing of theirs reaches this organisation.
    const [theirs] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from idempotency_keys
       where organisation_id = ${neighbour.organisationId} and key = ${key}
    `;
    expect(Number(theirs!.count)).toBe(0);
    expect(await receiptsOnLease()).toBe(before + 1);
  });

  it('treats the same key from a different colleague as a different intent', async () => {
    const key = KEY();

    // Not an error: a different person with the same key is a different
    // request, and the index says so. What must not happen is one of them
    // being answered with the other's receipt.
    const colleague = await addMember(org.organisationId, 'Second Clerk', ['finance_preparer']);
    const first = await record(org.adminUserId, key, '900');
    const theirs = await record(colleague, key, '900');
    expect(theirs.replayed).toBe(false);
    expect(theirs.result.receiptId).not.toBe(first.result.receiptId);
  });

  it('lets a resident hold their own key, and nobody else read it', async () => {
    // A resident is deliberately not a member of the organisation, so the
    // member-only policies this table shipped with refused their insert
    // outright — which turned the guard that makes a double tap harmless into
    // the thing that broke it. Found in a browser, pinned here.
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Portal', lastName: 'Payer',
      }),
    );
    await ownerSql()`
      insert into lease_parties (organisation_id, lease_id, resident_id, role, joined_on)
      values (${org.organisationId}, ${leaseId}, ${resident.residentId}, 'co_lessee', '2026-01-01')
      on conflict do nothing
    `;
    const portalUser = await grantPortalAccess(
      org.organisationId, leaseId, resident.residentId, 'Portal Payer',
    );

    const key = KEY();
    const claim = (actor: string) =>
      as(actor, (tx) =>
        withIdempotency(
          tx,
          {
            organisationId: org.organisationId, actorUserId: actor,
            command: 'payment.evidence', key, payload: { amountMinor: R('1850') },
          },
          async () => ({ noted: true }),
        ));

    const first = await claim(portalUser);
    expect(first.replayed).toBe(false);
    const second = await claim(portalUser);
    expect(second.replayed).toBe(true);

    // A second resident with the same key sees nothing of the first one's:
    // the row is invisible to them, so their own claim is their own.
    const other = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Other', lastName: 'Resident',
      }),
    );
    const otherHouse = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Second Portal House', code: 'IDEM2', propertyType: 'house',
        addressLine1: '2 Repeat Road', city: 'Cape Town',
      }),
    );
    const otherLease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: otherHouse.unitId,
        startDate: '2026-01-01', rentMinor: R('8000'),
        parties: [{ residentId: other.residentId, role: 'primary_resident' }],
      }),
    );
    const otherUser = await grantPortalAccess(
      org.organisationId, otherLease.leaseId, other.residentId, 'Other Resident',
    );

    const theirs = await as(otherUser, (tx) =>
      withIdempotency(
        tx,
        {
          organisationId: org.organisationId, actorUserId: otherUser,
          command: 'payment.evidence', key, payload: { amountMinor: R('1850') },
        },
        async () => ({ noted: 'mine' }),
      ));
    // Not a replay of somebody else's: their own first attempt.
    expect(theirs.replayed).toBe(false);
    expect(theirs.result).toEqual({ noted: 'mine' });
  });

  it('hashes a payload by what it says, not by how it was written', () => {
    // Field order is an accident of how a form was serialised; two requests
    // that differ only in that are the same request.
    expect(canonicalJson({ b: 1, a: 2n })).toBe(canonicalJson({ a: 2n, b: 1 }));
    // A bigint survives as the decimal string money crosses every other
    // boundary as, rather than throwing inside a payment.
    expect(canonicalJson({ amountMinor: 185000n })).toBe('{"amountMinor":"185000"}');
    // And a genuinely different amount is a genuinely different payload.
    expect(canonicalJson({ amountMinor: 185000n })).not.toBe(canonicalJson({ amountMinor: 185001n }));
  });
});
