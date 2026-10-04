/**
 * Onboarding import — blueprint section 31.
 *
 * The two properties that matter most:
 *   * errors are reported BY ROW AND FIELD before anything is written;
 *   * a commit is all or nothing, so an operator never has to guess which rows
 *     landed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  arrearsAgeing, buildStatement, commitImport, importTemplate, parseMajorToMinor,
  previewImport, assertBookBalances,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

const PROPERTIES_CSV = `code,name,property_type,address_line1,suburb,city,province,postal_code,portfolio_code
PROTEA14,14 Protea Street,house,14 Protea Street,Newlands,Cape Town,Western Cape,7700,
ALOE,Aloe Court,apartment_block,"7 Aloe Avenue, Block B",Observatory,Cape Town,Western Cape,7925,
`;

const UNITS_CSV = `property_code,code,rentable_type,bedrooms,bathrooms,advertised_rent
PROTEA14,MAIN,whole_property,3,2,8500.00
ALOE,A1,apartment,2,1,6500.00
ALOE,A2,apartment,2,1,6500.00
`;

const RESIDENTS_CSV = `reference,first_name,last_name,email,phone
RES-001,Thandiwe,Mokoena,thandiwe@example.invalid,+27 82 555 0101
RES-002,Sipho,Mokoena,sipho@example.invalid,
RES-003,Lerato,Dlamini,,+27 83 555 0202
`;

const LEASES_CSV = `reference,property_code,unit_code,primary_resident_reference,co_lessee_references,start_date,end_date,rent,billing_day,deposit_required
L-2026-001,PROTEA14,MAIN,RES-001,RES-002,2026-01-01,2026-12-31,8000.00,1,8000.00
L-2026-002,ALOE,A1,RES-003,,2026-02-01,,6500.00,1,6500.00
`;

describe('Onboarding import', () => {
  let org: OrganisationFixture;

  beforeAll(async () => { org = await createOrganisation('Onboarding Co'); });
  afterAll(async () => { await closeOwner(); });

  describe('templates', () => {
    it('produces a template that parses back, with an example row', () => {
      for (const kind of ['properties', 'units', 'residents', 'leases', 'opening_balances', 'deposits'] as const) {
        const template = importTemplate(kind);
        expect(template.csv).toContain(template.columns[0]!.name);
        expect(template.columns.some((c) => c.required)).toBe(true);
        expect(template.notes.length).toBeGreaterThan(0);
      }
    });

    it('warns in the opening balance template not to restate arrears as rent', () => {
      const template = importTemplate('opening_balances');
      const notes = template.notes.join(' ');
      expect(notes).toContain('Do NOT represent historical arrears as a new month of rent');
      expect(notes).toContain('cut-off date');
    });
  });

  describe('preview', () => {
    it('reports a missing required column once, not once per row', async () => {
      const preview = await as(org.adminUserId, (tx) =>
        previewImport(tx, org.organisationId, {
          kind: 'properties', filename: 'bad.csv',
          content: 'code,name\nA,First\nB,Second\n',
        }),
      );
      expect(preview.errors).toHaveLength(1);
      expect(preview.errors[0]!.message).toContain('missing required column');
      expect(preview.errors[0]!.message).toContain('property_type');
      expect(preview.validCount).toBe(0);
    });

    it('reports errors by row and field', async () => {
      const preview = await as(org.adminUserId, (tx) =>
        previewImport(tx, org.organisationId, {
          kind: 'properties', filename: 'bad.csv',
          content:
            'code,name,property_type,address_line1,city\n' +
            'GOOD,Fine House,house,1 Good Road,Cape Town\n' +
            ',Missing Code,house,2 Road,Cape Town\n' +
            'BAD3,No Type,castle,3 Road,Cape Town\n' +
            'BAD4,No City,house,4 Road,\n',
        }),
      );
      expect(preview.validCount).toBe(1);
      const byLine = new Map(preview.errors.map((e) => [e.line, e]));
      expect(byLine.get(3)!.field).toBe('code');
      expect(byLine.get(4)!.field).toBe('property_type');
      expect(byLine.get(4)!.message).toContain('castle');
      expect(byLine.get(5)!.field).toBe('city');
    });

    it('catches a duplicate code within the same file', async () => {
      const preview = await as(org.adminUserId, (tx) =>
        previewImport(tx, org.organisationId, {
          kind: 'properties', filename: 'dup.csv',
          content:
            'code,name,property_type,address_line1,city\n' +
            'SAME,First,house,1 Road,Cape Town\n' +
            'SAME,Second,house,2 Road,Cape Town\n',
        }),
      );
      expect(preview.errors.some((e) => e.message.includes('more than once in this file'))).toBe(true);
    });

    it('writes nothing during a preview', async () => {
      const [before] = await ownerSql()<{ c: string }[]>`
        select count(*)::text as c from properties where organisation_id = ${org.organisationId}
      `;
      await as(org.adminUserId, (tx) =>
        previewImport(tx, org.organisationId, {
          kind: 'properties', filename: 'ok.csv', content: PROPERTIES_CSV,
        }),
      );
      const [after] = await ownerSql()<{ c: string }[]>`
        select count(*)::text as c from properties where organisation_id = ${org.organisationId}
      `;
      expect(after!.c).toBe(before!.c);
    });
  });

  describe('the blueprint import order', () => {
    it('imports properties', async () => {
      const result = await as(org.adminUserId, (tx) =>
        commitImport(tx, org.organisationId, org.adminUserId, {
          kind: 'properties', filename: 'properties.csv', content: PROPERTIES_CSV,
        }),
      );
      expect(result.importedCount).toBe(2);

      const [row] = await ownerSql()<{ address_line1: string }[]>`
        select address_line1 from properties
        where organisation_id = ${org.organisationId} and code = 'ALOE'
      `;
      // The quoted address containing a comma survived intact.
      expect(row!.address_line1).toBe('7 Aloe Avenue, Block B');
    });

    it('refuses units whose property does not exist yet', async () => {
      const preview = await as(org.adminUserId, (tx) =>
        previewImport(tx, org.organisationId, {
          kind: 'units', filename: 'units.csv',
          content: 'property_code,code\nNOSUCH,MAIN\n',
        }),
      );
      expect(preview.errors[0]!.message).toContain('Import properties first');
    });

    it('imports units', async () => {
      const result = await as(org.adminUserId, (tx) =>
        commitImport(tx, org.organisationId, org.adminUserId, {
          kind: 'units', filename: 'units.csv', content: UNITS_CSV,
        }),
      );
      expect(result.importedCount).toBe(3);
    });

    it('imports residents without requiring an email address', async () => {
      const result = await as(org.adminUserId, (tx) =>
        commitImport(tx, org.organisationId, org.adminUserId, {
          kind: 'residents', filename: 'residents.csv', content: RESIDENTS_CSV,
        }),
      );
      expect(result.importedCount).toBe(3);

      const [noEmail] = await ownerSql()<{ email: string | null; count: string }[]>`
        select email, count(*) over ()::text as count from resident_profiles
        where organisation_id = ${org.organisationId} and first_name = 'Lerato'
      `;
      expect(noEmail!.email).toBeNull();
    });

    it('imports leases with joint parties, a rent schedule and occupancy', async () => {
      const result = await as(org.adminUserId, (tx) =>
        commitImport(tx, org.organisationId, org.adminUserId, {
          kind: 'leases', filename: 'leases.csv', content: LEASES_CSV,
        }),
      );
      expect(result.importedCount).toBe(2);

      const [lease] = await ownerSql()<{ id: string; status: string; execution_exception_reason: string }[]>`
        select id, status::text, execution_exception_reason from leases
        where organisation_id = ${org.organisationId} and reference = 'L-2026-001'
      `;
      expect(lease!.status).toBe('active');
      // Activation evidence is recorded honestly: the contract is held offline.
      expect(lease!.execution_exception_reason).toContain('held by the operator outside PropertyOS');

      const parties = await ownerSql()<{ role: string }[]>`
        select role::text from lease_parties where lease_id = ${lease!.id} order by role
      `;
      expect(parties.map((p) => p.role)).toEqual(['co_lessee', 'primary_resident']);

      const [schedule] = await ownerSql()<{ amount_minor: string }[]>`
        select amount_minor::text from charge_schedules where lease_id = ${lease!.id} and category = 'rent'
      `;
      expect(BigInt(schedule!.amount_minor)).toBe(R('8000'));

      const [occupancy] = await ownerSql()<{ c: string }[]>`
        select count(*)::text as c from occupancy_intervals where lease_id = ${lease!.id}
      `;
      expect(occupancy!.c).toBe('1');
    });

    it('reports WHICH lease a new row would clash with', async () => {
      const preview = await as(org.adminUserId, (tx) =>
        previewImport(tx, org.organisationId, {
          kind: 'leases', filename: 'clash.csv',
          content:
            'reference,property_code,unit_code,primary_resident_reference,start_date,end_date,rent\n' +
            'L-CLASH,PROTEA14,MAIN,RES-001,2026-06-01,2026-12-31,8000.00\n',
        }),
      );
      expect(preview.errors[0]!.message).toContain('overlaps existing lease L-2026-001');
      expect(preview.errors[0]!.field).toBe('start_date');
    });
  });

  describe('opening balances', () => {
    const OPENING_CSV = `lease_reference,description,amount,due_date
L-2026-001,"Rent arrears, November 2025",1000.00,2025-11-01
L-2026-001,"Water, December 2025",350.00,2025-12-07
`;

    it('refuses to commit without a cut-off date, source reference and approver', async () => {
      for (const missing of [
        { sourceReference: 'Ledger export 2025-12-31', approvedByUserId: org.adminUserId },
        { cutOffDate: '2025-12-31', approvedByUserId: org.adminUserId },
        { cutOffDate: '2025-12-31', sourceReference: 'Ledger export 2025-12-31' },
      ]) {
        await expect(
          as(org.adminUserId, (tx) =>
            commitImport(tx, org.organisationId, org.adminUserId, {
              kind: 'opening_balances', filename: 'ob.csv', content: OPENING_CSV, ...missing,
            }),
          ),
        ).rejects.toMatchObject({ code: 'validation_failed' });
      }
    });

    it('posts arrears as opening balances, NOT as a new month of rent', async () => {
      const approver = await addMember(org.organisationId, 'Ann Accountant', ['finance_approver']);
      const result = await as(org.adminUserId, (tx) =>
        commitImport(tx, org.organisationId, org.adminUserId, {
          kind: 'opening_balances', filename: 'ob.csv', content: OPENING_CSV,
          cutOffDate: '2025-12-31',
          sourceReference: 'Accountant ledger export, signed 2025-12-31',
          approvedByUserId: approver,
        }),
      );
      expect(result.importedCount).toBe(2);
      expect(result.totalMinor).toBe(R('1350'));
      expect(result.limitedAgeingDetail).toBe(false);

      const [doc] = await ownerSql()<{ document_type: string; total_minor: string }[]>`
        select cd.document_type::text, cd.total_minor::text
        from charge_documents cd join leases l on l.id = cd.lease_id
        where l.reference = 'L-2026-001' and cd.import_batch_id is not null
      `;
      // Crucially NOT 'rent_invoice'.
      expect(doc!.document_type).toBe('opening_balance');
      expect(BigInt(doc!.total_minor)).toBe(R('1350'));

      // And no rent income was recognised for money earned before we held the
      // records: the balancing side is opening equity.
      const [income] = await ownerSql()<{ c: string }[]>`
        select count(*)::text as c
        from journal_lines jl
        join accounts a on a.id = jl.account_id
        join journals j on j.id = jl.journal_id
        where j.organisation_id = ${org.organisationId}
          and j.source = 'opening_balance' and a.system_role = 'rental_income'
      `;
      expect(income!.c).toBe('0');

      await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
    });

    it('keeps the ORIGINAL due dates so arrears ageing is accurate', async () => {
      const lines = await ownerSql()<{ due_date: string; description: string }[]>`
        select cl.due_date::text, cl.description
        from charge_lines cl
        join charge_documents cd on cd.id = cl.document_id
        join leases l on l.id = cl.lease_id
        where l.reference = 'L-2026-001' and cd.document_type = 'opening_balance'
        order by cl.line_number
      `;
      // Not the cut-off date, and not today: the dates the operator supplied.
      expect(lines[0]!.due_date).toBe('2025-11-01');
      expect(lines[1]!.due_date).toBe('2025-12-07');

      const ageing = await as(org.adminUserId, (tx) => arrearsAgeing(tx, org.organisationId));
      const row = ageing.rows.find((r) => r.leaseReference === 'L-2026-001')!;
      expect(row.totalMinor).toBe(R('1350'));
      // Both are long overdue relative to the test clock, so they age correctly
      // rather than all landing in "not yet due".
      expect(row.daysOver90Minor).toBe(R('1350'));
    });

    it('records limited ageing detail when only a total was supplied', async () => {
      const approver = await addMember(org.organisationId, 'Bea Bookkeeper', ['finance_approver']);
      const result = await as(org.adminUserId, (tx) =>
        commitImport(tx, org.organisationId, org.adminUserId, {
          kind: 'opening_balances', filename: 'ob-total.csv',
          content: 'lease_reference,description,amount,due_date\nL-2026-002,Balance brought forward,2400.00,\n',
          cutOffDate: '2026-01-31',
          sourceReference: 'Operator spreadsheet, one total per resident',
          approvedByUserId: approver,
        }),
      );
      // The system records that the detail is limited rather than inventing an age.
      expect(result.limitedAgeingDetail).toBe(true);

      const [batch] = await ownerSql()<{ limited_ageing_detail: boolean; source_reference: string }[]>`
        select limited_ageing_detail, source_reference from import_batches where id = ${result.batchId}
      `;
      expect(batch!.limited_ageing_detail).toBe(true);
      expect(batch!.source_reference).toContain('one total per resident');
    });

    it('shows the imported balance on the resident statement', async () => {
      const [lease] = await ownerSql()<{ id: string }[]>`
        select id from leases where organisation_id = ${org.organisationId} and reference = 'L-2026-001'
      `;
      const statement = await as(org.adminUserId, (tx) =>
        buildStatement(tx, org.organisationId, { leaseId: lease!.id, cutOff: '2026-06-30' }),
      );
      expect(statement.closingReceivableMinor).toBe(R('1350'));
      expect(statement.lines.some((l) => l.description.includes('Rent arrears'))).toBe(true);
    });

    it('records who approved the figures, for the audit trail', async () => {
      const [event] = await ownerSql()<{ reason: string; after_state: unknown }[]>`
        select reason, after_state from audit_events
        where organisation_id = ${org.organisationId}
          and action = 'import.opening_balances.committed'
        order by id limit 1
      `;
      expect(event!.reason).toContain('signed 2025-12-31');
      expect(JSON.stringify(event!.after_state)).toContain('cutOffDate');
    });
  });

  describe('deposits', () => {
    it('imports deposits as a liability, separate from arrears', async () => {
      const result = await as(org.adminUserId, (tx) =>
        commitImport(tx, org.organisationId, org.adminUserId, {
          kind: 'deposits', filename: 'deposits.csv',
          content:
            'lease_reference,amount_held,holder,holder_reference,received_on\n' +
            'L-2026-001,8000.00,landlord,FNB 62xxxx1234,2026-01-01\n',
        }),
      );
      expect(result.importedCount).toBe(1);
      expect(result.totalMinor).toBe(R('8000'));

      const [lease] = await ownerSql()<{ id: string }[]>`
        select id from leases where organisation_id = ${org.organisationId} and reference = 'L-2026-001'
      `;
      const statement = await as(org.adminUserId, (tx) =>
        buildStatement(tx, org.organisationId, { leaseId: lease!.id, cutOff: '2026-06-30' }),
      );
      // The deposit is held and reported, and has NOT reduced the arrears.
      expect(statement.depositHeldMinor).toBe(R('8000'));
      expect(statement.closingReceivableMinor).toBe(R('1350'));

      // No interest was invented.
      const [interest] = await ownerSql()<{ c: string }[]>`
        select count(*)::text as c from deposit_events
        where organisation_id = ${org.organisationId} and event_type = 'interest_credited'
      `;
      expect(interest!.c).toBe('0');

      await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
    });

    it('refuses a second deposit account for the same lease', async () => {
      const preview = await as(org.adminUserId, (tx) =>
        previewImport(tx, org.organisationId, {
          kind: 'deposits', filename: 'again.csv',
          content:
            'lease_reference,amount_held,holder,received_on\n' +
            'L-2026-001,8000.00,landlord,2026-01-01\n',
        }),
      );
      expect(preview.errors[0]!.message).toContain('already exists');
    });
  });

  describe('atomicity', () => {
    it('commits nothing when any row is invalid', async () => {
      const [before] = await ownerSql()<{ c: string }[]>`
        select count(*)::text as c from properties where organisation_id = ${org.organisationId}
      `;
      await expect(
        as(org.adminUserId, (tx) =>
          commitImport(tx, org.organisationId, org.adminUserId, {
            kind: 'properties', filename: 'partial.csv',
            content:
              'code,name,property_type,address_line1,city\n' +
              'VALID1,Good One,house,1 Road,Cape Town\n' +
              'VALID2,Good Two,house,2 Road,Cape Town\n' +
              ',Missing Code,house,3 Road,Cape Town\n',
          }),
        ),
      ).rejects.toMatchObject({ code: 'validation_failed' });

      const [after] = await ownerSql()<{ c: string }[]>`
        select count(*)::text as c from properties where organisation_id = ${org.organisationId}
      `;
      // The two valid rows were NOT committed. All or nothing.
      expect(after!.c).toBe(before!.c);
    });

    it('leaves no orphan batch row behind when a commit fails', async () => {
      const [before] = await ownerSql()<{ c: string }[]>`
        select count(*)::text as c from import_batches where organisation_id = ${org.organisationId}
      `;
      await expect(
        as(org.adminUserId, (tx) =>
          commitImport(tx, org.organisationId, org.adminUserId, {
            kind: 'properties', filename: 'fails.csv',
            content: 'code,name,property_type,address_line1,city\n,Bad,house,1 Road,Cape Town\n',
          }),
        ),
      ).rejects.toThrow();
      const [after] = await ownerSql()<{ c: string }[]>`
        select count(*)::text as c from import_batches where organisation_id = ${org.organisationId}
      `;
      expect(after!.c).toBe(before!.c);
    });

    it('refuses to commit the same file twice', async () => {
      await expect(
        as(org.adminUserId, (tx) =>
          commitImport(tx, org.organisationId, org.adminUserId, {
            kind: 'properties', filename: 'properties-again.csv', content: PROPERTIES_CSV,
          }),
        ),
      ).rejects.toThrow();
    });

    it('records every committed batch for later inspection', async () => {
      const batches = await ownerSql()<{ kind: string; status: string; imported_count: number }[]>`
        select kind::text, status::text, imported_count from import_batches
        where organisation_id = ${org.organisationId} and status = 'committed'
        order by created_at
      `;
      expect(batches.map((b) => b.kind)).toEqual([
        'properties', 'units', 'residents', 'leases', 'opening_balances', 'opening_balances', 'deposits',
      ]);
    });
  });

  describe('permissions', () => {
    it('refuses an import to someone without property.create', async () => {
      const reader = await addMember(org.organisationId, 'Read Only', ['owner_viewer']);
      await expect(
        as(reader, (tx) =>
          previewImport(tx, org.organisationId, {
            kind: 'properties', filename: 'x.csv', content: PROPERTIES_CSV,
          }),
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('requires billing.post to import money, not just property.create', async () => {
      const manager = await addMember(org.organisationId, 'Property Manager Only', ['property_manager']);
      await expect(
        as(manager, (tx) =>
          commitImport(tx, org.organisationId, manager, {
            kind: 'opening_balances', filename: 'ob.csv',
            content: 'lease_reference,description,amount,due_date\nL-2026-002,Arrears,100.00,2025-11-01\n',
            cutOffDate: '2025-12-31', sourceReference: 'Spreadsheet', approvedByUserId: org.adminUserId,
          }),
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });
});

describe('Template guidance lines', () => {
  let org: OrganisationFixture;
  beforeAll(async () => { org = await createOrganisation('Template Guidance Co'); });
  afterAll(async () => { await closeOwner(); });

  it('imports a template that still carries its guidance comments', async () => {
    const template = importTemplate('properties');
    // Exactly what the download route produces, guidance lines and all.
    const asDownloaded = [
      '# PropertyOS import template: properties',
      '#',
      ...template.columns.map((c) => `# ${c.name}: ${c.description}`),
      '# NOTE: Import properties first.',
      '',
      'code,name,property_type,address_line1,city',
      'GUIDE1,Guidance House,house,1 Guidance Road,Cape Town',
      '',
    ].join('\r\n');

    const preview = await as(org.adminUserId, (tx) =>
      previewImport(tx, org.organisationId, {
        kind: 'properties', filename: 'with-guidance.csv', content: asDownloaded,
      }),
    );
    // The operator forgetting to delete the comments is not an error.
    expect(preview.errors).toHaveLength(0);
    expect(preview.validCount).toBe(1);

    const result = await as(org.adminUserId, (tx) =>
      commitImport(tx, org.organisationId, org.adminUserId, {
        kind: 'properties', filename: 'with-guidance.csv', content: asDownloaded,
      }),
    );
    expect(result.importedCount).toBe(1);
  });

  it('does not strip a # that appears inside a value', async () => {
    const preview = await as(org.adminUserId, (tx) =>
      previewImport(tx, org.organisationId, {
        kind: 'properties', filename: 'hash.csv',
        content:
          'code,name,property_type,address_line1,city\n' +
          'HASH1,"Unit #4, The Mews",house,"Unit #4, The Mews",Cape Town\n',
      }),
    );
    expect(preview.errors).toHaveLength(0);
    expect(preview.sample[0]!.name).toBe('Unit #4, The Mews');
  });
});
