/**
 * Correcting and retiring what is in the portfolio.
 *
 * A property or unit could be created and never corrected: a typo in a unit
 * code, a street spelled wrong, a block that gained a flat. Fixing any of it
 * needed database access, which in practice means it stays wrong.
 *
 * The rule under test here is the brief's: do not silently retire occupied
 * units. These commands do not retire them loudly either — they refuse, and
 * say which lease is in the way. The second rule is that correcting a property
 * today must not restate a document somebody signed last year.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, archiveProperty, createResident, createStandaloneHouse, createUnit,
  draftLease, getPropertyDetails, parseMajorToMinor, postCharge, reinstateProperty,
  reinstateUnit, retireUnit, terminateLease, updateProperty, updateUnit,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Portfolio editing', () => {
  let org: OrganisationFixture;
  let propertyId: string;
  let occupiedUnitId: string;
  let emptyUnitId: string;
  let leaseId: string;
  let residentId: string;

  beforeAll(async () => {
    org = await createOrganisation('Portfolio Co');

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
      }),
    );
    residentId = resident.residentId;

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Protea Court', code: 'PROTEA', propertyType: 'apartment_block',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    propertyId = house.propertyId;
    occupiedUnitId = house.unitId;

    const extra = await as(org.adminUserId, (tx) =>
      createUnit(tx, org.organisationId, org.adminUserId, {
        propertyId, code: 'B2', rentableType: 'apartment', bedrooms: 2,
        advertisedRentMinor: R('6500'),
      }),
    );
    emptyUnitId = extra.unitId;

    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: occupiedUnitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('8000'),
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
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------------------------ correcting */

  it('corrects a property and records what changed', async () => {
    await as(org.adminUserId, (tx) =>
      updateProperty(tx, org.organisationId, org.adminUserId, propertyId, {
        addressLine1: '14 Protea Avenue',
        suburb: 'Melville',
        reason: 'The deed says Avenue; the original capture said Street.',
      }),
    );

    const after = await as(org.adminUserId, (tx) =>
      getPropertyDetails(tx, org.organisationId, propertyId),
    );
    expect(after!.addressLine1).toBe('14 Protea Avenue');
    expect(after!.suburb).toBe('Melville');
    // Untouched fields stay as they were rather than being blanked.
    expect(after!.city).toBe('Johannesburg');
    expect(after!.name).toBe('Protea Court');

    // A correction nobody can see afterwards is indistinguishable from a
    // quiet rewrite, so the audit entry carries both sides.
    const [entry] = await ownerSql()<
      { before_state: Record<string, unknown>; after_state: Record<string, unknown>;
        reason: string | null }[]
    >`
      select before_state, after_state, reason from audit_events
       where organisation_id = ${org.organisationId} and action = 'property.updated'
       order by occurred_at desc limit 1
    `;
    expect(entry!.before_state.addressLine1).toBe('14 Protea Street');
    expect(entry!.after_state.addressLine1).toBe('14 Protea Avenue');
    expect(entry!.reason).toContain('deed says Avenue');
  });

  it('writes nothing when nothing changed', async () => {
    const [{ total: before }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from audit_events
       where organisation_id = ${org.organisationId} and action = 'property.updated'
    `;
    await as(org.adminUserId, (tx) =>
      updateProperty(tx, org.organisationId, org.adminUserId, propertyId, {
        city: 'Johannesburg',
      }),
    );
    const [{ total: after }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from audit_events
       where organisation_id = ${org.organisationId} and action = 'property.updated'
    `;
    // An audit trail full of "changed nothing" is an audit trail nobody reads.
    expect(after).toBe(before);
  });

  it('leaves an omitted field alone, and clears one sent empty', async () => {
    // The bug this pins: an omitted optional field parses to `undefined`, and
    // reading that as "set this to nothing" had the audit entry claim the
    // suburb was blanked while the SQL correctly left the column alone. An
    // audit trail that misreports the change is worse than none.
    await as(org.adminUserId, (tx) =>
      updateProperty(tx, org.organisationId, org.adminUserId, propertyId, {
        name: 'Protea Court',
      }),
    );
    const kept = await as(org.adminUserId, (tx) =>
      getPropertyDetails(tx, org.organisationId, propertyId),
    );
    expect(kept!.suburb).toBe('Melville');

    // Sending it empty is a deliberate instruction to clear it, and that does
    // reach both the column and the audit entry.
    await as(org.adminUserId, (tx) =>
      updateProperty(tx, org.organisationId, org.adminUserId, propertyId, {
        suburb: '', reason: 'The deed records no suburb.',
      }),
    );
    const cleared = await as(org.adminUserId, (tx) =>
      getPropertyDetails(tx, org.organisationId, propertyId),
    );
    expect(cleared!.suburb).toBeNull();

    const [entry] = await ownerSql()<
      { before_state: Record<string, unknown>; after_state: Record<string, unknown> }[]
    >`
      select before_state, after_state from audit_events
       where organisation_id = ${org.organisationId} and action = 'property.updated'
       order by occurred_at desc, id desc limit 1
    `;
    expect(entry!.before_state.suburb).toBe('Melville');
    expect(entry!.after_state.suburb).toBeNull();

    await as(org.adminUserId, (tx) =>
      updateProperty(tx, org.organisationId, org.adminUserId, propertyId, {
        suburb: 'Melville',
      }),
    );
  });

  it('does not restate a charge already raised against the lease', async () => {
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

    await as(org.adminUserId, (tx) =>
      updateProperty(tx, org.organisationId, org.adminUserId, propertyId, {
        name: 'Protea Court North',
      }),
    );

    // The charge is still exactly the charge that was raised. Renaming a
    // property is not a financial event.
    const [row] = await ownerSql()<{ total: string }[]>`
      select coalesce(sum(outstanding_minor), 0)::text as total
        from charge_line_balances where lease_id = ${leaseId}
    `;
    expect(row!.total).toBe(R('8000').toString());
  });

  it('refuses a unit code another unit in the property already uses', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        updateUnit(tx, org.organisationId, org.adminUserId, emptyUnitId, { code: 'MAIN' }),
      ),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('changes the advertised rent without touching the contracted rent', async () => {
    const [{ rent_minor: contractedBefore }] = await ownerSql()<{ rent_minor: string }[]>`
      select rent_minor::text from leases where id = ${leaseId}
    `;

    await as(org.adminUserId, (tx) =>
      updateUnit(tx, org.organisationId, org.adminUserId, occupiedUnitId, {
        advertisedRentMinor: R('9500'), bedrooms: 3,
      }),
    );

    const [unit] = await ownerSql()<
      { advertised_rent_minor: string; bedrooms: number }[]
    >`
      select advertised_rent_minor::text, bedrooms from units where id = ${occupiedUnitId}
    `;
    expect(unit!.advertised_rent_minor).toBe(R('9500').toString());
    expect(unit!.bedrooms).toBe(3);

    // The advertised figure is marketing. What the resident owes is on the
    // lease and is changed by a renewal, never from a unit form.
    const [{ rent_minor: contractedAfter }] = await ownerSql()<{ rent_minor: string }[]>`
      select rent_minor::text from leases where id = ${leaseId}
    `;
    expect(contractedAfter).toBe(contractedBefore);
  });

  /* -------------------------------------------------------------- retiring */

  it('refuses to retire a unit somebody is living in, naming the lease', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        retireUnit(tx, org.organisationId, org.adminUserId, {
          unitId: occupiedUnitId, reason: 'Converting it to a storeroom.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    // The refusal names the lease in the way, not just "cannot".
    await expect(
      as(org.adminUserId, (tx) =>
        retireUnit(tx, org.organisationId, org.adminUserId, {
          unitId: occupiedUnitId, reason: 'Converting it to a storeroom.',
        }),
      ),
    ).rejects.toThrow(/LSE-/);

    const [unit] = await ownerSql()<{ status: string }[]>`
      select status::text from units where id = ${occupiedUnitId}
    `;
    expect(unit!.status).toBe('active');
  });

  it('refuses to retire a unit with a half-finished draft lease on it', async () => {
    // A draft is somebody's work in progress. Retiring the unit under it would
    // orphan the draft without a word.
    const draft = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: emptyUnitId, startDate: '2027-01-01', endDate: '2027-12-31',
        rentMinor: R('6500'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );

    await expect(
      as(org.adminUserId, (tx) =>
        retireUnit(tx, org.organisationId, org.adminUserId, {
          unitId: emptyUnitId, reason: 'Taking it off the market.',
        }),
      ),
    ).rejects.toThrow(/draft/);

    await ownerSql()`
      update leases set status = 'cancelled' where id = ${draft.leaseId}
    `;
  });

  it('retires an empty unit, and says it is not a deletion', async () => {
    await as(org.adminUserId, (tx) =>
      retireUnit(tx, org.organisationId, org.adminUserId, {
        unitId: emptyUnitId, reason: 'Taken off the market pending roof repairs.',
      }),
    );

    const [unit] = await ownerSql()<{ status: string }[]>`
      select status::text from units where id = ${emptyUnitId}
    `;
    expect(unit!.status).toBe('archived');

    const [entry] = await ownerSql()<
      { after_state: Record<string, unknown>; reason: string | null }[]
    >`
      select after_state, reason from audit_events
       where organisation_id = ${org.organisationId} and action = 'unit.retired'
       order by occurred_at desc limit 1
    `;
    // "Retired" reads like "removed" and is not: the unit, its leases and its
    // history all stay exactly where they are.
    expect(entry!.after_state.ledgerEffect).toBe('none');
    expect(entry!.reason).toContain('roof repairs');

    // The cancelled draft lease is still there to read.
    const [{ total }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from leases where unit_id = ${emptyUnitId}
    `;
    expect(total).toBe('1');
  });

  it('refuses to retire the same unit twice', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        retireUnit(tx, org.organisationId, org.adminUserId, {
          unitId: emptyUnitId, reason: 'Retiring it again.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('requires a reason to retire', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        retireUnit(tx, org.organisationId, org.adminUserId, {
          unitId: occupiedUnitId, reason: 'no',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /* ------------------------------------------------------------- archiving */

  it('refuses to archive a property whose units are still active', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        archiveProperty(tx, org.organisationId, org.adminUserId, {
          propertyId, reason: 'Sold to a third party.',
        }),
      ),
    ).rejects.toThrow(/active unit/);

    // The count of occupied units is stated, because that is what makes the
    // refusal act on rather than argue with.
    await expect(
      as(org.adminUserId, (tx) =>
        archiveProperty(tx, org.organisationId, org.adminUserId, {
          propertyId, reason: 'Sold to a third party.',
        }),
      ),
    ).rejects.toThrow(/live lease/);
  });

  it('archives once every unit is retired, and reinstates without reviving them', async () => {
    // End the lease properly, then retire the unit it was on.
    await as(org.adminUserId, (tx) =>
      terminateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, effectiveDate: '2026-06-30',
        reason: 'Resident gave notice and moved out.',
      }),
    );
    await as(org.adminUserId, (tx) =>
      retireUnit(tx, org.organisationId, org.adminUserId, {
        unitId: occupiedUnitId, reason: 'Property sold; unit no longer let.',
      }),
    );

    await as(org.adminUserId, (tx) =>
      archiveProperty(tx, org.organisationId, org.adminUserId, {
        propertyId, reason: 'Sold to a third party on 30 June 2026.',
      }),
    );
    const archived = await as(org.adminUserId, (tx) =>
      getPropertyDetails(tx, org.organisationId, propertyId),
    );
    expect(archived!.status).toBe('archived');
    expect(archived!.activeUnitCount).toBe(0);
    // Archiving deleted nothing: both units are still counted.
    expect(archived!.unitCount).toBe(2);

    // A retired unit cannot be brought back under an archived property.
    await expect(
      as(org.adminUserId, (tx) =>
        reinstateUnit(tx, org.organisationId, org.adminUserId, {
          unitId: emptyUnitId, reason: 'Roof repaired, back on the market.',
        }),
      ),
    ).rejects.toThrow(/property itself is archived/);

    await as(org.adminUserId, (tx) =>
      reinstateProperty(tx, org.organisationId, org.adminUserId, {
        propertyId, reason: 'The sale fell through.',
      }),
    );
    const back = await as(org.adminUserId, (tx) =>
      getPropertyDetails(tx, org.organisationId, propertyId),
    );
    expect(back!.status).toBe('active');
    // Each unit was retired for its own reason; undoing those in bulk would be
    // the same mistake in the other direction.
    expect(back!.activeUnitCount).toBe(0);

    await as(org.adminUserId, (tx) =>
      reinstateUnit(tx, org.organisationId, org.adminUserId, {
        unitId: emptyUnitId, reason: 'Roof repaired, back on the market.',
      }),
    );
    const reinstated = await as(org.adminUserId, (tx) =>
      getPropertyDetails(tx, org.organisationId, propertyId),
    );
    expect(reinstated!.activeUnitCount).toBe(1);
  });

  /* ------------------------------------------------------------- isolation */

  it('will not let one organisation edit another\'s property', async () => {
    const other = await createOrganisation('Elsewhere Portfolio');

    await expect(
      as(other.adminUserId, (tx) =>
        updateProperty(tx, other.organisationId, other.adminUserId, propertyId, {
          name: 'Taken over',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(
      as(other.adminUserId, (tx) =>
        retireUnit(tx, other.organisationId, other.adminUserId, {
          unitId: emptyUnitId, reason: 'Retiring somebody else\'s unit.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    const untouched = await as(org.adminUserId, (tx) =>
      getPropertyDetails(tx, org.organisationId, propertyId),
    );
    expect(untouched!.name).toBe('Protea Court North');
  });
});
