/**
 * Billing a tenant for the municipality, and crediting it back.
 *
 * The claims under test are the ones that decide whether a tenant can check
 * their own bill:
 *
 *   * a water charge is stored as water, not as "utility", so the invoice can
 *     say which municipal line it answers;
 *   * the meter reading and the tariff are stored beside the amount and are
 *     never used to compute it;
 *   * half a calculation cannot be stored at all;
 *   * a credit note against a utility charge reads as a credit note, names the
 *     invoice it corrects, and takes nothing more than remains.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, createResident, createStandaloneHouse, draftLease, issueCreditNote,
  loadInvoiceForOperator, parseMajorToMinor, postCharge,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Utility charges', () => {
  let org: OrganisationFixture;
  let leaseId: string;

  beforeAll(async () => {
    org = await createOrganisation('Municipal Recoveries');
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Meter House', code: `MTR${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '8 Meter Street', city: 'Cape Town',
      }));
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Sipho', lastName: 'Ndlovu',
      }));
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('9000'), depositRequiredMinor: R('9000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }));
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }));
  });

  afterAll(async () => { await closeOwner(); });

  /** A water charge with its reading, as the screen posts one. */
  async function postWater(amount: string, quantity = 12) {
    return as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId,
        documentType: 'utility_invoice',
        issueDate: '2026-05-01',
        dueDate: '2026-05-07',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        lines: [{
          category: 'utility_water',
          description: 'Water consumption',
          amountMinor: R(amount),
          dueDate: '2026-05-07',
          servicePeriodStart: '2026-04-01',
          servicePeriodEnd: '2026-04-30',
          quantity,
          unit: 'kl',
          unitRateMinor: 3215n,
          meterPrevious: 4312,
          meterCurrent: 4312 + quantity,
        }],
      }));
  }

  it('stores the reading and the tariff beside the amount, and charges the amount', async () => {
    const posted = await postWater('385.80');
    const invoice = await as(org.adminUserId, (tx) =>
      loadInvoiceForOperator(tx, org.organisationId, posted.documentId));

    expect(invoice.documentType).toBe('utility_invoice');
    const [line] = invoice.lines;
    expect(line?.category).toBe('utility_water');
    // The words a tenant reads, never the key.
    expect(line?.categoryLabel).toBe('Water');
    expect(line?.measurement).toMatchObject({
      quantity: 12, unit: 'kl', unitRateMinor: 3215n, meterPrevious: 4312, meterCurrent: 4324,
    });
    // And the amount is the one that was posted, not 12 × 32.15 recomputed.
    expect(line?.amountMinor).toBe(R('385.80'));
    expect(invoice.totalMinor).toBe(R('385.80'));
  });

  it('keeps a reading that does NOT multiply out, because the ledger is not a calculator', async () => {
    // A municipality applies a stepped tariff, so the quantity times the rate
    // is often not the bill. The posted amount is what the tenant owes; the
    // invoice shows both and says they differ rather than correcting either.
    const posted = await postWater('402.11');
    const invoice = await as(org.adminUserId, (tx) =>
      loadInvoiceForOperator(tx, org.organisationId, posted.documentId));
    expect(invoice.lines[0]?.amountMinor).toBe(R('402.11'));
    expect(invoice.lines[0]?.measurement?.unitRateMinor).toBe(3215n);
  });

  it('refuses half a calculation', async () => {
    const half = as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId,
        documentType: 'utility_invoice',
        issueDate: '2026-05-01',
        dueDate: '2026-05-07',
        lines: [{
          category: 'utility_electricity',
          description: 'Electricity',
          amountMinor: R('500'),
          dueDate: '2026-05-07',
          // A quantity with no rate: an invoice could print "350 kWh" and
          // nothing a tenant could check it against.
          quantity: 350,
        }],
      }));
    await expect(half).rejects.toThrow();

    const oneReading = as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId,
        documentType: 'utility_invoice',
        issueDate: '2026-05-01',
        dueDate: '2026-05-07',
        lines: [{
          category: 'utility_sewerage',
          description: 'Sewerage',
          amountMinor: R('120'),
          dueDate: '2026-05-07',
          quantity: 12, unit: 'kl', unitRateMinor: 1000n,
          meterCurrent: 4324,
        }],
      }));
    await expect(oneReading).rejects.toThrow();
  });

  it('refuses a category this product does not offer', async () => {
    await expect(as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId,
        documentType: 'utility_invoice',
        issueDate: '2026-05-01',
        dueDate: '2026-05-07',
        lines: [{
          category: 'whatever_the_operator_typed',
          description: 'Something',
          amountMinor: R('100'),
          dueDate: '2026-05-07',
        }],
      }))).rejects.toThrow();
  });

  it('bills sewerage and refuse under their own names', async () => {
    const posted = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId,
        documentType: 'utility_invoice',
        issueDate: '2026-06-01',
        dueDate: '2026-06-07',
        lines: [
          {
            category: 'utility_sewerage',
            description: 'Sewerage / domestic effluent',
            amountMinor: R('794.16'),
            dueDate: '2026-06-07',
            quantity: 12, unit: 'kl', unitRateMinor: 6618n,
          },
          {
            category: 'utility_refuse',
            description: 'Refuse removal',
            amountMinor: R('210'),
            dueDate: '2026-06-07',
          },
        ],
      }));

    const invoice = await as(org.adminUserId, (tx) =>
      loadInvoiceForOperator(tx, org.organisationId, posted.documentId));
    expect(invoice.lines.map((line) => line.categoryLabel))
      .toEqual(['Sewerage (domestic effluent)', 'Refuse removal']);
    expect(invoice.totalMinor).toBe(R('1004.16'));
  });

  it('credits a utility charge back, naming the invoice and the reason', async () => {
    const posted = await postWater('900');
    const note = await as(org.adminUserId, (tx) =>
      issueCreditNote(tx, org.organisationId, org.adminUserId, {
        documentId: posted.documentId,
        reason: 'Meter was misread',
        issueDate: '2026-05-09',
        lines: [{
          description: 'Water consumption — misread',
          amountMinor: R('900'),
          category: 'utility_water',
        }],
      }));

    const credit = await as(org.adminUserId, (tx) =>
      loadInvoiceForOperator(tx, org.organisationId, note.documentId));
    expect(credit.documentType).toBe('credit_note');
    // Stored negative, because that is what it does to the account.
    expect(credit.totalMinor).toBe(-R('900'));
    expect(credit.corrects).toMatchObject({
      documentNumber: posted.documentNumber, reason: 'Meter was misread',
    });

    // And the original now says it was reversed, so a tenant finding it again
    // can see it was cancelled rather than paying it.
    const original = await as(org.adminUserId, (tx) =>
      loadInvoiceForOperator(tx, org.organisationId, posted.documentId));
    expect(original.reversed).toBe(true);

    // Nothing further remains creditable on it.
    await expect(as(org.adminUserId, (tx) =>
      issueCreditNote(tx, org.organisationId, org.adminUserId, {
        documentId: posted.documentId,
        reason: 'Trying it twice',
        issueDate: '2026-05-10',
        lines: [{ description: 'Again', amountMinor: R('900'), category: 'utility_water' }],
      }))).rejects.toThrow();
  });

  it('posts utilities to the utility recovery account, not to rent', async () => {
    const posted = await postWater('100');
    const [row] = await ownerSql()<{ account_code: string }[]>`
      select a.code as account_code
        from charge_lines cl
        join accounts a on a.id = cl.income_account_id
       where cl.document_id = ${posted.documentId}
    `;
    const [rent] = await ownerSql()<{ code: string }[]>`
      select code from accounts
       where organisation_id = ${org.organisationId} and system_role = 'rental_income'
    `;
    expect(row?.account_code).not.toBe(rent?.code);
  });
});
