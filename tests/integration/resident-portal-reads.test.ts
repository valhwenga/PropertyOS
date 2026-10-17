/**
 * The reads the portal added, and the boundaries they must not cross.
 *
 * Each of these exists because a resident is entitled to an answer that lives
 * on a row they may not read. The test for each is the same shape: the right
 * person gets the answer, the wrong person gets nothing, and the thing on the
 * row that is not theirs never comes with it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, addBankAccount, createResident, createStandaloneHouse, createTicket,
  createVendor, draftLease, parseMajorToMinor, postCharge, recordQuote,
  approveQuoteAndIssueWorkOrder, residentEmergencyContact, residentPaymentInstructions,
  residentTicketWork, revealResidentAccountNumber, saveOrganisationProfile, verifyBankAccount,
} from '@propertyos/domain';
import { loadBalanceSplit, loadResidentRequest } from '../../apps/web/src/lib/portal-queries';
import {
  addMember, as, asFreshlyAuthenticated, closeOwner, createOrganisation, grantPortalAccess,
  ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');
const ACCOUNT = '62000000001';

describe('Resident portal reads', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let resident: string;
  let stranger: string;
  let ticketId: string;

  beforeAll(async () => {
    org = await createOrganisation('Portal Reads Co');
    stranger = await addMember(org.organisationId, 'Not A Resident', ['property_manager']);

    const profile = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Reads', lastName: 'Resident',
      }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Reads House', code: 'RH', propertyType: 'house',
        addressLine1: '1 Reads Road', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('8000'),
        parties: [{ residentId: profile.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );
    resident = await grantPortalAccess(org.organisationId, leaseId, profile.residentId, 'Reads Resident');

    // One charge long overdue, one not due for years.
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice', issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'January rent', amountMinor: R('8000'), dueDate: '2026-01-01' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice', issueDate: '2026-01-01', dueDate: '2099-01-01',
        lines: [{ category: 'rent', description: 'Future rent', amountMinor: R('3000'), dueDate: '2099-01-01' }],
      }),
    );

    const account = await as(org.adminUserId, (tx) =>
      addBankAccount(tx, org.organisationId, org.adminUserId, {
        label: 'Operating account', bankName: 'Test Bank',
        accountHolder: 'Portal Reads Co', accountNumber: ACCOUNT,
        branchCode: '250655', reason: 'Set up for the test.',
      }),
    );
    await asFreshlyAuthenticated(org.adminUserId, (tx) =>
      verifyBankAccount(tx, org.organisationId, org.adminUserId, {
        bankAccountId: account.bankAccountId, method: 'bank_document',
        reason: 'Checked against a bank-issued letter.',
      }),
    );

    await as(org.adminUserId, (tx) =>
      saveOrganisationProfile(tx, org.organisationId, org.adminUserId, {
        tradingName: 'Reads Rentals', phone: '+27 21 000 0000',
        emergencyContact: '+27 82 000 0002',
        identityNumber: '8001015009087',
      }),
    );

    // A ticket with a quotation approved into a work order, so there is an
    // appointment and a contractor to read.
    const vendor = await as(org.adminUserId, (tx) =>
      createVendor(tx, org.organisationId, org.adminUserId, {
        name: 'Reads Plumbing', category: 'plumbing', isContractor: true,
      }),
    );
    const ticket = await as(org.adminUserId, (tx) =>
      createTicket(tx, org.organisationId, org.adminUserId, {
        propertyId: house.propertyId, unitId: house.unitId, leaseId,
        category: 'plumbing', urgency: 'normal',
        description: 'The shower screen is cracked through. It is getting worse.',
      }),
    );
    ticketId = ticket.ticketId;
    const quote = await as(org.adminUserId, (tx) =>
      recordQuote(tx, org.organisationId, org.adminUserId, {
        ticketId, vendorId: vendor.vendorId, amountMinor: R('2400'), currencyCode: 'ZAR',
      }),
    );
    await as(org.adminUserId, (tx) =>
      approveQuoteAndIssueWorkOrder(tx, org.organisationId, org.adminUserId, {
        quoteId: quote.quoteId, spendingCeilingMinor: R('2600'),
        scope: 'Replace the cracked shower screen.',
        appointmentAt: '2026-11-02T09:00:00.000Z',
      }),
    );

    // An internal comment and a resident-visible one.
    await ownerSql()`
      insert into maintenance_comments (organisation_id, ticket_id, author_user_id, audience, body)
      values
        (${org.organisationId}, ${ticketId}, ${org.adminUserId}, 'internal',
         'Negotiated the price down with the contractor.'),
        (${org.organisationId}, ${ticketId}, ${org.adminUserId}, 'resident_visible',
         'The glazier is booked for Monday morning.')
    `;
  });

  afterAll(async () => { await closeOwner(); });

  /* ---------------------------------------------------------- the balance */

  it('separates overdue from not yet due', async () => {
    const split = await as(resident, (tx) => loadBalanceSplit(tx, leaseId));
    expect(split.outstandingMinor).toBe(R('11000'));
    expect(split.overdueMinor).toBe(R('8000'));
    expect(split.upcomingMinor).toBe(R('3000'));
    expect(split.oldestDueDate).toBe('2026-01-01');
    expect(split.nextDueDate).toBe('2099-01-01');
  });

  it('gives a resident nothing for a lease in another organisation', async () => {
    // The four ledger views the portal reads are all `security_invoker`, so
    // the caller's own policies apply to them rather than the view owner's.
    // Pinned here because a view created without that option would hand every
    // resident the whole table and nothing else in the code would change.
    const other = await createOrganisation('Other Ledger Co');
    const theirResident = await as(other.adminUserId, (tx) =>
      createResident(tx, other.organisationId, other.adminUserId, {
        firstName: 'Other', lastName: 'Person',
      }),
    );
    const house = await as(other.adminUserId, (tx) =>
      createStandaloneHouse(tx, other.organisationId, other.adminUserId, {
        name: 'Other House', code: 'OTH', propertyType: 'house',
        addressLine1: '9 Other Road', city: 'Durban',
      }),
    );
    const lease = await as(other.adminUserId, (tx) =>
      draftLease(tx, other.organisationId, other.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('5000'),
        parties: [{ residentId: theirResident.residentId, role: 'primary_resident' }],
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
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'Their rent', amountMinor: R('5000'), dueDate: '2026-01-01' }],
      }),
    );

    const split = await as(resident, (tx) => loadBalanceSplit(tx, lease.leaseId));
    expect(split.outstandingMinor).toBe(0n);
    expect(await as(resident, (tx) => residentPaymentInstructions(tx, lease.leaseId))).toBeNull();
  });

  /* --------------------------------------------------- payment instructions */

  it('gives the resident the account without the number', async () => {
    const pay = await as(resident, (tx) => residentPaymentInstructions(tx, leaseId));
    expect(pay!.bankName).toBe('Test Bank');
    expect(pay!.accountNumberLast4).toBe('0001');
    expect(pay!.paymentReference).toMatch(/^LSE-/);
    expect(JSON.stringify(pay)).not.toContain(ACCOUNT);
  });

  it('shows the full number only when asked, and records it', async () => {
    const before = await ownerSql()<{ n: string }[]>`
      select count(*)::text as n from audit_events
      where organisation_id = ${org.organisationId}
        and action = 'bank_account.number_shown_to_resident'
    `;

    const shown = await as(resident, (tx) =>
      revealResidentAccountNumber(tx, leaseId, resident));
    expect(shown.accountNumber).toBe(ACCOUNT);
    expect(shown.accountNumberLast4).toBe('0001');

    const [after] = await ownerSql()<{ n: string; after_state: unknown }[]>`
      select count(*)::text as n,
             (array_agg(after_state order by occurred_at desc))[1] as after_state
      from audit_events
      where organisation_id = ${org.organisationId}
        and action = 'bank_account.number_shown_to_resident'
    `;
    expect(Number(after!.n)).toBe(Number(before[0]!.n) + 1);
    // The trail records WHICH account was shown, never the number itself.
    expect(JSON.stringify(after!.after_state)).not.toContain(ACCOUNT);
    expect(JSON.stringify(after!.after_state)).toContain('0001');
  });

  it('refuses the number to somebody who is not a resident of the lease', async () => {
    await expect(
      as(stranger, (tx) => revealResidentAccountNumber(tx, leaseId, stranger)),
    ).rejects.toThrow(/not found/i);
  });

  /* ------------------------------------------------------- the emergency */

  it('gives the configured emergency contact, and nothing when there is none', async () => {
    expect(await as(resident, (tx) => residentEmergencyContact(tx, leaseId)))
      .toBe('+27 82 000 0002');

    // Named carefully: `provisioning.test.ts` asserts that no organisation
    // matching 'No %Co' exists, so an organisation called "No Emergency Co"
    // fails somebody else's test from across the suite.
    const other = await createOrganisation('Unconfigured Emergency Rentals');
    const otherAdmin = other.adminUserId;
    await as(otherAdmin, (tx) =>
      saveOrganisationProfile(tx, other.organisationId, otherAdmin, { tradingName: 'Quiet Co' }));
    // Nothing configured means nothing shown. The screen says so rather than
    // printing a number nobody answers.
    expect(await as(resident, (tx) => residentEmergencyContact(tx, other.organisationId)))
      .toBeNull();
  });

  /* ------------------------------------------------------- the work order */

  it('tells the resident who is coming and when, and not what it costs', async () => {
    const work = await as(resident, (tx) => residentTicketWork(tx, ticketId));
    expect(work!.vendor_name).toBe('Reads Plumbing');
    expect(work!.appointment_at).not.toBeNull();
    // The ceiling, the approver and the quotation are the landlord's business.
    expect(Object.keys(work!)).toEqual([
      'appointment_at', 'status', 'completed_at', 'completion_note',
      'vendor_name', 'vendor_category',
    ]);
    expect(JSON.stringify(work)).not.toContain('2600');
    expect(JSON.stringify(work)).not.toContain('2400');
  });

  it('gives a non-resident nothing about the work order', async () => {
    expect(await as(stranger, (tx) => residentTicketWork(tx, ticketId))).toBeNull();
  });

  /* ------------------------------------------------------- the request */

  it('shows resident-visible updates and never the internal ones', async () => {
    const detail = await as(resident, (tx) => loadResidentRequest(tx, leaseId, ticketId));
    expect(detail!.ticket.reference).toMatch(/^TKT-/);
    expect(detail!.updates.map((u) => u.body)).toEqual(['The glazier is booked for Monday morning.']);
    expect(JSON.stringify(detail!.updates)).not.toContain('Negotiated');
    // The status history is the real one, not a story about it.
    expect(detail!.events.length).toBeGreaterThan(0);
    // And the real one is this: approving a quotation into a work order does
    // NOT move the ticket. The resident sees "Received" while a glazier is
    // booked for Monday, because the status is the ticket's and the
    // appointment is the work order's. The portal shows both rather than
    // inferring a status the domain never recorded — mapping 'submitted' to
    // "Scheduled" because a work order happens to exist would be the portal
    // inventing a state. Recorded as a gap in the maintenance workflow.
    expect(detail!.ticket.status).toBe('submitted');
    const work = await as(resident, (tx) => residentTicketWork(tx, ticketId));
    expect(work!.appointment_at).not.toBeNull();
  });

  it('does not reach a ticket on another lease', async () => {
    const elsewhere = await createOrganisation('Elsewhere Co');
    expect(await as(resident, (tx) =>
      loadResidentRequest(tx, elsewhere.organisationId, ticketId))).toBeNull();
  });
});
