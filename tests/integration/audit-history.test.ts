/**
 * Reading the audit trail.
 *
 * Every command writes an entry in the same transaction as the change it
 * describes, and nothing could read one back: the trail existed for a dispute
 * nobody could open.
 *
 * Three rules under test. Reading it is a permission of its own, because the
 * trail records what every colleague did and the reasons they typed. A
 * property-scoped member is refused rather than shown a filtered trail,
 * because an entry records the resource it changed and not the property that
 * resource belongs to — there is no honest filter. And nothing here can
 * unredact: a sensitive value was replaced before it was written, so it was
 * never in the trail to be read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  addBankAccount, auditFacets, auditHistoryFor, changedFields, createResident,
  createStandaloneHouse, listAuditEvents, parseMajorToMinor, updateProperty,
  updateResident, retireUnit, createUnit, setResidentIdentityNumber,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Audit history', () => {
  let org: OrganisationFixture;
  let propertyId: string;
  let spareUnitId: string;
  let residentId: string;
  let manager: string;

  beforeAll(async () => {
    org = await createOrganisation('Audit Co');
    manager = await addMember(org.organisationId, 'Prop Manager', ['property_manager']);

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
      }),
    );
    residentId = resident.residentId;
    // Capturing an identity number is its own command behind its own
    // permission. Passing it to createResident looked like capture and was
    // not: the schema has no such field, so the key was silently dropped and
    // the "never unredacts" test below was describing a number that was never
    // there.
    await as(org.adminUserId, (tx) =>
      setResidentIdentityNumber(tx, org.organisationId, org.adminUserId, {
        residentId, identityNumber: '8001015009087',
      }),
    );

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Audit House', code: 'AUD', propertyType: 'apartment_block',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    propertyId = house.propertyId;

    const spare = await as(org.adminUserId, (tx) =>
      createUnit(tx, org.organisationId, org.adminUserId, {
        propertyId, code: 'B2', advertisedRentMinor: R('6500'),
      }),
    );
    spareUnitId = spare.unitId;

    // A handful of real changes to read back.
    await as(org.adminUserId, (tx) =>
      updateProperty(tx, org.organisationId, org.adminUserId, propertyId, {
        addressLine1: '14 Protea Avenue',
        reason: 'The deed says Avenue; the original capture said Street.',
      }),
    );
    await as(org.adminUserId, (tx) =>
      retireUnit(tx, org.organisationId, org.adminUserId, {
        unitId: spareUnitId, reason: 'Taken off the market pending roof repairs.',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  /* ---------------------------------------------------------- reading it */

  it('reads back what happened, with the actor and the reason', async () => {
    const page = await as(org.adminUserId, (tx) =>
      listAuditEvents(tx, org.organisationId, {}),
    );
    expect(page.entries.length).toBeGreaterThan(3);

    const correction = page.entries.find((e) => e.action === 'property.updated')!;
    expect(correction.actorName).toContain('Admin');
    expect(correction.reason).toContain('deed says Avenue');
    expect(correction.before!.addressLine1).toBe('14 Protea Street');
    expect(correction.after!.addressLine1).toBe('14 Protea Avenue');

    // Newest first: the question is always "what just happened".
    const ids = page.entries.map((e) => Number(e.id));
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
  });

  it('narrows to one record\'s own history', async () => {
    const history = await as(org.adminUserId, (tx) =>
      auditHistoryFor(tx, org.organisationId, {
        resourceType: 'unit', resourceId: spareUnitId,
      }),
    );
    // Created, then retired. Nothing from the other unit or the property.
    expect(history.map((e) => e.action)).toEqual(['unit.retired', 'unit.created']);
    expect(history.every((e) => e.resourceId === spareUnitId)).toBe(true);
  });

  it('filters by an action prefix, so one word covers a module', async () => {
    const page = await as(org.adminUserId, (tx) =>
      listAuditEvents(tx, org.organisationId, { action: 'unit.' }),
    );
    expect(page.entries.length).toBeGreaterThanOrEqual(3);
    expect(page.entries.every((e) => e.action.startsWith('unit.'))).toBe(true);
  });

  it('includes the whole of the end day rather than up to its midnight', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const page = await as(org.adminUserId, (tx) =>
      listAuditEvents(tx, org.organisationId, { from: today, to: today }),
    );
    // Everything in this suite happened today, so a range of today-to-today
    // that excluded the end day would come back empty.
    expect(page.entries.length).toBeGreaterThan(3);
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        listAuditEvents(tx, org.organisationId, { from: '2026-03-31', to: '2026-01-01' }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('pages without losing or repeating an entry', async () => {
    const first = await as(org.adminUserId, (tx) =>
      listAuditEvents(tx, org.organisationId, { limit: 2 }),
    );
    expect(first.entries).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await as(org.adminUserId, (tx) =>
      listAuditEvents(tx, org.organisationId, { limit: 2, before: first.nextCursor! }),
    );
    const overlap = second.entries.filter(
      (e) => first.entries.some((f) => f.id === e.id),
    );
    // A keyset cursor rather than an offset: an entry written between the two
    // reads must not shift the page and hide a row.
    expect(overlap).toHaveLength(0);
    expect(Number(second.entries[0]!.id)).toBeLessThan(Number(first.nextCursor!));
  });

  it('offers only filters that match something', async () => {
    const facets = await as(org.adminUserId, (tx) =>
      auditFacets(tx, org.organisationId),
    );
    expect(facets.actions.some((a) => a.action === 'unit.retired')).toBe(true);
    expect(facets.resourceTypes.some((r) => r.resourceType === 'unit')).toBe(true);
    expect(facets.actions.every((a) => a.count > 0)).toBe(true);
    // Read from the data, so a module that adds an action gets a filter
    // without anybody maintaining a list.
    expect(facets.actors.some((a) => a.count > 0)).toBe(true);
  });

  /* -------------------------------------------------------- what it shows */

  it('shows which fields changed, and nothing that did not', async () => {
    const page = await as(org.adminUserId, (tx) =>
      listAuditEvents(tx, org.organisationId, { action: 'property.updated' }),
    );
    const changes = changedFields(page.entries[0]!);
    expect(changes.map((c) => c.field)).toEqual(['addressLine1']);
    expect(changes[0]!.from).toBe('14 Protea Street');
    expect(changes[0]!.to).toBe('14 Protea Avenue');
  });

  it('shows every field of a creation, because all of it is new', async () => {
    const page = await as(org.adminUserId, (tx) =>
      listAuditEvents(tx, org.organisationId, { action: 'unit.created' }),
    );
    const changes = changedFields(page.entries[0]!);
    expect(changes.length).toBeGreaterThan(1);
    expect(changes.every((c) => c.from === undefined)).toBe(true);
  });

  /* ------------------------------------------------------ never unredacts */

  it('cannot reveal a sensitive value, because it was never written', async () => {
    // An identity number was captured on the resident and a bank account
    // number on the organisation. Both are sealed, and the audit entry held
    // '[redacted]' from the moment it was written.
    await as(org.adminUserId, (tx) =>
      addBankAccount(tx, org.organisationId, org.adminUserId, {
        label: 'Operating', bankName: 'Demo Bank', accountHolder: 'Audit Co',
        accountNumber: '62001234567', branchCode: '250655',
        reason: 'Opened for the integration suite.',
      }),
    );
    await as(org.adminUserId, (tx) =>
      updateResident(tx, org.organisationId, org.adminUserId, {
        residentId, firstName: 'Thandi', lastName: 'Mokoena',
      }),
    );

    const page = await as(org.adminUserId, (tx) =>
      listAuditEvents(tx, org.organisationId, { limit: 200 }),
    );
    const everything = JSON.stringify(page.entries);
    expect(everything).not.toContain('8001015009087');
    expect(everything).not.toContain('62001234567');

    // Not merely absent: the trail says a value was held back, so a reader
    // knows the field was touched rather than assuming it was not.
    const withRedaction = page.entries.filter(
      (e) => JSON.stringify(e).includes('[redacted]'),
    );
    for (const entry of withRedaction) {
      expect(changedFields(entry).some((c) => c.redacted)).toBe(true);
    }
  });

  /* ------------------------------------------------------------- who may */

  it('refuses a member without the audit permission', async () => {
    const preparer = await addMember(org.organisationId, 'Fin Preparer', ['finance_preparer']);
    await expect(
      as(preparer, (tx) => listAuditEvents(tx, org.organisationId, {})),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses a property-scoped member rather than showing a partial trail', async () => {
    // Give the manager the permission AND a property-only assignment: the
    // refusal under test is about scope, not about permission.
    await ownerSql()`
      insert into role_permissions (role_key, permission_key)
      values ('property_manager', 'audit.read')
      on conflict do nothing
    `;
    const [membership] = await ownerSql()<{ id: string }[]>`
      select m.id from memberships m
       where m.organisation_id = ${org.organisationId} and m.auth_user_id = ${manager}
    `;
    await ownerSql()`
      delete from property_assignments where membership_id = ${membership!.id}
    `;
    await ownerSql()`
      insert into property_assignments (organisation_id, membership_id, scope_type, property_id)
      values (${org.organisationId}, ${membership!.id}, 'property', ${propertyId})
    `;

    await expect(
      as(manager, (tx) => listAuditEvents(tx, org.organisationId, {})),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The refusal says why, because "forbidden" alone would read as a
    // permission problem the administrator could fix by granting more.
    await expect(
      as(manager, (tx) => listAuditEvents(tx, org.organisationId, {})),
    ).rejects.toThrow(/would look complete and not be/);

    // And the same member cannot reach it through a single record either.
    await expect(
      as(manager, (tx) =>
        auditHistoryFor(tx, org.organisationId, {
          resourceType: 'unit', resourceId: spareUnitId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await ownerSql()`
      delete from role_permissions
       where role_key = 'property_manager' and permission_key = 'audit.read'
    `;
  });

  it('does not show one organisation another organisation\'s trail', async () => {
    const other = await createOrganisation('Elsewhere Audit');
    const page = await as(other.adminUserId, (tx) =>
      listAuditEvents(tx, other.organisationId, {}),
    );
    // Their own trail is not empty — creating the organisation wrote to it —
    // and none of it is ours.
    expect(page.entries.length).toBeGreaterThan(0);
    const ours = await as(org.adminUserId, (tx) =>
      listAuditEvents(tx, org.organisationId, { limit: 200 }),
    );
    const sharedIds = page.entries.filter((e) => ours.entries.some((o) => o.id === e.id));
    expect(sharedIds).toHaveLength(0);
  });

  it('stays append-only even for somebody who can read it', async () => {
    const [entry] = await ownerSql()<{ id: string }[]>`
      select id::text from audit_events
       where organisation_id = ${org.organisationId} order by id desc limit 1
    `;
    // The grant is revoked, not merely the policy: a reader cannot rewrite
    // what they are reading.
    await expect(
      ownerSql()`
        set local role propertyos_app;
        update audit_events set reason = 'rewritten' where id = ${entry!.id}::bigint
      `,
    ).rejects.toThrow();
  });
});
