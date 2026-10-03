/**
 * Milestone 1 acceptance: the complete rent workflow, end to end, on real
 * persisted data.
 *
 *   create organisation -> add property and unit -> add resident ->
 *   activate lease -> post charge -> confirm EFT receipt -> allocate receipt ->
 *   view an accurate resident statement
 *
 * The closing figures are checked against the worked example in the blueprint:
 *   opening arrears R1,000 + rent R8,000 + water R350 - receipt R7,500
 *   = closing receivable R1,850.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease,
  allocateReceipt,
  assertBookBalances,
  buildStatement,
  confirmReceipt,
  createResident,
  createStandaloneHouse,
  draftLease,
  formatMoney,
  parseMajorToMinor,
  postCharge,
  submitPaymentEvidence,
  suggestAllocation,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, grantPortalAccess, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

const R = (amount: string) => parseMajorToMinor(amount, 'ZAR');

describe('Milestone 1 — complete rent workflow', () => {
  let org: OrganisationFixture;
  let propertyId: string;
  let unitId: string;
  let residentId: string;
  let leaseId: string;

  beforeAll(async () => {
    org = await createOrganisation('Blue Crane Properties');
  });

  afterAll(async () => {
    await closeOwner();
  });

  it('creates a standalone house with one rentable unit, and no building', async () => {
    const result = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: '14 Protea Street',
        code: 'PROTEA14',
        propertyType: 'house',
        addressLine1: '14 Protea Street',
        suburb: 'Newlands',
        city: 'Cape Town',
        province: 'Western Cape',
        postalCode: '7700',
        countryCode: 'ZA',
      }),
    );
    propertyId = result.propertyId;
    unitId = result.unitId;

    const [building] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from buildings where property_id = ${propertyId}
    `;
    // A landlord with a house is never forced to invent a building.
    expect(building!.count).toBe('0');
  });

  it('rejects a duplicate unit code within the same property', async () => {
    await expect(
      as(org.adminUserId, async (tx) => {
        const { createUnit } = await import('@propertyos/domain');
        return createUnit(tx, org.organisationId, org.adminUserId, {
          propertyId,
          code: 'MAIN',
        });
      }),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('creates a resident who has no login account', async () => {
    const result = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe',
        lastName: 'Mokoena',
        email: 'thandiwe.mokoena@demo.invalid',
        phone: '+27 82 555 0101',
      }),
    );
    residentId = result.residentId;

    const [link] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from portal_links where resident_id = ${residentId}
    `;
    expect(link!.count).toBe('0');
  });

  it('drafts and then activates a lease, creating a rent schedule and occupancy', async () => {
    const draft = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        rentMinor: R('8000'),
        billingDay: 1,
        depositRequiredMinor: R('8000'),
        parties: [{ residentId, role: 'primary_resident', canViewFinancials: true }],
      }),
    );
    leaseId = draft.leaseId;
    expect(draft.reference).toMatch(/^LSE-\d{6}$/);

    const activated = await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId,
        expectedVersion: 1,
        activationDate: '2026-01-01',
        executionExceptionReason: 'Signed paper contract held at the office; scan pending.',
      }),
    );
    expect(activated.status).toBe('active');

    const [schedule] = await ownerSql()<{ amount_minor: string; category: string }[]>`
      select amount_minor::text, category from charge_schedules where lease_id = ${leaseId}
    `;
    expect(schedule).toMatchObject({ category: 'rent', amount_minor: '800000' });

    const [occupancy] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from occupancy_intervals where lease_id = ${leaseId}
    `;
    expect(occupancy!.count).toBe('1');
  });

  it('refuses to activate a lease with no executed contract and no recorded exception', async () => {
    const second = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId,
        startDate: '2028-01-01',
        rentMinor: R('9000'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        activateLease(tx, org.organisationId, org.adminUserId, {
          leaseId: second.leaseId,
          expectedVersion: 1,
          activationDate: '2028-01-01',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('posts the opening arrears, the rent charge and the water charge', async () => {
    const opening = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId,
        documentType: 'opening_balance',
        issueDate: '2025-12-31',
        dueDate: '2025-12-31',
        lines: [
          {
            category: 'other',
            description: 'Opening arrears brought forward (signed by operator 2025-12-31)',
            amountMinor: R('1000'),
            dueDate: '2025-12-31',
          },
        ],
      }),
    );
    expect(opening.totalMinor).toBe(R('1000'));

    const rent = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId,
        documentType: 'rent_invoice',
        issueDate: '2026-01-01',
        dueDate: '2026-01-01',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        lines: [
          { category: 'rent', description: 'Monthly rent', amountMinor: R('8000'), dueDate: '2026-01-01' },
        ],
      }),
    );
    expect(rent.totalMinor).toBe(R('8000'));

    const water = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId,
        documentType: 'utility_invoice',
        issueDate: '2026-01-05',
        dueDate: '2026-01-07',
        lines: [
          {
            category: 'utility_water',
            description: 'Water — January reading, reviewed',
            amountMinor: R('350'),
            dueDate: '2026-01-07',
          },
        ],
      }),
    );
    expect(water.totalMinor).toBe(R('350'));

    // The whole book must balance after every posting.
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('does NOT move the balance when a resident uploads proof of payment', async () => {
    const residentUser = await grantPortalAccess(org.organisationId, leaseId, residentId, 'Thandiwe Portal');

    const before = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-01-31' }),
    );

    await as(residentUser, (tx) =>
      submitPaymentEvidence(tx, org.organisationId, residentUser, {
        leaseId,
        claimedAmountMinor: R('7500'),
        claimedPaidAt: '2026-01-06',
        reference: 'EFT screenshot',
      }),
    );

    const after = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-01-31' }),
    );

    expect(after.closingReceivableMinor).toBe(before.closingReceivableMinor);
    expect(after.pendingEvidence).toHaveLength(1);
    expect(after.pendingEvidence[0]!.claimedAmountMinor).toBe(R('7500'));
  });

  it('confirms an EFT receipt and allocates it across the open charges', async () => {
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId,
        amountMinor: R('7500'),
        receivedOn: '2026-01-07',
        method: 'eft',
        payerReference: 'MOKOENA PROTEA14',
      }),
    );
    expect(receipt.inSuspense).toBe(false);

    const suggestion = await as(org.adminUserId, (tx) =>
      suggestAllocation(tx, org.organisationId, { leaseId, amountMinor: R('7500') }),
    );
    // Oldest due date first: opening arrears R1,000, then rent R8,000 partially.
    expect(suggestion.allocations).toHaveLength(2);
    expect(suggestion.allocations[0]!.amountMinor).toBe(R('1000'));
    expect(suggestion.allocations[1]!.amountMinor).toBe(R('6500'));
    expect(suggestion.remainingMinor).toBe(0n);

    const result = await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId,
        allocations: suggestion.allocations,
        postingDate: '2026-01-07',
      }),
    );
    expect(result.allocatedMinor).toBe(R('7500'));
    expect(result.unappliedMinor).toBe(0n);

    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('produces the blueprint statement: closing receivable R1,850.00', async () => {
    const statement = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-01-31' }),
    );

    expect(statement.closingReceivableMinor).toBe(R('1850'));
    expect(formatMoney(statement.closingReceivableMinor, 'ZAR')).toBe('R1,850.00');

    const debits = statement.lines.reduce((sum, l) => sum + l.debitMinor, 0n);
    const credits = statement.lines.reduce((sum, l) => sum + l.creditMinor, 0n);
    expect(debits).toBe(R('9350')); // 1,000 + 8,000 + 350
    expect(credits).toBe(R('7500'));

    // The deposit is a separate liability and must not have reduced the rent.
    expect(statement.depositHeldMinor).toBe(0n);
    expect(statement.unappliedCreditMinor).toBe(0n);
  });

  it('shows the same statement to the resident through the portal', async () => {
    const [link] = await ownerSql()<{ auth_user_id: string }[]>`
      select auth_user_id from portal_links where lease_id = ${leaseId} and status = 'active'
    `;
    const statement = await as(link!.auth_user_id, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-01-31' }),
    );
    expect(statement.closingReceivableMinor).toBe(R('1850'));
  });
});
