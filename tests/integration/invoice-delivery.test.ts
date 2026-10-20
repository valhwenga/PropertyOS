/**
 * Sending a month's invoices.
 *
 * The claims under test are the ones a landlord would be entitled to be angry
 * about if they were false:
 *
 *   * a draft invoice cannot be sent, because it is not in the books yet;
 *   * sending moves no money and alters no document;
 *   * a resident with no email address is reported, not skipped;
 *   * nothing is ever marked sent on the strength of having tried;
 *   * one organisation cannot send, or even see, another's invoices.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, assertBookBalances, countInvoicesReadyToSend,
  createResident, createStandaloneHouse, draftLease, getInvoiceMessageTemplate,
  listInvoicesForSending, markInvoicesReadyToSend, parseMajorToMinor, postBillingRun,
  previewBillingRun, queueReadyInvoices, recordInvoiceDeliveryOutcome, saveBillingPreview,
  setInvoiceMessageTemplate, withdrawInvoiceFromSending,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');
const PORTAL = 'https://propertyos.example.invalid';

describe('Invoice delivery', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let documentIds: string[] = [];

  /** The invoices of the period, whatever state they are in. */
  async function invoices() {
    return as(org.adminUserId, (tx) => listInvoicesForSending(tx, org.organisationId));
  }

  beforeAll(async () => {
    org = await createOrganisation('Sending Rentals');

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Sending House', code: `SND${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '2 Invoice Road', city: 'Durban',
      }));

    // One resident who can be written to, and one who cannot.
    const reachable = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
        email: `reachable${Date.now()}@example.invalid`,
      }));
    const silent = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Sipho', lastName: 'Ndlovu',
      }));

    const second = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Silent House', code: `SIL${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '3 Invoice Road', city: 'Durban',
      }));

    for (const [unit, resident, target] of [
      [house, reachable, 'reachable'],
      [second, silent, 'silent'],
    ] as const) {
      const lease = await as(org.adminUserId, (tx) =>
        draftLease(tx, org.organisationId, org.adminUserId, {
          unitId: unit.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
          rentMinor: R('9000'), depositRequiredMinor: R('9000'),
          parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
        }));
      await as(org.adminUserId, (tx) =>
        activateLease(tx, org.organisationId, org.adminUserId, {
          leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-01-01',
          executionExceptionReason: 'Contract filed offline.',
        }));
      // Activation writes the rent schedule itself, which is what a real
      // month's billing run reads.
      // Only the reachable lease is referred to by id later; the silent one is
      // here to be suppressed, and is found through the invoice list.
      if (target === 'reachable') leaseId = lease.leaseId;
    }

    // A real billing run, so the invoices under test are the ones the product
    // actually raises rather than rows written by a test.
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2026-03-01' }));
    const run = await as(org.adminUserId, (tx) =>
      saveBillingPreview(tx, org.organisationId, org.adminUserId, preview));
    const posted = await as(org.adminUserId, (tx) =>
      postBillingRun(tx, org.organisationId, org.adminUserId, {
        runId: run.runId, previewVersion: run.previewVersion,
        idempotencyKey: `send-test-${Date.now()}`, issueDate: '2026-03-01',
      }));
    documentIds = posted.documentIds;
    expect(documentIds.length).toBe(2);
  });

  afterAll(async () => { await closeOwner(); });

  /* --------------------------------------------------------- what is listed */

  it('lists the month’s posted invoices as nobody having been told', async () => {
    const rows = await invoices();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.state).toBe('not_ready');
    expect(rows.some((r) => r.residentEmail === null)).toBe(true);
    expect(await as(org.adminUserId, (tx) =>
      countInvoicesReadyToSend(tx, org.organisationId))).toBe(0);
  });

  /* ------------------------------------------------------ what may be sent */

  it('refuses to send a draft invoice', async () => {
    // A draft is not in the books and can still change. Emailing one asks a
    // resident to pay against a figure that does not exist.
    const [draft] = await ownerSql()<{ id: string }[]>`
      insert into charge_documents (
        organisation_id, book_id, lease_id, document_type, document_number, status,
        currency_code, issue_date, due_date, total_minor)
      values (
        ${org.organisationId}, ${org.bookId}, ${leaseId}, 'rent_invoice',
        ${`DRAFT-${Date.now().toString().slice(-6)}`}, 'draft', 'ZAR',
        '2026-03-01', '2026-03-01', ${R('9000').toString()})
      returning id
    `;
    await expect(as(org.adminUserId, (tx) =>
      markInvoicesReadyToSend(tx, org.organisationId, org.adminUserId, {
        documentIds: [draft!.id],
      }))).rejects.toThrow(/not a posted invoice/);
    await ownerSql()`delete from charge_documents where id = ${draft!.id}`;
  });

  it('is refused to somebody without the permission', async () => {
    const preparer = await addMember(org.organisationId, 'Preparer', ['finance_preparer']);
    await expect(as(preparer, (tx) =>
      markInvoicesReadyToSend(tx, org.organisationId, preparer, { documentIds }),
    )).rejects.toThrow();
    await expect(as(preparer, (tx) =>
      queueReadyInvoices(tx, org.organisationId, preparer, { portalBaseUrl: PORTAL }),
    )).rejects.toThrow();
  });

  /* ------------------------------------------------------- marking and sending */

  it('marks posted invoices ready without sending anything', async () => {
    const { marked } = await as(org.adminUserId, (tx) =>
      markInvoicesReadyToSend(tx, org.organisationId, org.adminUserId, { documentIds }));
    expect(marked).toBe(2);
    expect(await as(org.adminUserId, (tx) =>
      countInvoicesReadyToSend(tx, org.organisationId))).toBe(2);

    // Nothing has been queued, no message exists, and the ledger is untouched.
    const [messages] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from notifications
       where organisation_id = ${org.organisationId}
    `;
    expect(messages!.total).toBe('0');
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('can take one back out before anything is sent', async () => {
    await as(org.adminUserId, (tx) =>
      withdrawInvoiceFromSending(tx, org.organisationId, org.adminUserId, {
        documentId: documentIds[0]!,
      }));
    expect(await as(org.adminUserId, (tx) =>
      countInvoicesReadyToSend(tx, org.organisationId))).toBe(1);

    await as(org.adminUserId, (tx) =>
      markInvoicesReadyToSend(tx, org.organisationId, org.adminUserId, {
        documentIds: [documentIds[0]!],
      }));
  });

  it('queues a message per invoice, and names who could not be reached', async () => {
    const outcome = await as(org.adminUserId, (tx) =>
      queueReadyInvoices(tx, org.organisationId, org.adminUserId, { portalBaseUrl: PORTAL }));

    // One resident has an address; the other does not and is REPORTED.
    expect(outcome.queued).toBe(1);
    expect(outcome.suppressed).toHaveLength(1);
    expect(outcome.suppressed[0]!.reason).toMatch(/no email address/i);

    const rows = await invoices();
    expect(rows.filter((r) => r.state === 'queued')).toHaveLength(1);
    expect(rows.filter((r) => r.state === 'suppressed')).toHaveLength(1);

    // The message carries the figures, and is written now rather than rendered
    // later from a template somebody might edit in between.
    const [message] = await ownerSql()<
      { subject: string; body: string; status: string; recipient_email: string }[]
    >`
      select subject, body, status, recipient_email::text
        from notifications where organisation_id = ${org.organisationId}
    `;
    expect(message!.status).toBe('queued');
    expect(message!.recipient_email).toContain('reachable');
    expect(message!.body).toContain('R9,000.00');
    expect(message!.body).toContain(`${PORTAL}/portal/${leaseId}`);
    expect(message!.body).not.toContain('{{');

    // And an event for the worker, which is what will actually try to send it.
    const [event] = await ownerSql()<{ event_type: string }[]>`
      select event_type from outbox_events
       where organisation_id = ${org.organisationId} and event_type = 'invoice.message.queued'
    `;
    expect(event?.event_type).toBe('invoice.message.queued');

    // Still no money has moved.
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('records a failure to deliver as a failure, not as sent', async () => {
    // What this deployment actually does: no provider, so the sink reports
    // that nothing was delivered and the invoice says so.
    await as(org.adminUserId, (tx) =>
      recordInvoiceDeliveryOutcome(tx, org.organisationId, {
        documentId: documentIds[0]!,
        delivered: false,
        detail: 'EMAIL_PROVIDER is not set to "smtp". Messages are recorded locally and NOT delivered.',
      }));
    const [row] = (await invoices()).filter((r) => r.documentId === documentIds[0]);
    expect(row!.state).toBe('undelivered');
    expect(row!.sentAt).toBeNull();
    expect(row!.outcomeDetail).toMatch(/NOT delivered/);
  });

  it('marks sent only with a time it happened', async () => {
    await as(org.adminUserId, (tx) =>
      recordInvoiceDeliveryOutcome(tx, org.organisationId, {
        documentId: documentIds[0]!, delivered: true, detail: 'Accepted by smtp.',
      }));
    const [row] = (await invoices()).filter((r) => r.documentId === documentIds[0]);
    expect(row!.state).toBe('sent');
    expect(row!.sentAt).toBeTruthy();

    // A sent message cannot be withdrawn: there is no unsending.
    await expect(as(org.adminUserId, (tx) =>
      withdrawInvoiceFromSending(tx, org.organisationId, org.adminUserId, {
        documentId: documentIds[0]!,
      }))).rejects.toThrow(/cannot be unsent/);
  });

  it('does not send the same invoice twice', async () => {
    // Already sent, so marking it ready again is refused rather than silently
    // queueing a second copy.
    const { marked, alreadySent } = await as(org.adminUserId, (tx) =>
      markInvoicesReadyToSend(tx, org.organisationId, org.adminUserId, {
        documentIds: [documentIds[0]!],
      }));
    expect(marked).toBe(0);
    expect(alreadySent).toHaveLength(1);
  });

  /* ------------------------------------------------------------- the wording */

  it('uses the product default until a landlord writes their own', async () => {
    const before = await as(org.adminUserId, (tx) =>
      getInvoiceMessageTemplate(tx, org.organisationId));
    expect(before.customised).toBe(false);

    const saved = await as(org.adminUserId, (tx) =>
      setInvoiceMessageTemplate(tx, org.organisationId, org.adminUserId, {
        subject: 'Invoice {{invoice.number}} from Sending Rentals',
        body: 'Hello {{resident.first_name}}, your invoice comes to {{invoice.total}}.',
      }));
    expect(saved.customised).toBe(true);
    expect(saved.subject).toContain('Sending Rentals');
  });

  it('refuses wording with a field it cannot fill in', async () => {
    // Better refused than sent with the braces showing.
    await expect(as(org.adminUserId, (tx) =>
      setInvoiceMessageTemplate(tx, org.organisationId, org.adminUserId, {
        subject: 'Invoice', body: 'Dear {{tenant.name}}, you owe {{invoice.total}}.',
      }))).rejects.toThrow(/does not fill in/);
  });

  /* --------------------------------------------------------------- isolation */

  it('is one organisation’s post, not everybody’s', async () => {
    const other = await createOrganisation('Other Sending Letting');
    expect(await as(other.adminUserId, (tx) =>
      listInvoicesForSending(tx, other.organisationId))).toEqual([]);
    expect(await as(other.adminUserId, (tx) =>
      listInvoicesForSending(tx, org.organisationId))).toEqual([]);
    await expect(as(other.adminUserId, (tx) =>
      markInvoicesReadyToSend(tx, org.organisationId, other.adminUserId, { documentIds }),
    )).rejects.toThrow();
    expect(await as(other.adminUserId, (tx) =>
      countInvoicesReadyToSend(tx, org.organisationId))).toBe(0);
  });
});
