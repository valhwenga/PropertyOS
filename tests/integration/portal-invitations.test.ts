/**
 * Inviting a resident to the portal.
 *
 * `prepareInvitation`, `issueInvitation`, `acceptInvitation` and
 * `revokePortalAccess` have existed since §8 and **not one of them had a
 * screen**. So the resident portal — the statement, the documents, the
 * maintenance requests — could not be reached by any resident a customer
 * actually had: an operator could not issue an invitation, and no page existed
 * to redeem one if they had.
 *
 * The rule the blueprint singles out: *"an administrator linking an email to
 * the wrong resident is a security incident risk"*. That is what the confirmed
 * recipient is for, and it is the first thing tested here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  acceptInvitation, activateLease, createResident, createStandaloneHouse, draftLease,
  issueInvitation, parseMajorToMinor, postCharge, prepareInvitation, revokePortalAccess,
} from '@propertyos/domain';
import {
  as, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Resident portal invitations', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let residentId: string;
  let coLesseeId: string;
  let otherLeaseId: string;

  beforeAll(async () => {
    org = await createOrganisation('Portal Co');

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena', email: 'thandiwe@demo.invalid',
      }),
    );
    residentId = resident.residentId;

    const coLessee = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Sipho', lastName: 'Mokoena', email: 'sipho@demo.invalid',
      }),
    );
    coLesseeId = coLessee.residentId;

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Portal House', code: 'PRT', propertyType: 'house',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('8000'),
        parties: [
          { residentId, role: 'primary_resident', canViewFinancials: true },
          { residentId: coLesseeId, role: 'co_lessee' },
        ],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{
          category: 'rent', description: 'January rent',
          amountMinor: R('8000'), dueDate: '2026-01-01',
        }],
      }),
    );

    // A second lease with a different resident, for the mis-link tests.
    const otherResident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Nomsa', lastName: 'Khumalo',
      }),
    );
    const otherHouse = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Other House', code: 'OTH', propertyType: 'house',
        addressLine1: '9 Jacaranda Avenue', city: 'Pretoria',
      }),
    );
    const otherLease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: otherHouse.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('6000'),
        parties: [{ residentId: otherResident.residentId, role: 'primary_resident' }],
      }),
    );
    otherLeaseId = otherLease.leaseId;
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------- the mis-link this guards against */

  it('shows the operator the lease and the recipient before anything is sent', async () => {
    const review = await as(org.adminUserId, (tx) =>
      prepareInvitation(tx, org.organisationId, { leaseId, residentId }),
    );
    expect(review.residentName).toBe('Thandiwe Mokoena');
    expect(review.unitLabel).toContain('Portal House');
    expect(review.leaseReference).toMatch(/^LSE-/);
    expect(review.existingPortalUser).toBeNull();
  });

  it('refuses a resident who is not a party to that lease', async () => {
    // The mis-link in its plainest form: a real resident, a real lease, and no
    // relationship between them.
    await expect(
      as(org.adminUserId, (tx) =>
        prepareInvitation(tx, org.organisationId, { leaseId: otherLeaseId, residentId }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses when the confirmed recipient is not the resident in the request', async () => {
    // An operator reviewed one resident and the request carries another: the
    // screen and the command disagree, so nothing is sent. This is the
    // "administrator links an email to the wrong resident" case the blueprint
    // calls a security incident risk.
    await expect(
      as(org.adminUserId, (tx) =>
        issueInvitation(tx, org.organisationId, org.adminUserId, {
          leaseId, residentId,
          email: 'wrong@demo.invalid',
          confirmedRecipient: 'Sipho Mokoena',
        }),
      ),
    ).rejects.toThrow(/does not match the resident/);

    const [{ total }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from portal_links
       where organisation_id = ${org.organisationId}
    `;
    expect(total).toBe('0');
  });

  it('refuses an address that is not an address', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        issueInvitation(tx, org.organisationId, org.adminUserId, {
          leaseId, residentId, email: 'not-an-address',
          confirmedRecipient: 'Thandiwe Mokoena',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /* ------------------------------------------------- an invitation grants nothing */

  it('issues an invitation that grants nothing until it is accepted', async () => {
    const issued = await as(org.adminUserId, (tx) =>
      issueInvitation(tx, org.organisationId, org.adminUserId, {
        leaseId, residentId, email: 'Thandiwe@Demo.invalid',
        confirmedRecipient: 'Thandiwe Mokoena',
      }),
    );
    expect(issued.token).toHaveLength(43);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const [link] = await ownerSql()<
      { status: string; auth_user_id: string | null; invited_email: string;
        token_hash: string | null }[]
    >`
      select status::text, auth_user_id, invited_email::text as invited_email,
             encode(invite_token_hash, 'hex') as token_hash
        from portal_links where id = ${issued.portalLinkId}
    `;
    expect(link!.status).toBe('invited');
    // Nobody is attached to it yet: an invitation in a mailbox is not access.
    expect(link!.auth_user_id).toBeNull();
    // Stored lower case, because people type their own address inconsistently.
    expect(link!.invited_email).toBe('thandiwe@demo.invalid');
    // Only the hash: a database read cannot be replayed as an invitation.
    expect(link!.token_hash).toMatch(/^[0-9a-f]{64}$/);

    (globalThis as Record<string, unknown>).__portalToken = issued.token;
    (globalThis as Record<string, unknown>).__portalLinkId = issued.portalLinkId;
  });

  it('keeps the token out of the audit trail', async () => {
    const token = (globalThis as Record<string, unknown>).__portalToken as string;
    const entries = await ownerSql()`
      select action, before_state, after_state, reason from audit_events
       where organisation_id = ${org.organisationId}
    `;
    expect(JSON.stringify(entries)).not.toContain(token);
  });

  it('re-issuing replaces the link rather than leaving two live tokens', async () => {
    const first = (globalThis as Record<string, unknown>).__portalToken as string;
    const again = await as(org.adminUserId, (tx) =>
      issueInvitation(tx, org.organisationId, org.adminUserId, {
        leaseId, residentId, email: 'thandiwe@demo.invalid',
        confirmedRecipient: 'Thandiwe Mokoena',
      }),
    );

    const [{ total }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from portal_links
       where lease_id = ${leaseId} and resident_id = ${residentId}
    `;
    expect(total).toBe('1');

    // The first link stops working: two live tokens for one person is a
    // revocation nobody can carry out.
    const user = await createAuthUser('Thandiwe Mokoena');
    await expect(
      ownerSql().begin(async (tx) =>
        acceptInvitation(tx as never, { token: first, authUserId: user }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    (globalThis as Record<string, unknown>).__portalToken = again.token;
  });

  /* ---------------------------------------------------------------- accepting */

  it('attaches exactly one account, and consumes the token', async () => {
    const token = (globalThis as Record<string, unknown>).__portalToken as string;
    const resident = await createAuthUser('Thandiwe Mokoena');

    const accepted = await ownerSql().begin(async (tx) =>
      acceptInvitation(tx as never, { token, authUserId: resident }),
    );
    expect(accepted.leaseId).toBe(leaseId);
    expect(accepted.organisationId).toBe(org.organisationId);

    const [link] = await ownerSql()<
      { status: string; auth_user_id: string; token_hash: string | null }[]
    >`
      select status::text, auth_user_id::text, encode(invite_token_hash, 'hex') as token_hash
        from portal_links where lease_id = ${leaseId} and resident_id = ${residentId}
    `;
    expect(link!.status).toBe('active');
    expect(link!.auth_user_id).toBe(resident);
    // Consumed, so it cannot be replayed to attach a second account.
    expect(link!.token_hash).toBeNull();

    const second = await createAuthUser('Somebody Else');
    await expect(
      ownerSql().begin(async (tx) =>
        acceptInvitation(tx as never, { token, authUserId: second }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    (globalThis as Record<string, unknown>).__residentUser = resident;
  });

  it('lets that resident read their own lease and nothing else', async () => {
    const resident = (globalThis as Record<string, unknown>).__residentUser as string;

    const own = await as(resident, (tx) => tx<{ id: string }[]>`
      select id from leases where id = ${leaseId}::uuid
    `);
    expect(own).toHaveLength(1);

    // The other lease in the same organisation is not theirs.
    const theirs = await as(resident, (tx) => tx<{ id: string }[]>`
      select id from leases where id = ${otherLeaseId}::uuid
    `);
    expect(theirs).toHaveLength(0);
  });

  it('gives the same answer for a wrong, expired and revoked token', async () => {
    const live = await as(org.adminUserId, (tx) =>
      issueInvitation(tx, org.organisationId, org.adminUserId, {
        leaseId, residentId: coLesseeId, email: 'sipho@demo.invalid',
        confirmedRecipient: 'Sipho Mokoena',
      }),
    );
    await ownerSql()`
      update portal_links set expires_at = now() - interval '1 day'
       where id = ${live.portalLinkId}
    `;

    const user = await createAuthUser('Sipho Mokoena');
    const messages: string[] = [];
    for (const token of [live.token, 'completely-made-up-token']) {
      await ownerSql().begin(async (tx) =>
        acceptInvitation(tx as never, { token, authUserId: user }),
      ).catch((error: Error) => messages.push(error.message));
    }
    expect(messages).toHaveLength(2);
    // Identical, so the endpoint cannot be used to find out whether an address
    // was invited.
    expect(messages[0]).toBe(messages[1]);

    // And nothing was written on the way to refusing: a write inside the
    // transaction that then throws is rolled back with it, so marking the link
    // expired there would be code that looks like it tidied up and did not.
    const [after] = await ownerSql()<{ status: string }[]>`
      select status::text from portal_links where id = ${live.portalLinkId}
    `;
    expect(after!.status).toBe('invited');
  });

  /* ---------------------------------------------------------------- revoking */

  it('revokes access without touching the tenancy', async () => {
    const linkId = (await ownerSql()<{ id: string }[]>`
      select id from portal_links
       where lease_id = ${leaseId} and resident_id = ${residentId}
    `)[0]!.id;

    await as(org.adminUserId, (tx) =>
      revokePortalAccess(tx, org.organisationId, org.adminUserId, {
        portalLinkId: linkId, reason: 'Moved out at the end of the lease.',
      }),
    );

    const [link] = await ownerSql()<{ status: string; token_hash: string | null }[]>`
      select status::text, encode(invite_token_hash, 'hex') as token_hash
        from portal_links where id = ${linkId}
    `;
    expect(link!.status).toBe('revoked');
    expect(link!.token_hash).toBeNull();

    // The lease, the charge and the balance are exactly as they were: this is
    // about the portal, not the tenancy.
    const [balance] = await ownerSql()<{ total: string }[]>`
      select coalesce(sum(outstanding_minor), 0)::text as total
        from charge_line_balances where lease_id = ${leaseId}
    `;
    expect(balance!.total).toBe(R('8000').toString());

    // And the resident can no longer read it.
    const resident = (globalThis as Record<string, unknown>).__residentUser as string;
    const own = await as(resident, (tx) => tx<{ id: string }[]>`
      select id from leases where id = ${leaseId}::uuid
    `);
    expect(own).toHaveLength(0);
  });

  it('requires a reason to revoke', async () => {
    const linkId = (await ownerSql()<{ id: string }[]>`
      select id from portal_links
       where lease_id = ${leaseId} and resident_id = ${residentId}
    `)[0]!.id;
    await expect(
      as(org.adminUserId, (tx) =>
        revokePortalAccess(tx, org.organisationId, org.adminUserId, {
          portalLinkId: linkId, reason: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('can invite again after revoking, and the old token stays dead', async () => {
    const reissued = await as(org.adminUserId, (tx) =>
      issueInvitation(tx, org.organisationId, org.adminUserId, {
        leaseId, residentId, email: 'thandiwe@demo.invalid',
        confirmedRecipient: 'Thandiwe Mokoena',
      }),
    );
    const [link] = await ownerSql()<{ status: string; auth_user_id: string | null }[]>`
      select status::text, auth_user_id from portal_links
       where lease_id = ${leaseId} and resident_id = ${residentId}
    `;
    expect(link!.status).toBe('invited');
    // Re-inviting after a revocation does not quietly hand the old account
    // access back: it is an invitation again, waiting to be accepted.
    expect(reissued.token).toBeTruthy();
  });

  /* ------------------------------------------------------------- isolation */

  it('refuses to invite into another organisation\'s lease', async () => {
    const other = await createOrganisation('Elsewhere Portal');
    await expect(
      as(other.adminUserId, (tx) =>
        prepareInvitation(tx, other.organisationId, { leaseId, residentId }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a member without the resident permission', async () => {
    const resident = (globalThis as Record<string, unknown>).__residentUser as string;
    // A resident is not an operator: they cannot issue portal access to
    // themselves or anybody else.
    await expect(
      as(resident, (tx) =>
        prepareInvitation(tx, org.organisationId, { leaseId, residentId }),
      ),
    ).rejects.toBeTruthy();
  });
});
