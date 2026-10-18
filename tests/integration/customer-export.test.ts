/**
 * The customer export (§24).
 *
 * A customer who cannot get their tenancy history out is not a customer. What
 * these tests hold in place is less the presence of the data than the three
 * things the export must refuse to do: read past the permission model, carry a
 * sealed number out in bulk, or let one organisation's archive contain
 * another's records.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import {
  activateLease, buildCustomerExport, createResident, createStandaloneHouse,
  draftLease, parseMajorToMinor, postCharge, setResidentIdentityNumber,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

/**
 * Reads an archive back through its CENTRAL DIRECTORY, which is how a real
 * unzip tool finds entries. Walking the local headers instead would pass on an
 * archive no other tool could open.
 */
function readZip(archive: Buffer): Record<string, string> {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd, 'no end-of-central-directory record').toBeGreaterThan(-1);
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  const files: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(dataStart, dataStart + compressedSize);

    files[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** The rows of a CSV, as objects, for assertions that read like the file. */
function rows(csv: string): Array<Record<string, string>> {
  const lines = csv.trim().split('\r\n');
  const headers = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    // Enough parsing for these fixtures: no embedded commas in what they write.
    const values = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

describe('Customer export', () => {
  let org: OrganisationFixture;
  let neighbour: OrganisationFixture;
  let leaseId: string;
  let residentId: string;

  beforeAll(async () => {
    org = await createOrganisation('Export Co');
    neighbour = await createOrganisation('Neighbour Co');

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Exportable', lastName: 'Resident',
      }),
    );
    residentId = resident.residentId;
    // Identity capture is its own command behind its own permission; the
    // number is sealed and only the last four digits are kept in the clear.
    await as(org.adminUserId, (tx) =>
      setResidentIdentityNumber(tx, org.organisationId, org.adminUserId, {
        residentId, identityNumber: '9001015800085',
      }),
    );

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Export House', code: 'EXP1', propertyType: 'house',
        addressLine1: '1 Export Road', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', rentMinor: R('8000'),
        depositRequiredMinor: R('8000'),
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
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice',
        issueDate: '2026-02-01', dueDate: '2026-02-01',
        periodStart: '2026-02-01', periodEnd: '2026-02-28',
        lines: [{
          category: 'rent', description: 'Monthly rent February 2026',
          amountMinor: R('8000'), dueDate: '2026-02-01',
        }],
      }),
    );

    // The neighbour gets a property with a distinctive name, so "absent from
    // the archive" is a real absence rather than an empty database.
    await as(neighbour.adminUserId, (tx) =>
      createStandaloneHouse(tx, neighbour.organisationId, neighbour.adminUserId, {
        name: 'Neighbour Secret House', code: 'NBR1', propertyType: 'house',
        addressLine1: '9 Other Street', city: 'Durban',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('carries the records §24 asks for, and says what each file is', async () => {
    const archive = await as(org.adminUserId, (tx) =>
      buildCustomerExport(tx, org.organisationId, org.adminUserId),
    );
    const files = readZip(archive.bytes);

    for (const expected of [
      'README.txt', 'portfolios.csv', 'properties.csv', 'units.csv', 'residents.csv',
      'lease_parties.csv', 'leases.csv', 'charge_documents.csv', 'charge_lines.csv',
      'receipts.csv', 'payment_allocations.csv', 'deposit_accounts.csv',
      'deposit_events.csv', 'expenses.csv', 'vendors.csv', 'attachments.csv',
    ]) {
      expect(Object.keys(files)).toContain(expected);
    }

    expect(rows(files['properties.csv']!).map((r) => r.code)).toContain('EXP1');
    expect(rows(files['leases.csv']!).map((r) => r.id)).toContain(leaseId);

    const lines = rows(files['charge_lines.csv']!);
    expect(lines).toHaveLength(1);
    // Minor units, not a decimal a spreadsheet could round.
    expect(lines[0]!.amount_minor).toBe('800000');

    // The README is the "documented" half of a documented export: it names
    // every file and explains the one thing a reader will otherwise get wrong.
    const readme = files['README.txt']!;
    expect(readme).toContain('Export Co');
    expect(readme).toContain('185000 is R1,850.00');
    expect(readme).toContain('charge_lines.csv');
    expect(readme).toContain('WHAT IS DELIBERATELY NOT HERE');
  });

  it('carries the last four digits of an identity number, never the number', async () => {
    const archive = await as(org.adminUserId, (tx) =>
      buildCustomerExport(tx, org.organisationId, org.adminUserId),
    );
    const files = readZip(archive.bytes);

    const resident = rows(files['residents.csv']!).find((r) => r.id === residentId);
    expect(resident?.identity_number_last4).toBe('0085');

    // The whole archive, not just that file: a sealed number must not appear
    // anywhere in it, and nor must the ciphertext.
    const everything = Object.values(files).join('\n');
    expect(everything).not.toContain('9001015800085');
    expect(everything).not.toContain('identity_number_cipher');
  });

  it('contains nothing belonging to another organisation', async () => {
    const archive = await as(org.adminUserId, (tx) =>
      buildCustomerExport(tx, org.organisationId, org.adminUserId),
    );
    const everything = Object.values(readZip(archive.bytes)).join('\n');

    expect(everything).not.toContain('Neighbour Secret House');
    expect(everything).not.toContain(neighbour.organisationId);
  });

  it('refuses a member who does not hold the export permission', async () => {
    const manager = await addMember(org.organisationId, 'Portfolio Only', ['portfolio_manager']);
    await expect(
      as(manager, (tx) => buildCustomerExport(tx, org.organisationId, manager)),
    ).rejects.toThrow(/customer\.export/);
  });

  it('is scoped to what the person running it can see', async () => {
    // A second property the scoped manager is not assigned to.
    const other = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Out Of Scope House', code: 'EXP2', propertyType: 'house',
        addressLine1: '2 Export Road', city: 'Cape Town',
      }),
    );
    const [property] = await ownerSql()<{ id: string }[]>`
      select id from properties where organisation_id = ${org.organisationId} and code = 'EXP1'
    `;
    const scoped = await addMember(
      org.organisationId, 'Scoped Admin', ['org_admin'],
      { type: 'property', propertyId: property!.id },
    );
    // org_admin requires a second factor, which `as` supplies as aal2.
    const archive = await as(scoped, (tx) =>
      buildCustomerExport(tx, org.organisationId, scoped),
    );
    const files = readZip(archive.bytes);
    const codes = rows(files['properties.csv']!).map((r) => r.code);

    expect(codes).toContain('EXP1');
    // Not a bug in the export: the screens withhold it too, and an export that
    // returned more than the screens would be a way around the scope.
    expect(codes).not.toContain('EXP2');
    expect(other.unitId).toBeTruthy();
  });

  it('records who exported, when, and how much — without the data itself', async () => {
    const before = await ownerSql()<{ count: string }[]>`
      select count(*)::text from audit_events
       where organisation_id = ${org.organisationId} and action = 'customer.exported'
    `;
    await as(org.adminUserId, (tx) =>
      buildCustomerExport(tx, org.organisationId, org.adminUserId),
    );
    const [entry] = await ownerSql()<{ actor_user_id: string; after_state: Record<string, unknown> }[]>`
      select actor_user_id, after_state from audit_events
       where organisation_id = ${org.organisationId} and action = 'customer.exported'
       order by occurred_at desc limit 1
    `;
    const after = await ownerSql()<{ count: string }[]>`
      select count(*)::text from audit_events
       where organisation_id = ${org.organisationId} and action = 'customer.exported'
    `;

    expect(Number(after[0]!.count)).toBe(Number(before[0]!.count) + 1);
    expect(entry!.actor_user_id).toBe(org.adminUserId);
    // Counts and a size: enough to answer "what left", holding none of it.
    const state = entry!.after_state as { counts: Record<string, number>; byteSize: number };
    expect(state.counts['leases.csv']).toBe(1);
    expect(state.byteSize).toBeGreaterThan(0);
    expect(JSON.stringify(state)).not.toContain('Export House');
  });
});
