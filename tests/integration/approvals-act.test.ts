/**
 * Approvals that act.
 *
 * The approvals queue listed four kinds of work and could resolve one of them.
 * Maintenance quotations and draft expenses were shown with no decision
 * attached, and the deposit section read `deposit_events` where
 * `approved_at is null` — a row the database forbids outright, because
 * `deposit_events_refund_controls` requires an approver, evidence and a reason
 * on every deduction and refund. That section could never show anything.
 *
 * So there was no way for one person to prepare a payout and another to
 * approve it: the approver had to enter every detail themselves, which is the
 * opposite of segregation of duties. A request now lives in its own table, and
 * the rule it exists to serve is tested here: a request HOLDS NOTHING until
 * somebody approves it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, approvePayoutRequest, assertBookBalances, createResident,
  approveQuoteAndIssueWorkOrder, createStandaloneHouse, createTicket, createVendor,
  declinePayoutRequest, declineQuote, draftLease,
  getDepositAccount, listPayoutRequests, parseMajorToMinor, recordDepositReceipt,
  recordQuote, registerDocument, requestDepositPayout, withdrawPayoutRequest,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Approvals that act', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let depositAccountId: string;
  let evidenceId: string;
  let preparer: string;
  let propertyId: string;

  async function held(): Promise<bigint> {
    const account = await as(org.adminUserId, (tx) =>
      getDepositAccount(tx, org.organisationId, depositAccountId),
    );
    return account!.heldMinor;
  }

  beforeAll(async () => {
    org = await createOrganisation('Approvals Co');
    preparer = await addMember(org.organisationId, 'Prep Arer', ['finance_preparer']);

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Sipho', lastName: 'Ndlovu',
      }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Approval House', code: 'APP', propertyType: 'house',
        addressLine1: '9 Jacaranda Avenue', city: 'Pretoria',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('9000'), depositRequiredMinor: R('9000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    propertyId = house.propertyId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );

    const receipt = await as(org.adminUserId, (tx) =>
      recordDepositReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('9000'), receivedOn: '2026-01-01',
        holder: 'landlord', description: 'Deposit on signing',
      }),
    );
    depositAccountId = receipt.depositAccountId;

    const doc = await as(org.adminUserId, (tx) =>
      registerDocument(
        tx, org.organisationId, org.adminUserId,
        {
          classification: 'deposit_evidence', title: 'Repair quotation',
          filename: 'quote.pdf', contentType: 'application/pdf',
          byteSize: 2048, contentSha256: 'c'.repeat(64), leaseId,
        },
        { status: 'clean', detail: 'Scanned clean in a test.' },
      ),
    );
    evidenceId = doc.documentId;
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------- a request is not a movement */

  it('holds nothing while a payout request waits for a decision', async () => {
    const before = await held();
    expect(before).toBe(R('9000'));

    await as(preparer, (tx) =>
      requestDepositPayout(tx, org.organisationId, preparer, {
        depositAccountId, kind: 'deduction', amountMinor: R('1500'),
        effectiveOn: '2026-12-31', description: 'Broken shower screen',
        evidenceDocumentId: evidenceId,
      }),
    );

    // The same rule as an uploaded proof of payment: asking for something is
    // not the thing happening. The resident is still owed every cent.
    expect(await held()).toBe(before);
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));

    const pending = await as(org.adminUserId, (tx) =>
      listPayoutRequests(tx, org.organisationId, { pendingOnly: true }),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.amountMinor).toBe(R('1500'));
    expect(pending[0]!.requestedByName).toBe('Prep Arer');
  });

  it('refuses a request for more than the deposit holds', async () => {
    await expect(
      as(preparer, (tx) =>
        requestDepositPayout(tx, org.organisationId, preparer, {
          depositAccountId, kind: 'refund', amountMinor: R('20000'),
          effectiveOn: '2026-12-31', description: 'Full refund',
          evidenceDocumentId: evidenceId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('counts what is already requested against what is left', async () => {
    // R1,500 is already waiting. R8,000 more would be approvable twice over.
    await expect(
      as(preparer, (tx) =>
        requestDepositPayout(tx, org.organisationId, preparer, {
          depositAccountId, kind: 'refund', amountMinor: R('8000'),
          effectiveOn: '2026-12-31', description: 'Balance refund',
          evidenceDocumentId: evidenceId,
        }),
      ),
    ).rejects.toThrow(/already waiting/);

    // R7,500 fits alongside it.
    await as(preparer, (tx) =>
      requestDepositPayout(tx, org.organisationId, preparer, {
        depositAccountId, kind: 'refund', amountMinor: R('7500'),
        effectiveOn: '2026-12-31', description: 'Balance refund',
        evidenceDocumentId: evidenceId,
      }),
    );
    expect(await held()).toBe(R('9000'));
  });

  /* --------------------------------------------------- who may decide what */

  it('will not let the requester approve their own request', async () => {
    const [request] = await as(preparer, (tx) =>
      listPayoutRequests(tx, org.organisationId, { pendingOnly: true }),
    );

    await expect(
      as(preparer, (tx) =>
        approvePayoutRequest(tx, org.organisationId, preparer, {
          requestId: request!.id, approvalReason: 'I am sure about my own request.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // And nothing moved on the way to being refused.
    expect(await held()).toBe(R('9000'));
  });

  it('posts the movement when somebody else approves', async () => {
    const pending = await as(org.adminUserId, (tx) =>
      listPayoutRequests(tx, org.organisationId, { pendingOnly: true }),
    );
    const deduction = pending.find((r) => r.kind === 'deduction')!;

    const { eventId } = await as(org.adminUserId, (tx) =>
      approvePayoutRequest(tx, org.organisationId, org.adminUserId, {
        requestId: deduction.id,
        approvalReason: 'Quotation seen and the damage is on the move-out inspection.',
      }),
    );
    expect(eventId).toBeTruthy();

    // Now, and only now, the balance falls.
    expect(await held()).toBe(R('7500'));
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));

    const [stored] = await ownerSql()<
      { status: string; event_id: string | null; decided_by: string; requested_by: string }[]
    >`
      select status, event_id, decided_by::text, requested_by::text
        from deposit_payout_requests where id = ${deduction.id}
    `;
    expect(stored!.status).toBe('approved');
    expect(stored!.event_id).toBe(eventId);
    // The two names came from different places: one from the stored request,
    // one from the actor. Neither was supplied by the approver's form.
    expect(stored!.decided_by).not.toBe(stored!.requested_by);
  });

  it('cannot be approved twice', async () => {
    const [decided] = await ownerSql()<{ id: string }[]>`
      select id from deposit_payout_requests where status = 'approved' limit 1
    `;
    await expect(
      as(org.adminUserId, (tx) =>
        approvePayoutRequest(tx, org.organisationId, org.adminUserId, {
          requestId: decided!.id, approvalReason: 'Approving it a second time.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await held()).toBe(R('7500'));
  });

  it('declines without posting anything, and keeps the refusal', async () => {
    const [request] = await as(org.adminUserId, (tx) =>
      listPayoutRequests(tx, org.organisationId, { pendingOnly: true }),
    );

    await as(org.adminUserId, (tx) =>
      declinePayoutRequest(tx, org.organisationId, org.adminUserId, {
        requestId: request!.id,
        reason: 'The lease has not ended, so there is nothing to refund yet.',
      }),
    );

    expect(await held()).toBe(R('7500'));
    const all = await as(org.adminUserId, (tx) =>
      listPayoutRequests(tx, org.organisationId, { depositAccountId }),
    );
    const declined = all.find((r) => r.status === 'declined')!;
    expect(declined.decisionReason).toContain('has not ended');
    expect(declined.eventId).toBeNull();
  });

  it('lets the requester withdraw their own, and nobody else', async () => {
    await as(preparer, (tx) =>
      requestDepositPayout(tx, org.organisationId, preparer, {
        depositAccountId, kind: 'deduction', amountMinor: R('500'),
        effectiveOn: '2026-12-31', description: 'Cleaning',
        evidenceDocumentId: evidenceId,
      }),
    );
    const [request] = await as(preparer, (tx) =>
      listPayoutRequests(tx, org.organisationId, { pendingOnly: true }),
    );

    // Declining your own is refused: withdrawn and declined are different
    // facts, and collapsing them would hide who decided what.
    await expect(
      as(preparer, (tx) =>
        declinePayoutRequest(tx, org.organisationId, preparer, {
          requestId: request!.id, reason: 'Changed my mind about this one.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await as(preparer, (tx) =>
      withdrawPayoutRequest(tx, org.organisationId, preparer, {
        requestId: request!.id, reason: 'Raised against the wrong deposit account.',
      }),
    );

    const [stored] = await ownerSql()<{ status: string; decided_by: string | null }[]>`
      select status, decided_by::text from deposit_payout_requests where id = ${request!.id}
    `;
    expect(stored!.status).toBe('withdrawn');
    // No approver is recorded, because nobody approved anything.
    expect(stored!.decided_by).toBeNull();
  });

  it('refuses to let a decided request be rewritten', async () => {
    const [decided] = await ownerSql()<{ id: string }[]>`
      select id from deposit_payout_requests where status = 'approved' limit 1
    `;
    await expect(
      ownerSql()`
        update deposit_payout_requests set amount_minor = 1
        where id = ${decided!.id}
      `,
    ).rejects.toThrow(/cannot be changed/);
  });

  it('refuses to let a pending request change what was asked for', async () => {
    await as(preparer, (tx) =>
      requestDepositPayout(tx, org.organisationId, preparer, {
        depositAccountId, kind: 'deduction', amountMinor: R('250'),
        effectiveOn: '2026-12-31', description: 'Light fittings',
        evidenceDocumentId: evidenceId,
      }),
    );
    const [request] = await as(preparer, (tx) =>
      listPayoutRequests(tx, org.organisationId, { pendingOnly: true }),
    );

    // An approver must decide on the thing that was requested, not on an
    // amount somebody raised after they looked at it.
    await expect(
      ownerSql()`
        update deposit_payout_requests set amount_minor = 999999
        where id = ${request!.id}
      `,
    ).rejects.toThrow(/immutable/);
  });

  /* ----------------------------------------------- the other dead-end queue */

  it('declines a maintenance quotation with a reason', async () => {
    const vendor = await as(org.adminUserId, (tx) =>
      createVendor(tx, org.organisationId, org.adminUserId, {
        name: 'Plumb Right', category: 'plumbing', isContractor: true,
      }),
    );
    const ticket = await as(org.adminUserId, (tx) =>
      createTicket(tx, org.organisationId, org.adminUserId, {
        propertyId, leaseId, category: 'plumbing',
        description: 'The shower screen in the main bathroom is cracked through.',
      }),
    );

    const quote = await as(org.adminUserId, (tx) =>
      recordQuote(tx, org.organisationId, org.adminUserId, {
        ticketId: ticket.ticketId, vendorId: vendor.vendorId,
        amountMinor: R('4200'), currencyCode: 'ZAR',
      }),
    );

    await as(org.adminUserId, (tx) =>
      declineQuote(tx, org.organisationId, org.adminUserId, {
        quoteId: quote.quoteId, reason: 'Three times the second quotation for the same scope.',
      }),
    );

    const [stored] = await ownerSql()<{ status: string }[]>`
      select status from maintenance_quotes where id = ${quote.quoteId}
    `;
    expect(stored!.status).toBe('rejected');

    // A declined quotation is a closed decision, not a row to decide again.
    await expect(
      as(org.adminUserId, (tx) =>
        approveQuoteAndIssueWorkOrder(tx, org.organisationId, org.adminUserId, {
          quoteId: quote.quoteId, scope: 'Replace the shower screen.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not show one organisation another organisation\'s requests', async () => {
    const other = await createOrganisation('Elsewhere Approvals');
    const visible = await as(other.adminUserId, (tx) =>
      listPayoutRequests(tx, other.organisationId, {}),
    );
    expect(visible).toHaveLength(0);
  });
});
