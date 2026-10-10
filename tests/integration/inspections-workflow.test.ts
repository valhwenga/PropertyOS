/**
 * Filling in an inspection, which until now could not be done.
 *
 * `createInspection` pre-populates the checklist from its template with every
 * item `not_applicable`, and no command could then change them. An inspector
 * could open a checklist and not fill it in — which makes the module
 * decorative, and leaves a move-out deduction resting on nothing.
 *
 * The rule that matters most here: fair wear and tear is not damage. §13 keeps
 * them distinct and the deposits module refuses to deduct without evidence, so
 * this is where a defensible deduction actually begins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, createInspection, createResident, createStandaloneHouse,
  createTemplateVersion, draftLease, finaliseInspection, getInspection,
  listInspectionTemplates, parseMajorToMinor, recordInspectionFindings,
  respondToInspection, reviseInspection,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Inspections', () => {
  let org: OrganisationFixture;
  let unitId: string;
  let leaseId: string;
  let residentId: string;
  let templateId: string;
  let inspectionId: string;

  beforeAll(async () => {
    org = await createOrganisation('Inspection Co');

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
      }),
    );
    residentId = resident.residentId;

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Inspection House', code: 'INSP', propertyType: 'house',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    unitId = house.unitId;

    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId, startDate: '2026-01-01', endDate: '2026-12-31', rentMinor: R('8000'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );

    const template = await as(org.adminUserId, (tx) =>
      createTemplateVersion(tx, org.organisationId, org.adminUserId, {
        name: 'Standard move-out',
        items: [
          { room: 'Kitchen', item: 'Oven' },
          { room: 'Kitchen', item: 'Worktop' },
          { room: 'Lounge', item: 'Carpet' },
          { room: 'Bathroom', item: 'Shower screen' },
        ],
      }),
    );
    templateId = template.templateId;
  });

  afterAll(async () => { await closeOwner(); });

  it('starts every item unanswered rather than assuming it is fine', async () => {
    const created = await as(org.adminUserId, (tx) =>
      createInspection(tx, org.organisationId, org.adminUserId, {
        unitId, leaseId, templateId, inspectionType: 'move_out',
        scheduledFor: '2026-12-20',
      }),
    );
    inspectionId = created.inspectionId;

    const inspection = await as(org.adminUserId, (tx) =>
      getInspection(tx, org.organisationId, inspectionId),
    );
    expect(inspection!.items).toHaveLength(4);
    // Not "good". An unchecked item is unchecked, and defaulting it to good
    // would put words in an inspector's mouth.
    expect(inspection!.items.every((i) => i.condition === 'not_applicable')).toBe(true);
    expect(inspection!.status).toBe('draft');
  });

  it('records what the inspector found', async () => {
    const inspection = await as(org.adminUserId, (tx) =>
      getInspection(tx, org.organisationId, inspectionId),
    );
    const byItem = new Map(inspection!.items.map((i) => [i.item, i.id]));

    const result = await as(org.adminUserId, (tx) =>
      recordInspectionFindings(tx, org.organisationId, org.adminUserId, {
        inspectionId,
        findings: [
          { itemId: byItem.get('Oven')!, condition: 'good' },
          {
            itemId: byItem.get('Carpet')!, condition: 'poor',
            damageType: 'fair_wear_and_tear',
            note: 'Flattened in the traffic path after three years.',
          },
          {
            itemId: byItem.get('Shower screen')!, condition: 'damaged',
            damageType: 'damage', note: 'Cracked panel, quotation attached.',
          },
        ],
      }),
    );
    expect(result.updated).toBe(3);

    const after = await as(org.adminUserId, (tx) =>
      getInspection(tx, org.organisationId, inspectionId),
    );
    const carpet = after!.items.find((i) => i.item === 'Carpet')!;
    const screen = after!.items.find((i) => i.item === 'Shower screen')!;

    // The distinction the whole thing turns on: both are "not good", and only
    // one of them can support a deduction.
    expect(carpet.damageType).toBe('fair_wear_and_tear');
    expect(screen.damageType).toBe('damage');
  });

  it('refuses "damaged" with no kind of damage behind it', async () => {
    const inspection = await as(org.adminUserId, (tx) =>
      getInspection(tx, org.organisationId, inspectionId),
    );
    const worktop = inspection!.items.find((i) => i.item === 'Worktop')!;

    await expect(
      as(org.adminUserId, (tx) =>
        recordInspectionFindings(tx, org.organisationId, org.adminUserId, {
          inspectionId,
          findings: [{ itemId: worktop.id, condition: 'damaged' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('closes to edits once finalised', async () => {
    await as(org.adminUserId, (tx) =>
      finaliseInspection(tx, org.organisationId, org.adminUserId, {
        inspectionId, performedOn: '2026-12-20',
        attendees: 'T Mokoena, N Dlamini', keysHandedOver: '2 front door, 1 gate remote',
      }),
    );

    const inspection = await as(org.adminUserId, (tx) =>
      getInspection(tx, org.organisationId, inspectionId),
    );
    expect(inspection!.status).toBe('finalised');
    expect(inspection!.attendees).toContain('Mokoena');

    const item = inspection!.items[0]!;
    await expect(
      as(org.adminUserId, (tx) =>
        recordInspectionFindings(tx, org.organisationId, org.adminUserId, {
          inspectionId, findings: [{ itemId: item.id, condition: 'good' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets a resident dispute it without editing the inspector\'s record', async () => {
    await as(org.adminUserId, (tx) =>
      respondToInspection(tx, org.organisationId, org.adminUserId, {
        inspectionId, residentId, response: 'disputed',
        comment: 'The shower screen was cracked when I moved in.',
      }),
    );

    const inspection = await as(org.adminUserId, (tx) =>
      getInspection(tx, org.organisationId, inspectionId),
    );
    expect(inspection!.status).toBe('disputed');
    expect(inspection!.responses[0]!.comment).toContain('when I moved in');
    // §13: the resident may dispute, not edit. The findings are untouched.
    const screen = inspection!.items.find((i) => i.item === 'Shower screen')!;
    expect(screen.damageType).toBe('damage');
  });

  it('requires a reason before a dispute can be recorded', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        respondToInspection(tx, org.organisationId, org.adminUserId, {
          inspectionId, residentId, response: 'disputed',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('corrects by superseding, never by editing', async () => {
    const revision = await as(org.adminUserId, (tx) =>
      reviseInspection(tx, org.organisationId, org.adminUserId, {
        inspectionId, reason: 'Resident produced the move-in photographs of the screen.',
      }),
    );

    const [original, revised] = await as(org.adminUserId, async (tx) => [
      await getInspection(tx, org.organisationId, inspectionId),
      await getInspection(tx, org.organisationId, revision.inspectionId),
    ]);

    // The original stays readable, marked superseded, so a later dispute can
    // see exactly what was submitted and when.
    expect(original!.status).toBe('superseded');
    expect(revised!.status).toBe('draft');
    expect(revised!.supersedesInspectionId).toBe(inspectionId);
    expect(revised!.revisionReason).toContain('move-in photographs');
    // And the revision starts from the original's findings rather than blank.
    expect(revised!.items).toHaveLength(4);
    expect(revised!.items.find((i) => i.item === 'Carpet')!.damageType)
      .toBe('fair_wear_and_tear');
  });

  it('versions a template rather than editing it', async () => {
    // An inspection records the template version it was performed against;
    // changing a checklist must never retroactively alter what was checked.
    const second = await as(org.adminUserId, (tx) =>
      createTemplateVersion(tx, org.organisationId, org.adminUserId, {
        name: 'Standard move-out',
        items: [
          { room: 'Kitchen', item: 'Oven' },
          { room: 'Kitchen', item: 'Worktop' },
          { room: 'Lounge', item: 'Carpet' },
          { room: 'Bathroom', item: 'Shower screen' },
          { room: 'Bathroom', item: 'Extractor fan' },
        ],
      }),
    );
    expect(second.version).toBe(2);

    const templates = await as(org.adminUserId, (tx) =>
      listInspectionTemplates(tx, org.organisationId),
    );
    expect(templates.filter((t) => t.name === 'Standard move-out')).toHaveLength(1);
    expect(templates.find((t) => t.name === 'Standard move-out')!.version).toBe(2);

    // The finished inspection still points at version 1.
    const original = await as(org.adminUserId, (tx) =>
      getInspection(tx, org.organisationId, inspectionId),
    );
    expect(original!.templateVersion).toBe(1);
    expect(original!.items).toHaveLength(4);
  });

  it('does not show one organisation another organisation\'s inspections', async () => {
    const other = await createOrganisation('Elsewhere Inspections');
    await expect(
      as(other.adminUserId, (tx) => getInspection(tx, other.organisationId, inspectionId)),
    ).resolves.toBeUndefined();
  });

  it('keeps every finding addressable from the database', async () => {
    // A quick guard that the pre-population and the findings agree: every item
    // on the inspection belongs to it, and none leaked from another.
    const [row] = await ownerSql()<{ mismatched: string }[]>`
      select count(*)::text as mismatched
        from inspection_items ii
        join inspections i on i.id = ii.inspection_id
       where ii.organisation_id <> i.organisation_id
    `;
    expect(row!.mismatched).toBe('0');
  });
});
