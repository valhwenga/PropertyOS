import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  activateLease, createInspection, createResident, createStandaloneHouse,
  createTemplateVersion, createTicket, draftLease, finaliseInspection, getInspection,
  recordInspectionFindings, registerDocument, residentInspections, sha256,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, grantPortalAccess, ownerSql,
  type OrganisationFixture,
} from '../support/factories';

/**
 * Photographs, and who may look at them.
 *
 * Two gaps with the same shape. `inspection_photos` had existed since the
 * operations migration and nothing in the product ever wrote a row into it, so
 * a report could record "damaged" against a worktop and hold no picture of it
 * — the first thing a resident disputing a deduction asks for. And the
 * resident could not have seen one anyway: the read was member-only, which
 * made the evidence behind a deduction visible to the party making it and not
 * to the party paying for it.
 *
 * The quarantine rule is asserted rather than worked around. With no scanner
 * configured an upload is `skipped_not_configured`, which IS quarantined, and
 * a quarantined file is refused to everybody — so these tests assert that the
 * REFERENCE is visible to both sides and that the file's state travels with
 * it, which is what lets each screen say why it cannot be opened.
 */
describe('photographs on an inspection', () => {
  let org: OrganisationFixture;
  let residentAuthId: string;
  let leaseId: string;
  let inspectionId: string;
  let itemId: string;
  let documentId: string;
  let otherMember: string;

  beforeAll(async () => {
    org = await createOrganisation('Photo Co', { planKey: 'portfolio' });
    otherMember = await addMember(org.organisationId, 'Photo Manager', ['property_manager']);

    const property = await as(org.adminUserId, (tx) => createStandaloneHouse(
      tx, org.organisationId, org.adminUserId, {
        name: 'Photo House', code: 'PHO', propertyType: 'house',
        addressLine1: '7 Photo Lane', city: 'Durban',
      },
    ));

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Photo', lastName: 'Resident',
      }),
    );

    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: property.unitId, startDate: '2026-02-01', endDate: '2026-12-31',
        rentMinor: 650_000n, billingDay: 1, depositRequiredMinor: 650_000n,
        parties: [{
          residentId: resident.residentId, role: 'primary_resident', canViewFinancials: true,
        }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-02-01',
        executionExceptionReason: 'Fixture: no contract attached.',
      }),
    );
    leaseId = lease.leaseId;

    residentAuthId = await grantPortalAccess(
      org.organisationId, lease.leaseId, resident.residentId, 'Photo Resident',
    );

    const template = await as(org.adminUserId, (tx) =>
      createTemplateVersion(tx, org.organisationId, org.adminUserId, {
        name: 'Photo checklist',
        items: [{ room: 'Kitchen', item: 'Worktop' }],
      }),
    );
    const inspection = await as(org.adminUserId, (tx) =>
      createInspection(tx, org.organisationId, org.adminUserId, {
        unitId: property.unitId, leaseId: lease.leaseId,
        templateId: template.templateId, inspectionType: 'move_out',
      }),
    );
    inspectionId = inspection.inspectionId;

    const [item] = await ownerSql()<{ id: string }[]>`
      select id from inspection_items where inspection_id = ${inspectionId}
    `;
    itemId = item!.id;

    await as(org.adminUserId, (tx) =>
      recordInspectionFindings(tx, org.organisationId, org.adminUserId, {
        inspectionId,
        findings: [{
          itemId, condition: 'damaged', damageType: 'damage',
          note: 'Burn mark beside the hob.',
        }],
      }),
    );

    // The photograph: registered the way the upload path registers one, with
    // no scanner configured, which is this build's default.
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const document = await as(org.adminUserId, (tx) =>
      registerDocument(
        tx, org.organisationId, org.adminUserId,
        {
          classification: 'inspection',
          title: 'Kitchen — Worktop',
          filename: 'worktop.jpg',
          contentType: 'image/jpeg',
          byteSize: body.byteLength,
          contentSha256: sha256(body),
          leaseId: lease.leaseId,
        },
        { status: 'skipped_not_configured' },
      ),
    );
    documentId = document.documentId;
    await as(org.adminUserId, (tx) => tx`
      insert into inspection_photos (organisation_id, inspection_item_id, document_id)
      values (${org.organisationId}, ${itemId}, ${documentId})
    `);

    await as(org.adminUserId, (tx) =>
      finaliseInspection(tx, org.organisationId, org.adminUserId, {
        inspectionId, performedOn: '2026-11-30',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('shows the operator the photograph against the item it is evidence for', async () => {
    const inspection = await as(org.adminUserId, (tx) =>
      getInspection(tx, org.organisationId, inspectionId),
    );
    const item = inspection!.items.find((i) => i.id === itemId)!;
    expect(item.photos).toHaveLength(1);
    expect(item.photos[0]!.documentId).toBe(documentId);
    // Attached per item, not per report: "a photograph somewhere on this
    // report" is not evidence about a worktop.
    expect(item.condition).toBe('damaged');
  });

  it('shows the resident the same photograph on their own report', async () => {
    // Read out of the callback: `as` takes a plain function, and an await
    // inside its argument list is a parse error rather than a clever one-liner.
    const [link] = await ownerSql()<{ resident_id: string }[]>`
      select resident_id from portal_links where auth_user_id = ${residentAuthId}
    `;
    const reports = await as(residentAuthId, (tx) =>
      residentInspections(tx, leaseId, link!.resident_id),
    );
    const item = reports[0]!.items.find((i) => i.id === itemId)!;
    expect(item.photos).toHaveLength(1);
    // Quarantined, so the screen says why rather than offering a link that is
    // refused to everybody — the landlord included.
    expect(item.photos[0]!.openable).toBe(false);
  });

  it('shows nothing to a resident of another organisation’s lease', async () => {
    const stranger = await createOrganisation('Other Photo Co');
    const strangerResident = await addMember(
      stranger.organisationId, 'Other Member', ['property_manager'],
    );
    const leaked = await as(strangerResident, (tx) =>
      tx`select id from inspection_photos where document_id = ${documentId}::uuid`,
    );
    expect(leaked).toHaveLength(0);
  });

  it('keeps a photograph off a member who is not in the organisation', async () => {
    // A member of THIS organisation can see it: the photo is the landlord's
    // own record. Asserted so the policy's scope is pinned in both directions.
    const visible = await as(otherMember, (tx) =>
      tx`select id from inspection_photos where document_id = ${documentId}::uuid`,
    );
    expect(visible).toHaveLength(1);
  });
});

describe('a photograph on a maintenance request', () => {
  let org: OrganisationFixture;
  let residentAuthId: string;
  let leaseId: string;
  let ticketId: string;

  beforeAll(async () => {
    org = await createOrganisation('Leak Co', { planKey: 'portfolio' });
    const property = await as(org.adminUserId, (tx) => createStandaloneHouse(
      tx, org.organisationId, org.adminUserId, {
        name: 'Leak House', code: 'LEK', propertyType: 'house',
        addressLine1: '9 Leak Road', city: 'Durban',
      },
    ));
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Leak', lastName: 'Resident',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: property.unitId, startDate: '2026-02-01', endDate: '2026-12-31',
        rentMinor: 700_000n, billingDay: 1, depositRequiredMinor: 700_000n,
        parties: [{
          residentId: resident.residentId, role: 'primary_resident', canViewFinancials: true,
        }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-02-01',
        executionExceptionReason: 'Fixture: no contract attached.',
      }),
    );
    residentAuthId = await grantPortalAccess(
      org.organisationId, leaseId, resident.residentId, 'Leak Resident',
    );

    const ticket = await as(residentAuthId, (tx) =>
      createTicket(
        tx, org.organisationId, residentAuthId,
        {
          propertyId: property.propertyId,
          unitId: property.unitId,
          leaseId,
          residentId: resident.residentId,
          category: 'plumbing',
          description: 'Water is coming out from under the kitchen sink.',
          urgency: 'normal',
        },
        // The resident path: `createTicket` requires `maintenance.manage`
        // unless told the caller is a resident, and then checks the lease is
        // one of theirs instead. The portal passes the same flag.
        { asResident: true },
      ),
    );
    ticketId = ticket.ticketId;
  });

  afterAll(async () => { await closeOwner(); });

  it('lets the resident attach one to their own request, and the landlord see it', async () => {
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
    const document = await as(residentAuthId, (tx) =>
      registerDocument(
        tx, org.organisationId, residentAuthId,
        {
          classification: 'maintenance',
          title: 'Photo for the leak',
          filename: 'leak.jpg',
          contentType: 'image/jpeg',
          byteSize: body.byteLength,
          contentSha256: sha256(body),
          leaseId,
        },
        { status: 'skipped_not_configured' },
        // The portal's path: a resident holds no `document.manage`, and the
        // policy has always allowed their own upload on their own lease.
        { asResident: true },
      ),
    );
    await as(residentAuthId, (tx) => tx`
      insert into maintenance_attachments (organisation_id, ticket_id, document_id, audience)
      values (${org.organisationId}, ${ticketId}, ${document.documentId}, 'resident_visible')
    `);

    const landlordSees = await as(org.adminUserId, (tx) =>
      tx`select document_id from maintenance_attachments where ticket_id = ${ticketId}::uuid`,
    );
    expect(landlordSees).toHaveLength(1);
  });

  it('lets the resident read back the file they just uploaded', async () => {
    // Not a nicety: `registerDocument` ends with `returning id`, Postgres
    // filters a RETURNING row through the SELECT policies, and without this
    // the upload failed with "new row violates row-level security policy"
    // while every insert condition was satisfied. The raw insert without
    // `returning` succeeded, which is what made the error so misleading.
    const mine = await as(residentAuthId, (tx) =>
      tx`select id from documents where classification = 'maintenance'
          and lease_id = ${leaseId}::uuid`,
    );
    expect(mine.length).toBeGreaterThan(0);
  });

  it('refuses one on somebody else’s request', async () => {
    const other = await createOrganisation('Other Leak Co');
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7]);
    // The resident cannot even register a document against a lease that is not
    // theirs, which is the first door rather than the last.
    await expect(
      as(residentAuthId, (tx) =>
        registerDocument(
          tx, other.organisationId, residentAuthId,
          {
            classification: 'maintenance',
            title: 'Not mine',
            filename: 'x.jpg',
            contentType: 'image/jpeg',
            byteSize: body.byteLength,
            contentSha256: sha256(body),
          },
          { status: 'skipped_not_configured' },
          { asResident: true },
        ),
      ),
    ).rejects.toThrow();
  });
});
