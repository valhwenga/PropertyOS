/**
 * The counts an operator works from.
 *
 * A queue count is a promise that somebody will be told when there is
 * something to do, and the overview's "pending approvals" tile quietly broke
 * that promise: its deposit term read `deposit_events` where `approved_at is
 * null`, which the database forbids outright — `deposit_events_refund_controls`
 * requires an approver on every deduction and refund. The term was always
 * zero. The approvals QUEUE was fixed when payout requests got their own
 * table; the count on the dashboard an approver actually looks at was left
 * behind, which is the worse half of the same defect.
 *
 * The other rule here is the difference between outstanding and arrears. This
 * month's invoice, issued yesterday, is outstanding. It is not somebody's
 * failure to pay, and a queue that mixes the two sends a letting agent after a
 * resident who owes nothing yet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, arrearsAgeing, createResident,
  createStandaloneHouse, createVendor, draftLease, parseMajorToMinor, postCharge,
  recordDepositReceipt, recordQuote, requestDepositPayout, createTicket, registerDocument,
} from '@propertyos/domain';
import { loadDashboard } from '../../apps/web/src/lib/queries';
import {
  addMember, as, closeOwner, createOrganisation, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');
const PERIOD = '2026-10-01';

describe('Exception queues', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let clerk: string;

  beforeAll(async () => {
    org = await createOrganisation('Queues Co');
    clerk = await addMember(org.organisationId, 'Dep Clerk', ['finance_preparer']);

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Queue', lastName: 'Resident',
      }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Queue House', code: 'QH', propertyType: 'house',
        addressLine1: '1 Queue Road', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('9000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );

    // One charge long overdue, one not due until well after any test runs.
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice', issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('9000'), dueDate: '2026-01-01' }],
      }),
    );

    // A deposit, and a payout request waiting on an approver.
    const deposit = await as(org.adminUserId, (tx) =>
      recordDepositReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('9000'), receivedOn: '2026-01-01',
        holder: 'landlord', description: 'Deposit on signing',
      }),
    );
    const evidence = await as(org.adminUserId, (tx) =>
      registerDocument(
        tx, org.organisationId, org.adminUserId,
        {
          classification: 'deposit_evidence', title: 'Cleaning quotation',
          filename: 'clean.pdf', contentType: 'application/pdf', byteSize: 2048, leaseId,
        },
        // Pending, because no scanner is configured: this is also the file the
        // quarantine count is counting.
        { status: 'pending', detail: 'No scanner configured.' },
      ),
    );
    await as(clerk, (tx) =>
      requestDepositPayout(tx, org.organisationId, clerk, {
        depositAccountId: deposit.depositAccountId, kind: 'deduction',
        amountMinor: R('1200'), effectiveOn: '2026-10-01',
        description: 'Carpet cleaning after move-out, quoted by the contractor.',
        evidenceDocumentId: evidence.documentId,
      }),
    );

    // A quotation waiting on an approver, so the count has two kinds in it.
    const vendor = await as(org.adminUserId, (tx) =>
      createVendor(tx, org.organisationId, org.adminUserId, {
        name: 'Queue Plumbing', trade: 'plumbing',
      }),
    );
    const ticket = await as(org.adminUserId, (tx) =>
      createTicket(tx, org.organisationId, org.adminUserId, {
        propertyId: house.propertyId, unitId: house.unitId, category: 'plumbing',
        urgency: 'normal', description: 'Dripping tap in the kitchen.',
      }),
    );
    await as(org.adminUserId, (tx) =>
      recordQuote(tx, org.organisationId, org.adminUserId, {
        ticketId: ticket.ticketId, vendorId: vendor.vendorId, amountMinor: R('800'),
        currencyCode: 'ZAR',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('counts a pending deposit payout among the approvals waiting', async () => {
    const metrics = await as(org.adminUserId, (tx) =>
      loadDashboard(tx, org.organisationId, PERIOD));
    // One quotation and one payout request. Before the fix this was 1: the
    // payout was invisible to the person whose job is to approve it.
    expect(metrics.pendingApprovals).toBe(2);
  });

  it('counts the files nothing has scanned', async () => {
    const metrics = await as(org.adminUserId, (tx) =>
      loadDashboard(tx, org.organisationId, PERIOD));
    expect(metrics.quarantinedDocuments).toBe(1);
  });

  it('separates money past its due date from money merely unpaid', async () => {
    // A charge that is not due for a long time: outstanding, but nobody has
    // failed to pay anything.
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice', issueDate: '2026-01-01', dueDate: '2099-01-01',
        lines: [{ category: 'rent', description: 'Future rent', amountMinor: R('9000'), dueDate: '2099-01-01' }],
      }),
    );

    const metrics = await as(org.adminUserId, (tx) =>
      loadDashboard(tx, org.organisationId, PERIOD));
    expect(BigInt(metrics.receivableMinor)).toBe(R('18000'));
    expect(BigInt(metrics.arrearsMinor)).toBe(R('9000'));

    // And the report the Arrears tile opens can be asked the same question,
    // instead of listing every unpaid charge including this morning's.
    const all = await as(org.adminUserId, (tx) => arrearsAgeing(tx, org.organisationId));
    const overdue = await as(org.adminUserId, (tx) =>
      arrearsAgeing(tx, org.organisationId, { overdueOnly: true }));
    expect(all.rows).toHaveLength(1);
    expect(overdue.rows).toHaveLength(1);
    expect(overdue.meta.qualifications.join(' ')).toContain('past its due date');
  });

  it('leaves a lease with nothing but future charges out of the overdue view', async () => {
    const other = await createOrganisation('Not Due Co');
    const resident = await as(other.adminUserId, (tx) =>
      createResident(tx, other.organisationId, other.adminUserId, {
        firstName: 'Not', lastName: 'Due',
      }),
    );
    const house = await as(other.adminUserId, (tx) =>
      createStandaloneHouse(tx, other.organisationId, other.adminUserId, {
        name: 'Not Due House', code: 'ND', propertyType: 'house',
        addressLine1: '2 Later Road', city: 'Cape Town',
      }),
    );
    const lease = await as(other.adminUserId, (tx) =>
      draftLease(tx, other.organisationId, other.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('5000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    await as(other.adminUserId, (tx) =>
      activateLease(tx, other.organisationId, other.adminUserId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );
    await as(other.adminUserId, (tx) =>
      postCharge(tx, other.organisationId, other.adminUserId, {
        leaseId: lease.leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2099-06-01',
        lines: [{ category: 'rent', description: 'Future rent', amountMinor: R('5000'), dueDate: '2099-06-01' }],
      }),
    );

    const all = await as(other.adminUserId, (tx) => arrearsAgeing(tx, other.organisationId));
    const overdue = await as(other.adminUserId, (tx) =>
      arrearsAgeing(tx, other.organisationId, { overdueOnly: true }));
    expect(all.rows).toHaveLength(1);
    // This is the whole point of the flag: owing nothing yet is not a queue.
    expect(overdue.rows).toHaveLength(0);
  });

  it('counts leases signed off that nobody activated', async () => {
    const metrics = await as(org.adminUserId, (tx) =>
      loadDashboard(tx, org.organisationId, PERIOD));
    expect(metrics.leasesAwaitingActivation).toBe(0);
  });
});
