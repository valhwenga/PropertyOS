/**
 * Two-person approval, which §4 asks to be configurable for larger customers.
 *
 * The claim under test is narrow and financial: where an organisation has
 * asked for two approvers, ONE approval moves nothing. Not the deposit
 * liability, not the ledger, not a work order telling a contractor to start.
 * The signature is recorded and the thing stays exactly where it was.
 *
 * The second claim is about who may give that second signature: not the same
 * person twice, and not the person who prepared it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, approveExpense, approvePayoutRequest, approveQuoteAndIssueWorkOrder,
  assertBookBalances, createResident, createStandaloneHouse, createTicket, createVendor,
  draftLease, listApprovalPolicies, listApprovalSignatures, listPayoutRequests,
  parseMajorToMinor, recordDepositReceipt, recordExpense, recordQuote, registerDocument,
  requestDepositPayout, setApprovalPolicy,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Two-person approval', () => {
  let org: OrganisationFixture;
  let preparer: string;
  let approverOne: string;
  let approverTwo: string;
  let leaseId: string;
  let propertyId: string;
  let depositAccountId: string;
  let evidenceId: string;
  let vendorId: string;

  async function held(): Promise<bigint> {
    const [row] = await ownerSql()<{ held: string }[]>`
      select coalesce(sum(amount_minor), 0)::text as held
        from deposit_events where deposit_account_id = ${depositAccountId}
    `;
    return BigInt(row!.held);
  }

  beforeAll(async () => {
    org = await createOrganisation('Two Person Rentals');
    // Three people, because the rule is about people: one prepares, two agree.
    preparer = await addMember(org.organisationId, 'Preparer', ['finance_preparer']);
    approverOne = await addMember(org.organisationId, 'Approver One', ['org_admin']);
    approverTwo = await addMember(org.organisationId, 'Approver Two', ['org_admin']);

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Two Person House', code: `TP${Date.now().toString().slice(-6)}`,
        propertyType: 'house',
        addressLine1: '1 Approval Street', city: 'Cape Town',
      }));
    propertyId = house.propertyId;

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandi', lastName: 'Approver', email: `tp${Date.now()}@example.invalid`,
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

    const deposit = await as(org.adminUserId, (tx) =>
      recordDepositReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('9000'), receivedOn: '2026-01-01',
        holder: 'landlord', description: 'Deposit on signing',
      }));
    depositAccountId = deposit.depositAccountId;

    const document = await as(org.adminUserId, (tx) =>
      registerDocument(
        tx, org.organisationId, org.adminUserId,
        {
          classification: 'deposit_evidence', title: 'Damage quotation',
          filename: 'quote.pdf', contentType: 'application/pdf',
          byteSize: 2048, contentSha256: 'd'.repeat(64), leaseId,
        },
        { status: 'clean', detail: 'Scanned clean in a test.' },
      ));
    evidenceId = document.documentId;

    vendorId = (await as(org.adminUserId, (tx) =>
      createVendor(tx, org.organisationId, org.adminUserId, {
        name: 'Two Person Plumbing', category: 'plumbing',
      }))).vendorId;
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------------------------ the setting */

  it('defaults to one approver, which is what the product did before', async () => {
    const policies = await as(org.adminUserId, (tx) =>
      listApprovalPolicies(tx, org.organisationId));
    expect(policies).toHaveLength(3);
    for (const policy of policies) {
      expect(policy.approvalsRequired).toBe(1);
      expect(policy.thresholdMinor).toBe(0n);
    }
  });

  it('is only changeable by somebody who may manage settings', async () => {
    await expect(as(preparer, (tx) =>
      setApprovalPolicy(tx, org.organisationId, preparer, {
        actionKey: 'expense.approve', approvalsRequired: 2, thresholdMinor: 0n,
      }))).rejects.toThrow();
  });

  it('refuses a rule the product cannot enforce', async () => {
    await expect(as(org.adminUserId, (tx) =>
      setApprovalPolicy(tx, org.organisationId, org.adminUserId, {
        actionKey: 'expense.approve', approvalsRequired: 3, thresholdMinor: 0n,
      }))).rejects.toThrow(/one approver or two/);
    await expect(as(org.adminUserId, (tx) =>
      setApprovalPolicy(tx, org.organisationId, org.adminUserId, {
        actionKey: 'not.a.thing', approvalsRequired: 2, thresholdMinor: 0n,
      }))).rejects.toThrow(/not an action two-person approval applies to/i);
  });

  /* ------------------------------------------------- below the threshold */

  it('leaves small amounts on one approver', async () => {
    await as(org.adminUserId, (tx) =>
      setApprovalPolicy(tx, org.organisationId, org.adminUserId, {
        actionKey: 'expense.approve', approvalsRequired: 2, thresholdMinor: R('5000'),
      }));

    const small = await as(preparer, (tx) =>
      recordExpense(tx, org.organisationId, preparer, {
        propertyId, category: 'repairs_maintenance', description: 'Replace a tap washer',
        amountMinor: R('450'), expenseDate: '2026-02-01', currencyCode: 'ZAR',
      }));

    const { journalId } = await as(approverOne, (tx) =>
      approveExpense(tx, org.organisationId, approverOne, { expenseId: small.expenseId }));
    expect(journalId).toBeTruthy();
  });

  /* ------------------------------------------------- at and above it */

  it('records the first approval of a large cost and posts nothing', async () => {
    const big = await as(preparer, (tx) =>
      recordExpense(tx, org.organisationId, preparer, {
        propertyId, category: 'repairs_maintenance', description: 'Replace the roof sheeting',
        amountMinor: R('48000'), expenseDate: '2026-02-02', currencyCode: 'ZAR',
      }));

    const first = await as(approverOne, (tx) =>
      approveExpense(tx, org.organisationId, approverOne, { expenseId: big.expenseId }));
    expect(first.journalId).toBeNull();
    expect(first.approvals).toMatchObject({ satisfied: false, required: 2 });

    // The cost is still a draft and the books do not know about it.
    const [row] = await ownerSql()<{ status: string; journal_id: string | null }[]>`
      select status, journal_id from expenses where id = ${big.expenseId}
    `;
    expect(row).toMatchObject({ status: 'draft', journal_id: null });
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));

    // The same person cannot be the second approver.
    await expect(as(approverOne, (tx) =>
      approveExpense(tx, org.organisationId, approverOne, { expenseId: big.expenseId }),
    )).rejects.toMatchObject({ code: 'conflict' });

    // Nor can the person who drafted it, even though they hold the permission
    // through another role.
    await expect(as(preparer, (tx) =>
      approveExpense(tx, org.organisationId, preparer, { expenseId: big.expenseId }),
    )).rejects.toThrow();

    // A second person completes it.
    const second = await as(approverTwo, (tx) =>
      approveExpense(tx, org.organisationId, approverTwo, { expenseId: big.expenseId }));
    expect(second.journalId).toBeTruthy();
    expect(second.approvals.satisfied).toBe(true);

    const [posted] = await ownerSql()<{ status: string; journal_id: string | null }[]>`
      select status, journal_id from expenses where id = ${big.expenseId}
    `;
    expect(posted!.status).toBe('posted');
    expect(posted!.journal_id).toBeTruthy();
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));

    // Both names are on the record, in the order they signed.
    const signatures = await as(org.adminUserId, (tx) =>
      listApprovalSignatures(tx, org.organisationId, 'expenses', big.expenseId));
    expect(signatures.map((s) => s.signedBy)).toEqual([approverOne, approverTwo]);
  });

  /* --------------------------------------------------------- deposits */

  it('holds a deposit payout at one approval and releases nothing', async () => {
    await as(org.adminUserId, (tx) =>
      setApprovalPolicy(tx, org.organisationId, org.adminUserId, {
        actionKey: 'deposit.payout', approvalsRequired: 2, thresholdMinor: R('1000'),
      }));

    await as(preparer, (tx) =>
      requestDepositPayout(tx, org.organisationId, preparer, {
        depositAccountId, kind: 'deduction', amountMinor: R('3000'),
        effectiveOn: '2026-12-31', description: 'Damage to the kitchen counter',
        evidenceDocumentId: evidenceId,
      }));

    const [request] = await as(approverOne, (tx) =>
      listPayoutRequests(tx, org.organisationId, { pendingOnly: true }));

    const before = await held();
    const first = await as(approverOne, (tx) =>
      approvePayoutRequest(tx, org.organisationId, approverOne, {
        requestId: request!.id, approvalReason: 'Quotation seen and it matches the inspection.',
      }));
    expect(first.eventId).toBeNull();
    expect(await held()).toBe(before);

    // Still pending, so the queue still shows it and the resident is still
    // owed every cent.
    const [stored] = await ownerSql()<{ status: string; event_id: string | null }[]>`
      select status, event_id from deposit_payout_requests where id = ${request!.id}
    `;
    expect(stored).toMatchObject({ status: 'pending', event_id: null });

    const second = await as(approverTwo, (tx) =>
      approvePayoutRequest(tx, org.organisationId, approverTwo, {
        requestId: request!.id, approvalReason: 'Independently checked against the quotation.',
      }));
    expect(second.eventId).toBeTruthy();
    expect(await held()).toBe(before - R('3000'));
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  /* ---------------------------------------------------- maintenance */

  it('issues no work order until the second approver agrees', async () => {
    await as(org.adminUserId, (tx) =>
      setApprovalPolicy(tx, org.organisationId, org.adminUserId, {
        actionKey: 'maintenance.quote.approve', approvalsRequired: 2, thresholdMinor: R('2500'),
      }));

    const ticket = await as(org.adminUserId, (tx) =>
      createTicket(tx, org.organisationId, org.adminUserId, {
        propertyId, leaseId, category: 'plumbing', priority: 'normal',
        title: 'Burst geyser', description: 'Water through the ceiling in the main bedroom.',
      }));
    const quote = await as(org.adminUserId, (tx) =>
      recordQuote(tx, org.organisationId, org.adminUserId, {
        ticketId: ticket.ticketId, vendorId, amountMinor: R('14000'), currencyCode: 'ZAR',
      }));

    const first = await as(approverOne, (tx) =>
      approveQuoteAndIssueWorkOrder(tx, org.organisationId, approverOne, {
        quoteId: quote.quoteId, scope: 'Replace the geyser and make good the ceiling.',
      }));
    expect(first.workOrderId).toBeNull();

    const [orders] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from work_orders where ticket_id = ${ticket.ticketId}
    `;
    expect(orders!.total).toBe('0');

    // The quotation has not been marked approved either: a contractor reading
    // this would see a decision that has not been made.
    const [status] = await ownerSql()<{ status: string }[]>`
      select status from maintenance_quotes where id = ${quote.quoteId}
    `;
    expect(status!.status).toBe('submitted');

    const second = await as(approverTwo, (tx) =>
      approveQuoteAndIssueWorkOrder(tx, org.organisationId, approverTwo, {
        quoteId: quote.quoteId, scope: 'Replace the geyser and make good the ceiling.',
      }));
    expect(second.workOrderId).toBeTruthy();
  });

  /* ------------------------------------------------- turning it back off */

  it('returns to one approver when the rule is relaxed', async () => {
    await as(org.adminUserId, (tx) =>
      setApprovalPolicy(tx, org.organisationId, org.adminUserId, {
        actionKey: 'expense.approve', approvalsRequired: 1, thresholdMinor: 0n,
      }));

    const cost = await as(preparer, (tx) =>
      recordExpense(tx, org.organisationId, preparer, {
        propertyId, category: 'repairs_maintenance', description: 'Re-point the boundary wall',
        amountMinor: R('26000'), expenseDate: '2026-03-01', currencyCode: 'ZAR',
      }));
    const { journalId } = await as(approverOne, (tx) =>
      approveExpense(tx, org.organisationId, approverOne, { expenseId: cost.expenseId }));
    expect(journalId).toBeTruthy();

    // And the threshold is cleared rather than kept against a rule nobody is
    // applying, so the screen cannot show a number that means nothing.
    const policies = await as(org.adminUserId, (tx) =>
      listApprovalPolicies(tx, org.organisationId));
    const expense = policies.find((p) => p.actionKey === 'expense.approve')!;
    expect(expense).toMatchObject({ approvalsRequired: 1, thresholdMinor: 0n });
  });

  /* --------------------------------------------------------- isolation */

  it('is one organisation’s rule, not everybody’s', async () => {
    const other = await createOrganisation('Single Approver Letting');
    const policies = await as(other.adminUserId, (tx) =>
      listApprovalPolicies(tx, other.organisationId));
    for (const policy of policies) expect(policy.approvalsRequired).toBe(1);

    await expect(as(other.adminUserId, (tx) =>
      setApprovalPolicy(tx, org.organisationId, other.adminUserId, {
        actionKey: 'expense.approve', approvalsRequired: 2, thresholdMinor: 0n,
      }))).rejects.toThrow();
  });
});
