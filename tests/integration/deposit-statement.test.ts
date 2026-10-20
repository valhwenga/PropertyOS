/**
 * Accounting to a tenant for their deposit.
 *
 * This document exists for one conversation: the end of a lease, when the
 * deposit comes back smaller than it went in. What settles it is the list —
 * every receipt, every interest credit, every deduction with the reason
 * recorded for it.
 *
 * So the claims under test are: the tenant can read their own deposit's
 * history at all (the tables are closed to them); they get the same figures
 * their landlord does; the deductions arrive with their reasons; and nothing
 * about who approved what reaches them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, approveDepositPayout, createResident, createStandaloneHouse, draftLease,
  loadDepositStatementForOperator, loadDepositStatementForResident, parseMajorToMinor,
  recordDepositReceipt, registerDocument, renderDepositStatementPdf,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, grantPortalAccess,
  type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

/** The literal strings a PDF draws. */
function textOf(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  return (raw.match(/\(((?:[^()\\]|\\.)*)\) Tj/g) ?? [])
    .map((match) => match.slice(1, -4).replace(/\\([()\\])/g, '$1'))
    .join('\n');
}

describe('Deposit statement', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let residentUser: string;

  beforeAll(async () => {
    org = await createOrganisation('Deposit Statements Co');
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Deposit House', code: `DEP${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '3 Deposit Drive', city: 'Gqeberha',
      }));
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Nomsa', lastName: 'Dube',
      }));
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('8000'), depositRequiredMinor: R('8000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }));
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }));

    const deposit = await as(org.adminUserId, (tx) =>
      recordDepositReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('8000'), receivedOn: '2026-01-05',
        holder: 'landlord', description: 'Deposit received on signature',
      }));

    // Every deduction needs evidence behind it before it can be approved.
    const evidence = await as(org.adminUserId, (tx) =>
      registerDocument(
        tx, org.organisationId, org.adminUserId,
        {
          classification: 'deposit_evidence', title: 'Painter’s invoice',
          filename: 'painting.pdf', contentType: 'application/pdf',
          byteSize: 2048, contentSha256: 'c'.repeat(64), leaseId,
        },
        { status: 'clean', detail: 'Scanned clean in a test.' },
      ));

    // A deduction, approved by somebody other than the person who raised it,
    // because that is how the product requires one to be made.
    const approver = await addMember(org.organisationId, 'Deposit Approver',
      ['finance_approver']);
    await as(approver, (tx) =>
      approveDepositPayout(tx, org.organisationId, approver, {
        depositAccountId: deposit.depositAccountId,
        kind: 'deduction',
        amountMinor: R('1250'),
        effectiveOn: '2026-11-30',
        description: 'Repainting the lounge wall, quoted and invoiced',
        evidenceDocumentId: evidence.documentId,
        requestedByUserId: org.adminUserId,
        approvalReason: 'Inspection report and contractor invoice attached',
      }));

    residentUser = await grantPortalAccess(
      org.organisationId, leaseId, resident.residentId, 'Nomsa Portal',
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('adds up to what is still held', async () => {
    const statement = await as(org.adminUserId, (tx) =>
      loadDepositStatementForOperator(tx, org.organisationId, leaseId));

    expect(statement.receivedMinor).toBe(R('8000'));
    expect(statement.deductedMinor).toBe(R('1250'));
    expect(statement.heldMinor).toBe(R('6750'));
    expect(statement.reconciles).toBe(true);
    expect(statement.requiredMinor).toBe(R('8000'));
  });

  it('gives the tenant their own deposit’s history, with the reasons', async () => {
    const theirs = await as(residentUser, (tx) => loadDepositStatementForResident(tx, leaseId));

    expect(theirs.heldMinor).toBe(R('6750'));
    const deduction = theirs.events.find((event) => event.eventType === 'deduction');
    expect(deduction?.amountMinor).toBe(R('1250'));
    // The reason recorded WITH THE EVENT: what the money was spent on.
    expect(deduction?.description).toContain('Repainting the lounge wall');
    expect(deduction?.reduces).toBe(true);

    // And nothing about the organisation: no approver, no approval note.
    const serialised = JSON.stringify(theirs, (_key, value) =>
      (typeof value === 'bigint' ? value.toString() : value));
    expect(serialised).not.toContain('Deposit Approver');
    expect(serialised).not.toContain('Inspection report');
  });

  it('shows the tenant and the landlord the same figures', async () => {
    const landlords = await as(org.adminUserId, (tx) =>
      loadDepositStatementForOperator(tx, org.organisationId, leaseId));
    const tenants = await as(residentUser, (tx) =>
      loadDepositStatementForResident(tx, leaseId));

    expect(tenants.heldMinor).toBe(landlords.heldMinor);
    expect(tenants.deductedMinor).toBe(landlords.deductedMinor);
    expect(tenants.events).toHaveLength(landlords.events.length);
  });

  it('refuses a lease the reader has nothing to do with', async () => {
    const other = await createOrganisation('Nosy Deposits');
    await expect(as(other.adminUserId, (tx) =>
      loadDepositStatementForOperator(tx, other.organisationId, leaseId))).rejects.toThrow();

    // And a resident of nothing: the function returns no events, so the
    // statement cannot be assembled at all.
    const stranger = await addMember(other.organisationId, 'Stranger', ['org_admin']);
    await expect(as(stranger, (tx) =>
      loadDepositStatementForResident(tx, leaseId))).rejects.toThrow();
  });

  it('renders a document that lists the deduction rather than summarising it', async () => {
    const statement = await as(residentUser, (tx) =>
      loadDepositStatementForResident(tx, leaseId));
    const text = textOf(renderDepositStatementPdf(statement, {
      landlord: {
        legalName: 'Deposit Statements (Pty) Ltd', tradingName: 'Deposit Statements Co',
        registrationNumber: null, vatNumber: null,
        physicalAddress: '1 Office Park\nGqeberha', phone: '041 000 0000',
        email: 'deposits@example.invalid', agentName: null, agentContact: null,
      },
      accent: 'ocean',
    }));

    expect(text).toContain('Nomsa Dube');
    expect(text).toContain('Deposit received');
    expect(text).toContain('R8,000.00');
    // The reason, in the words that were recorded. The whole point.
    expect(text).toContain('Repainting the lounge wall');
    expect(text).toContain('R1,250.00');
    expect(text).toContain('Still held for you');
    expect(text).toContain('R6,750.00');
    // And the standing qualification: a deposit is not rent.
    expect(text).toContain('held separately from rent');
  });
});
