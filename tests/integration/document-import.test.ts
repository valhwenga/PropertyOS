import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  activateLease, createProperty, createResident, createStandaloneHouse, createUnit, draftLease,
  matchDocumentsToLeases,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, type OrganisationFixture,
} from '../support/factories';

/**
 * Placing a folder of documents against the right leases.
 *
 * Step 8 of the blueprint's import order, and the one step with no path at
 * all: a landlord arriving with four hundred lease PDFs had to attach them one
 * at a time from each lease screen, so the contracts stayed in a folder and
 * the product held leases with no lease agreement in them.
 *
 * What is tested here is mostly the refusals. Filing a tenant's identity
 * document against the wrong tenancy is a mistake nobody finds for a year, so
 * an ambiguous name must be reported rather than guessed at — a matcher that
 * is usually right is worse than one that says when it is not sure.
 */
describe('Matching documents to leases by filename', () => {
  let org: OrganisationFixture;
  let leaseOne: string;
  let leaseTwo: string;
  let propertyCode: string;
  let preparer: string;

  beforeAll(async () => {
    org = await createOrganisation('Filing Co', { planKey: 'portfolio' });
    preparer = await addMember(org.organisationId, 'Filing Preparer', ['finance_preparer']);

    const make = async (code: string, first: string): Promise<string> => {
      const house = await as(org.adminUserId, (tx) => createStandaloneHouse(
        tx, org.organisationId, org.adminUserId, {
          name: `${first} House`, code, propertyType: 'house',
          addressLine1: `${code} Filing Road`, city: 'Cape Town',
        },
      ));
      const resident = await as(org.adminUserId, (tx) =>
        createResident(tx, org.organisationId, org.adminUserId, {
          firstName: first, lastName: 'Tenant',
        }),
      );
      const lease = await as(org.adminUserId, (tx) =>
        draftLease(tx, org.organisationId, org.adminUserId, {
          unitId: house.unitId, startDate: '2026-03-01', endDate: '2027-02-28',
          rentMinor: 900_000n, billingDay: 1, depositRequiredMinor: 900_000n,
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
      const [row] = await as(org.adminUserId, (tx) =>
        tx<{ reference: string }[]>`select reference from leases where id = ${lease.leaseId}::uuid`,
      );
      return row!.reference;
    };

    leaseOne = await make('FIL1', 'Ayanda');
    leaseTwo = await make('FIL2', 'Bongani');

    // A property with a short code, to prove codes are matched on a whole
    // token rather than anywhere in the name.
    const property = await as(org.adminUserId, (tx) =>
      createProperty(tx, org.organisationId, org.adminUserId, {
        name: 'Short Code Block', code: 'A1', propertyType: 'apartment_block',
        addressLine1: '1 Short Street', city: 'Cape Town',
      }),
    );
    await as(org.adminUserId, (tx) =>
      createUnit(tx, org.organisationId, org.adminUserId, {
        propertyId: property.propertyId, code: 'U1',
      }),
    );
    propertyCode = 'A1';
  });

  afterAll(async () => { await closeOwner(); });

  it('places a file whose name carries one lease reference', async () => {
    const [match] = await as(org.adminUserId, (tx) =>
      matchDocumentsToLeases(tx, org.organisationId, [`${leaseOne}-signed-lease.pdf`]),
    );
    expect(match!.leaseReference).toBe(leaseOne);
    expect(match!.unmatchedReason).toBeNull();
  });

  it('reports a name that mentions two leases rather than choosing one', async () => {
    const [match] = await as(org.adminUserId, (tx) =>
      matchDocumentsToLeases(tx, org.organisationId, [`${leaseOne}-and-${leaseTwo}.pdf`]),
    );
    expect(match!.leaseId).toBeNull();
    expect(match!.unmatchedReason).toContain('2 leases');
  });

  it('places a file by property code, on a whole token only', async () => {
    const matches = await as(org.adminUserId, (tx) =>
      matchDocumentsToLeases(tx, org.organisationId, [
        'A1-building-insurance.pdf',
        // The code A1 appears inside A12; a substring match would file this
        // against the wrong building.
        'FLAT-A12-inventory.pdf',
      ]),
    );
    expect(matches[0]!.propertyCode).toBe(propertyCode);
    expect(matches[1]!.propertyId).toBeNull();
    expect(matches[1]!.unmatchedReason).toContain('No lease reference or property code');
  });

  it('says what to do with a file it cannot place', async () => {
    const [match] = await as(org.adminUserId, (tx) =>
      matchDocumentsToLeases(tx, org.organisationId, ['scan0001.pdf']),
    );
    expect(match!.unmatchedReason).toContain('Include one');
  });

  it('is case-insensitive about the reference', async () => {
    const [match] = await as(org.adminUserId, (tx) =>
      matchDocumentsToLeases(tx, org.organisationId, [`${leaseOne.toLowerCase()}.pdf`]),
    );
    expect(match!.leaseReference).toBe(leaseOne);
  });

  it('needs the document permission, and says so', async () => {
    await expect(
      as(preparer, (tx) =>
        matchDocumentsToLeases(tx, org.organisationId, ['anything.pdf']),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
