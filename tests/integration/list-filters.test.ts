/**
 * Searching and paging the long lists, in the database.
 *
 * All three of these read every row in the organisation and filtered in
 * JavaScript, which is a full table read on screens a letting agent keeps open
 * all day; the documents list cut itself off at the most recent 200 and said
 * nothing, which looks exactly like having 200 documents. Blueprint §26 asks
 * for ordinary page reads under a second against 5,000 units and five years of
 * history, and no amount of filtering in the page reaches that.
 *
 * Two things are easy to get wrong once filtering moves into SQL and both look
 * fine on a short list: the total that drives "showing 1–50 of 213" is counted
 * after the filter but before the page, and a page boundary that is off by one
 * either repeats a row or loses one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, createResident, createStandaloneHouse, draftLease, parseMajorToMinor,
  registerDocument,
} from '@propertyos/domain';
import { loadLeases, loadResidents } from '../../apps/web/src/lib/queries';
import { loadDocuments } from '../../apps/web/src/lib/operations-queries';
import { readPaging } from '../../apps/web/src/lib/listing';
import {
  as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');
const page = (n: number, size = 3) => readPaging(String(n), size);

describe('List filters', () => {
  let org: OrganisationFixture;

  beforeAll(async () => {
    org = await createOrganisation('Listing Co');

    // Five residents, one of them archived: the archived one used to be
    // unreachable from anywhere in the product.
    for (const [first, last] of [
      ['Thandiwe', 'Mokoena'], ['Sipho', 'Mokoena'], ['Lerato', 'Dlamini'],
      ['Johan', 'Van der Merwe'], ['Ayesha', 'Patel'],
    ]) {
      await as(org.adminUserId, (tx) =>
        createResident(tx, org.organisationId, org.adminUserId, {
          firstName: first!, lastName: last!, email: `${first!.toLowerCase()}@listing.invalid`,
        }),
      );
    }
    await ownerSql()`
      update resident_profiles set status = 'archived'
      where organisation_id = ${org.organisationId} and last_name = 'Patel'
    `;

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Lease', lastName: 'Holder',
      }),
    );

    // Four leases across two properties, one of them still a draft.
    for (const [name, code] of [['Protea Place', 'PP'], ['Aloe Court', 'AC']]) {
      for (const suffix of ['1', '2']) {
        const house = await as(org.adminUserId, (tx) =>
          createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
            name: `${name} ${suffix}`, code: `${code}${suffix}`, propertyType: 'house',
            addressLine1: `${suffix} ${name}`, city: 'Cape Town',
          }),
        );
        const lease = await as(org.adminUserId, (tx) =>
          draftLease(tx, org.organisationId, org.adminUserId, {
            unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
            rentMinor: R('9000'),
            parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
          }),
        );
        if (suffix === '1') {
          await as(org.adminUserId, (tx) =>
            activateLease(tx, org.organisationId, org.adminUserId, {
              leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-01-01',
              executionExceptionReason: 'Contract filed offline.',
            }),
          );
        }
      }
    }

    // Seven documents, one of them quarantined.
    for (let i = 1; i <= 7; i += 1) {
      await as(org.adminUserId, (tx) =>
        registerDocument(
          tx, org.organisationId, org.adminUserId,
          {
            classification: i === 1 ? 'invoice' : 'other',
            title: i === 1 ? 'Plumber invoice 100%' : `Filing note ${i}`,
            filename: `doc-${i}.pdf`, contentType: 'application/pdf', byteSize: 1024,
          },
          i === 2
            ? { status: 'pending', detail: 'No scanner configured.' }
            : { status: 'system_generated', detail: 'Created by the test.' },
        ),
      );
    }
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------------------------- residents */

  it('hides archived residents until they are asked for', async () => {
    const live = await as(org.adminUserId, (tx) => loadResidents(tx, org.organisationId));
    expect(live.rows.map((r) => r.last_name)).not.toContain('Patel');

    const archived = await as(org.adminUserId, (tx) =>
      loadResidents(tx, org.organisationId, { status: 'archived' }));
    expect(archived.rows).toHaveLength(1);
    expect(archived.total).toBe(1);
  });

  it('searches a resident by surname, email or part of either', async () => {
    const byName = await as(org.adminUserId, (tx) =>
      loadResidents(tx, org.organisationId, { query: 'mokoena' }));
    expect(byName.total).toBe(2);

    const byEmail = await as(org.adminUserId, (tx) =>
      loadResidents(tx, org.organisationId, { query: 'lerato@listing' }));
    expect(byEmail.total).toBe(1);

    // Case and position both free: a search box that only matches the start of
    // a surname is useless to somebody holding a phone number.
    const partial = await as(org.adminUserId, (tx) =>
      loadResidents(tx, org.organisationId, { query: 'DER MERWE' }));
    expect(partial.total).toBe(1);
  });

  /* ---------------------------------------------------------------- leases */

  it('filters leases by status and counts what it filtered', async () => {
    const drafts = await as(org.adminUserId, (tx) =>
      loadLeases(tx, org.organisationId, { status: 'draft' }));
    expect(drafts.total).toBe(2);
    expect(drafts.rows.every((l) => l.status === 'draft')).toBe(true);
  });

  it('searches a lease by its unit as well as its reference', async () => {
    const byUnit = await as(org.adminUserId, (tx) =>
      loadLeases(tx, org.organisationId, { query: 'Aloe' }));
    expect(byUnit.total).toBe(2);
    expect(byUnit.rows.every((l) => l.unit_label.includes('Aloe'))).toBe(true);
  });

  it('pages without repeating or losing a row', async () => {
    const first = await as(org.adminUserId, (tx) =>
      loadLeases(tx, org.organisationId, {}, page(1)));
    const second = await as(org.adminUserId, (tx) =>
      loadLeases(tx, org.organisationId, {}, page(2)));

    expect(first.rows).toHaveLength(3);
    expect(second.rows).toHaveLength(1);
    // The total is the whole filtered set, not the page: it is what the
    // sentence under the list is counting.
    expect(first.total).toBe(4);
    expect(second.total).toBe(4);

    const ids = [...first.rows, ...second.rows].map((l) => l.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('counts the filtered set, not the whole table', async () => {
    const filtered = await as(org.adminUserId, (tx) =>
      loadLeases(tx, org.organisationId, { status: 'draft' }, page(1, 1)));
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.total).toBe(2);
  });

  /* ------------------------------------------------------------- documents */

  it('counts quarantined files across everything, not across the page', async () => {
    const onePage = await as(org.adminUserId, (tx) =>
      loadDocuments(tx, org.organisationId, {}, page(2, 2)));
    expect(onePage.rows).toHaveLength(2);
    expect(onePage.total).toBe(7);
    // The banner this drives is a safety statement. Narrowing it to whatever
    // page is on screen would be worse than not having it.
    expect(onePage.quarantinedTotal).toBe(1);
  });

  it('shows only the held-back files when asked', async () => {
    const held = await as(org.adminUserId, (tx) =>
      loadDocuments(tx, org.organisationId, { quarantinedOnly: true }));
    expect(held.total).toBe(1);
    expect(held.rows[0]!.quarantined).toBe(true);
  });

  it('treats a percent sign in the search box as a percent sign', async () => {
    // Unescaped, '%' is the LIKE wildcard and this matches every document.
    const literal = await as(org.adminUserId, (tx) =>
      loadDocuments(tx, org.organisationId, { query: '100%' }));
    expect(literal.total).toBe(1);
    expect(literal.rows[0]!.title).toContain('100%');
  });

  it('filters documents by kind', async () => {
    const invoices = await as(org.adminUserId, (tx) =>
      loadDocuments(tx, org.organisationId, { classification: 'invoice' }));
    expect(invoices.total).toBe(1);
  });
});
