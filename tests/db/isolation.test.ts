/**
 * Isolation acceptance tests.
 *
 * These use TWO real organisations and several property scopes, as the blueprint
 * requires. Every assertion attacks a path an attacker would actually use: a
 * known-good record id from another organisation, supplied directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withActor } from '@propertyos/db';
import {
  buildStatement, confirmReceipt, createResident, createStandaloneHouse,
  draftLease, activateLease, postCharge, parseMajorToMinor,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createAuthUser, createOrganisation,
  grantPortalAccess, grantSupportSession, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Cross-organisation and scope isolation', () => {
  let orgA: OrganisationFixture;
  let orgB: OrganisationFixture;
  let aProperty: string;
  let aUnit: string;
  let aLease: string;
  let aResident: string;
  let aDocumentId: string;

  beforeAll(async () => {
    orgA = await createOrganisation('Org Alpha');
    orgB = await createOrganisation('Org Beta');

    const house = await as(orgA.adminUserId, (tx) =>
      createStandaloneHouse(tx, orgA.organisationId, orgA.adminUserId, {
        name: 'Alpha House', code: 'ALPHA1', propertyType: 'house',
        addressLine1: '1 Alpha Road', city: 'Johannesburg',
      }),
    );
    aProperty = house.propertyId;
    aUnit = house.unitId;

    const resident = await as(orgA.adminUserId, (tx) =>
      createResident(tx, orgA.organisationId, orgA.adminUserId, {
        firstName: 'Alpha', lastName: 'Resident',
      }),
    );
    aResident = resident.residentId;

    const lease = await as(orgA.adminUserId, (tx) =>
      draftLease(tx, orgA.organisationId, orgA.adminUserId, {
        unitId: aUnit, startDate: '2026-02-01', rentMinor: R('5000'),
        parties: [{ residentId: aResident, role: 'primary_resident' }],
      }),
    );
    aLease = lease.leaseId;
    await as(orgA.adminUserId, (tx) =>
      activateLease(tx, orgA.organisationId, orgA.adminUserId, {
        leaseId: aLease, expectedVersion: 1, activationDate: '2026-02-01',
        executionExceptionReason: 'Paper contract on file.',
      }),
    );
    await as(orgA.adminUserId, (tx) =>
      postCharge(tx, orgA.organisationId, orgA.adminUserId, {
        leaseId: aLease, documentType: 'rent_invoice',
        issueDate: '2026-02-01', dueDate: '2026-02-01',
        lines: [{ category: 'rent', description: 'February rent', amountMinor: R('5000'), dueDate: '2026-02-01' }],
      }),
    );

    const [doc] = await ownerSql()<{ id: string }[]>`
      insert into documents (
        organisation_id, classification, title, storage_key, content_type,
        byte_size, visibility, lease_id, quarantined, scan_status
      ) values (
        ${orgA.organisationId}, 'lease', 'Alpha lease contract',
        ${`org-a/${aLease}/contract.pdf`}, 'application/pdf', 102400,
        'resident_shared', ${aLease}, false, 'skipped_not_configured'
      ) returning id
    `;
    aDocumentId = doc!.id;
  });

  afterAll(async () => { await closeOwner(); });

  it("denies Organisation B's admin every read of Organisation A's records", async () => {
    await as(orgB.adminUserId, async (tx) => {
      // Each query supplies a VALID id from the other organisation.
      const leases = await tx`select id from leases where id = ${aLease}::uuid`;
      const properties = await tx`select id from properties where id = ${aProperty}::uuid`;
      const residents = await tx`select id from resident_profiles where id = ${aResident}::uuid`;
      const documents = await tx`select id from documents where id = ${aDocumentId}::uuid`;
      const charges = await tx`select id from charge_documents where lease_id = ${aLease}::uuid`;
      const journals = await tx`select id from journals where organisation_id = ${orgA.organisationId}::uuid`;

      expect(leases).toHaveLength(0);
      expect(properties).toHaveLength(0);
      expect(residents).toHaveLength(0);
      expect(documents).toHaveLength(0);
      expect(charges).toHaveLength(0);
      expect(journals).toHaveLength(0);
    });
  });

  it('denies without exposing whether the record exists', async () => {
    // A statement request for another organisation's lease returns the same
    // "not found" an entirely fictional id would, so probing reveals nothing.
    const realButForeign = as(orgB.adminUserId, (tx) =>
      buildStatement(tx, orgB.organisationId, { leaseId: aLease, cutOff: '2026-02-28' }),
    );
    const fictional = as(orgB.adminUserId, (tx) =>
      buildStatement(tx, orgB.organisationId, {
        leaseId: '00000000-0000-4000-8000-000000000000', cutOff: '2026-02-28',
      }),
    );
    await expect(realButForeign).rejects.toMatchObject({ code: 'not_found' });
    await expect(fictional).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cannot be bypassed by supplying another organisation id in the request', async () => {
    // The client "claims" to be acting in Organisation A. RLS resolves scope from
    // the authenticated user's memberships, so the claim changes nothing.
    await withActor({ authUserId: orgB.adminUserId, organisationId: orgA.organisationId }, async ({ tx }) => {
      const rows = await tx`select id from leases where organisation_id = ${orgA.organisationId}::uuid`;
      expect(rows).toHaveLength(0);
    });
  });

  it('refuses to write a record into another organisation', async () => {
    await expect(
      as(orgB.adminUserId, (tx) =>
        createResident(tx, orgA.organisationId, orgB.adminUserId, {
          firstName: 'Injected', lastName: 'Record',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('denies a property manager an unassigned property inside their OWN organisation', async () => {
    const otherHouse = await as(orgA.adminUserId, (tx) =>
      createStandaloneHouse(tx, orgA.organisationId, orgA.adminUserId, {
        name: 'Unassigned House', code: 'ALPHA2', propertyType: 'house',
        addressLine1: '2 Alpha Road', city: 'Johannesburg',
      }),
    );
    // Scoped to the FIRST property only.
    const manager = await addMember(
      orgA.organisationId, 'Scoped Manager', ['property_manager'],
      { type: 'property', propertyId: aProperty },
    );

    await as(manager, async (tx) => {
      const assigned = await tx`select id from properties where id = ${aProperty}::uuid`;
      const unassigned = await tx`select id from properties where id = ${otherHouse.propertyId}::uuid`;
      expect(assigned).toHaveLength(1);
      expect(unassigned).toHaveLength(0);
    });

    await expect(
      as(manager, async (tx) => {
        const { createUnit } = await import('@propertyos/domain');
        return createUnit(tx, orgA.organisationId, manager, {
          propertyId: otherHouse.propertyId, code: 'SNEAK',
        });
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('gives a member with no scope assignment no property access at all', async () => {
    const unscoped = await addMember(
      orgA.organisationId, 'Unscoped Member', ['property_manager'], { type: 'none' },
    );
    await as(unscoped, async (tx) => {
      const rows = await tx`select id from properties`;
      expect(rows).toHaveLength(0);
    });
  });

  it('limits a resident to their own lease, even when they supply another lease id', async () => {
    const secondResident = await as(orgA.adminUserId, (tx) =>
      createResident(tx, orgA.organisationId, orgA.adminUserId, {
        firstName: 'Second', lastName: 'Resident',
      }),
    );
    const house2 = await as(orgA.adminUserId, (tx) =>
      createStandaloneHouse(tx, orgA.organisationId, orgA.adminUserId, {
        name: 'Alpha House 3', code: 'ALPHA3', propertyType: 'cottage',
        addressLine1: '3 Alpha Road', city: 'Johannesburg',
      }),
    );
    const lease2 = await as(orgA.adminUserId, (tx) =>
      draftLease(tx, orgA.organisationId, orgA.adminUserId, {
        unitId: house2.unitId, startDate: '2026-02-01', rentMinor: R('4000'),
        parties: [{ residentId: secondResident.residentId, role: 'primary_resident' }],
      }),
    );
    await as(orgA.adminUserId, (tx) =>
      activateLease(tx, orgA.organisationId, orgA.adminUserId, {
        leaseId: lease2.leaseId, expectedVersion: 1, activationDate: '2026-02-01',
        executionExceptionReason: 'Paper contract on file.',
      }),
    );

    const residentUser = await grantPortalAccess(
      orgA.organisationId, aLease, aResident, 'Alpha Portal User',
    );

    await as(residentUser, async (tx) => {
      const own = await tx`select id from leases where id = ${aLease}::uuid`;
      const neighbour = await tx`select id from leases where id = ${lease2.leaseId}::uuid`;
      expect(own).toHaveLength(1);
      expect(neighbour).toHaveLength(0);

      // And no sight of the neighbour's charges or profile.
      const neighbourCharges = await tx`select id from charge_documents where lease_id = ${lease2.leaseId}::uuid`;
      const neighbourProfile = await tx`select id from resident_profiles where id = ${secondResident.residentId}::uuid`;
      expect(neighbourCharges).toHaveLength(0);
      expect(neighbourProfile).toHaveLength(0);
    });

    await expect(
      as(residentUser, (tx) =>
        buildStatement(tx, orgA.organisationId, { leaseId: lease2.leaseId, cutOff: '2026-02-28' }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('revokes resident access the moment the portal link is revoked', async () => {
    const residentUser = await grantPortalAccess(
      orgA.organisationId, aLease, aResident, 'Revocable User',
    );
    await as(residentUser, async (tx) => {
      expect(await tx`select id from leases where id = ${aLease}::uuid`).toHaveLength(1);
    });

    await ownerSql()`
      update portal_links set status = 'revoked', revoked_at = now()
      where auth_user_id = ${residentUser}
    `;

    // Resolved against current state, not a long lived claim.
    await as(residentUser, async (tx) => {
      expect(await tx`select id from leases where id = ${aLease}::uuid`).toHaveLength(0);
    });
  });

  it('gives a Spike operator nothing without an authorised support session', async () => {
    const operator = await createAuthUser('Spike Operator', { platformOperator: true });
    await as(operator, async (tx) => {
      expect(await tx`select id from leases where id = ${aLease}::uuid`).toHaveLength(0);
      expect(await tx`select id from organisations where id = ${orgA.organisationId}::uuid`).toHaveLength(0);
    });
  });

  it('grants a Spike operator time-limited READ access under an authorised session, and no writes', async () => {
    const operator = await createAuthUser('Spike Support', { platformOperator: true });
    await grantSupportSession(orgA.organisationId, operator, orgA.adminUserId, 2);

    await as(operator, async (tx) => {
      expect(await tx`select id from leases where id = ${aLease}::uuid`).toHaveLength(1);
    });

    // Support sessions are read-only: no write policy includes them.
    await expect(
      as(operator, (tx) =>
        createResident(tx, orgA.organisationId, operator, { firstName: 'Support', lastName: 'Write' }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('expires support access automatically', async () => {
    const operator = await createAuthUser('Expired Support', { platformOperator: true });
    await ownerSql()`
      insert into support_sessions (organisation_id, operator_user_id, reason, granted_at, expires_at)
      values (${orgA.organisationId}, ${operator},
              'Historic reconciliation query, session already elapsed',
              now() - interval '3 hours', now() - interval '1 hour')
    `;
    await as(operator, async (tx) => {
      expect(await tx`select id from leases where id = ${aLease}::uuid`).toHaveLength(0);
    });
  });

  it('keeps private documents private: another organisation cannot reach the object key', async () => {
    await as(orgB.adminUserId, async (tx) => {
      const rows = await tx`select storage_key from documents where id = ${aDocumentId}::uuid`;
      expect(rows).toHaveLength(0);
    });
  });

  it('hides a quarantined document from the resident until it clears', async () => {
    const residentUser = await grantPortalAccess(
      orgA.organisationId, aLease, aResident, 'Quarantine Viewer',
    );
    const [quarantined] = await ownerSql()<{ id: string }[]>`
      insert into documents (
        organisation_id, classification, title, storage_key, content_type,
        byte_size, visibility, lease_id, quarantined, scan_status
      ) values (
        ${orgA.organisationId}, 'lease', 'Unscanned upload',
        ${`org-a/${aLease}/unscanned-${Date.now()}.pdf`}, 'application/pdf', 2048,
        'internal', ${aLease}, true, 'pending'
      ) returning id
    `;
    await as(residentUser, async (tx) => {
      expect(await tx`select id from documents where id = ${quarantined!.id}::uuid`).toHaveLength(0);
      // The cleared, explicitly shared document IS visible.
      expect(await tx`select id from documents where id = ${aDocumentId}::uuid`).toHaveLength(1);
    });
  });

  it('prevents a receipt in one organisation referencing another organisation lease', async () => {
    await expect(
      as(orgB.adminUserId, (tx) =>
        confirmReceipt(tx, orgB.organisationId, orgB.adminUserId, {
          leaseId: aLease, amountMinor: R('100'), receivedOn: '2026-02-10',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
