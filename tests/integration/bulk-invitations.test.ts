import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  activateLease, createResident, createStandaloneHouse, draftLease,
  issuePortalInvitations, listPortalInvitationCandidates,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, grantPortalAccess, ownerSql,
  type OrganisationFixture,
} from '../support/factories';

/**
 * Inviting a portfolio's residents in one pass.
 *
 * The import brings in properties, units, residents and leases in one sitting
 * and then every resident had to be invited from their own lease screen; fifty
 * leases is fifty screens, which is how a landlord decides the portal is not
 * worth the trouble.
 *
 * What these tests are really about is the guard. "An administrator linking an
 * email to the wrong resident is a security incident", so the single-invitation
 * path makes an operator confirm the recipient by name — and doing fifty at
 * once must not become the way around that.
 */
describe('Bulk portal invitations', () => {
  let org: OrganisationFixture;
  let leases: Array<{ leaseId: string; residentId: string; name: string }> = [];
  let noEmailLease: { leaseId: string; residentId: string };
  let alreadyInvited: { leaseId: string; residentId: string };

  beforeAll(async () => {
    org = await createOrganisation('Invite Co', { planKey: 'portfolio' });

    const make = async (
      code: string, first: string, email: string | null,
    ): Promise<{ leaseId: string; residentId: string; name: string }> => {
      const house = await as(org.adminUserId, (tx) => createStandaloneHouse(
        tx, org.organisationId, org.adminUserId, {
          name: `${first} House`, code, propertyType: 'house',
          addressLine1: `${code} Invite Road`, city: 'Cape Town',
        },
      ));
      const resident = await as(org.adminUserId, (tx) =>
        createResident(tx, org.organisationId, org.adminUserId, {
          firstName: first, lastName: 'Tenant',
          ...(email ? { email } : {}),
        }),
      );
      const lease = await as(org.adminUserId, (tx) =>
        draftLease(tx, org.organisationId, org.adminUserId, {
          unitId: house.unitId, startDate: '2026-03-01', endDate: '2027-02-28',
          rentMinor: 800_000n, billingDay: 1, depositRequiredMinor: 800_000n,
          parties: [{
            residentId: resident.residentId, role: 'primary_resident',
            canViewFinancials: true,
          }],
        }),
      );
      await as(org.adminUserId, (tx) =>
        activateLease(tx, org.organisationId, org.adminUserId, {
          leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-03-01',
          executionExceptionReason: 'Fixture: no contract attached.',
        }),
      );
      return {
        leaseId: lease.leaseId,
        residentId: resident.residentId,
        name: `${first} Tenant`,
      };
    };

    leases = [
      await make('IV1', 'Ayanda', 'ayanda@demo.invalid'),
      await make('IV2', 'Bongani', 'bongani@demo.invalid'),
    ];
    noEmailLease = await make('IV3', 'Chloe', null);
    alreadyInvited = await make('IV4', 'Dumisani', 'dumisani@demo.invalid');
    await grantPortalAccess(
      org.organisationId, alreadyInvited.leaseId, alreadyInvited.residentId, 'Dumisani Tenant',
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('lists everybody without access, and says why the rest cannot be invited', async () => {
    const candidates = await as(org.adminUserId, (tx) =>
      listPortalInvitationCandidates(tx, org.organisationId),
    );
    const names = candidates.map((c) => c.residentName);

    expect(names).toContain('Ayanda Tenant');
    expect(names).toContain('Bongani Tenant');
    // Listed WITH a reason rather than silently omitted: a resident with no
    // address recorded is the common case, and the fix is to add one.
    const chloe = candidates.find((c) => c.residentName === 'Chloe Tenant');
    expect(chloe?.blockedReason).toContain('No email address');
    // Already has access, so not offered at all — nobody is invited twice by
    // accident.
    expect(names).not.toContain('Dumisani Tenant');
  });

  it('issues one link per resident, and hands them back once', async () => {
    const outcome = await as(org.adminUserId, (tx) =>
      issuePortalInvitations(tx, org.organisationId, org.adminUserId, leases.map((l) => ({
        leaseId: l.leaseId, residentId: l.residentId,
        email: `${l.name.split(' ')[0]!.toLowerCase()}@demo.invalid`,
        confirmedRecipient: l.name,
      }))),
    );
    expect(outcome.issued).toHaveLength(2);
    expect(outcome.failed).toHaveLength(0);
    // Distinct tokens: two residents must never share a link.
    expect(new Set(outcome.issued.map((i) => i.token)).size).toBe(2);

    // Only a hash is stored, so the token cannot be read back out.
    const [stored] = await ownerSql()<{ n: string }[]>`
      select count(*)::text as n from portal_links
       where lease_id = ${leases[0]!.leaseId} and status = 'invited'
    `;
    expect(stored!.n).toBe('1');
  });

  it('refuses a row whose resident is not the one the operator confirmed', async () => {
    // The mis-link guard, which is the whole reason bulk is harder than a loop.
    const outcome = await as(org.adminUserId, (tx) =>
      issuePortalInvitations(tx, org.organisationId, org.adminUserId, [{
        leaseId: noEmailLease.leaseId,
        residentId: noEmailLease.residentId,
        email: 'somebody.else@demo.invalid',
        confirmedRecipient: 'Ayanda Tenant',
      }]),
    );
    expect(outcome.issued).toHaveLength(0);
    expect(outcome.failed[0]!.reason).toContain('has changed since the list was shown');
  });

  it('reports a resident who already has access rather than inviting them twice', async () => {
    const outcome = await as(org.adminUserId, (tx) =>
      issuePortalInvitations(tx, org.organisationId, org.adminUserId, [{
        leaseId: alreadyInvited.leaseId,
        residentId: alreadyInvited.residentId,
        email: 'dumisani@demo.invalid',
        confirmedRecipient: 'Dumisani Tenant',
      }]),
    );
    expect(outcome.issued).toHaveLength(0);
    expect(outcome.failed[0]!.reason).toContain('Already has portal access');
  });

  it('one bad row does not take the good ones with it', async () => {
    const outcome = await as(org.adminUserId, (tx) =>
      issuePortalInvitations(tx, org.organisationId, org.adminUserId, [
        {
          leaseId: noEmailLease.leaseId, residentId: noEmailLease.residentId,
          email: 'chloe@demo.invalid', confirmedRecipient: 'Chloe Tenant',
        },
        {
          leaseId: alreadyInvited.leaseId, residentId: alreadyInvited.residentId,
          email: 'dumisani@demo.invalid', confirmedRecipient: 'Dumisani Tenant',
        },
      ]),
    );
    // Chloe has no address on her record, but one was given on the form, which
    // is the ordinary way that gets fixed — so she is invited and the row that
    // genuinely cannot proceed is reported on its own.
    expect(outcome.issued.map((i) => i.residentName)).toEqual(['Chloe Tenant']);
    expect(outcome.failed).toHaveLength(1);
  });

  it('refuses a run larger than two hundred, so a mistake stays small', async () => {
    const many = Array.from({ length: 201 }, () => ({
      leaseId: leases[0]!.leaseId, residentId: leases[0]!.residentId,
      email: 'x@demo.invalid', confirmedRecipient: 'Ayanda Tenant',
    }));
    await expect(
      as(org.adminUserId, (tx) =>
        issuePortalInvitations(tx, org.organisationId, org.adminUserId, many),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
