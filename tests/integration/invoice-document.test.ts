/**
 * The invoice a tenant can hold.
 *
 * What a browser cannot settle and a layout test cannot either: that the
 * document is assembled from what was actually posted, that a tenant reading
 * their own invoice gets the same facts their landlord does, and that neither
 * id in the URL decides anything. A resident is a member of nothing, so every
 * part of this that lives on an organisation table reaches them through a
 * function that checks the portal link first — and this is where that is
 * proved, not asserted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, createResident, createStandaloneHouse, draftLease,
  listInvoicesForLease, loadInvoiceForOperator, loadInvoiceForResident,
  parseMajorToMinor, postBillingRun, previewBillingRun, renderInvoicePdf,
  saveBillingPreview, saveOrganisationProfile, setInvoiceTemplate,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, grantPortalAccess, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Invoice documents', () => {
  let org: OrganisationFixture;
  let other: OrganisationFixture;
  let leaseId: string;
  let documentId: string;
  let residentPortalUser: string;

  beforeAll(async () => {
    org = await createOrganisation('Invoice Documents Co');
    other = await createOrganisation('Nosy Letting');

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Protea Court', code: `INV${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '14 Protea Street', city: 'Cape Town',
      }));
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
        email: `invoice${Date.now()}@example.invalid`,
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

    // Who the landlord is, as it would be filled in before issuing anything.
    await as(org.adminUserId, (tx) =>
      saveOrganisationProfile(tx, org.organisationId, org.adminUserId, {
        legalName: 'Invoice Documents (Pty) Ltd',
        tradingName: 'Invoice Documents Co',
        registrationNumber: '2020/654321/07',
        vatNumber: '4998877665',
        physicalAddress: '9 Landlord Lane\nCape Town',
        phone: '021 555 0000',
        email: 'accounts@example.invalid',
      }));

    // A real billing run, so the invoice under test is one the product raises.
    const preview = await as(org.adminUserId, (tx) =>
      previewBillingRun(tx, org.organisationId, { periodStart: '2026-04-01' }));
    const run = await as(org.adminUserId, (tx) =>
      saveBillingPreview(tx, org.organisationId, org.adminUserId, preview));
    await as(org.adminUserId, (tx) =>
      postBillingRun(tx, org.organisationId, org.adminUserId, {
        runId: run.runId, previewVersion: run.previewVersion,
        idempotencyKey: `invoice-doc-${Date.now()}`, issueDate: '2026-04-01',
      }));

    const [document] = await ownerSql()<{ id: string }[]>`
      select id from charge_documents
       where organisation_id = ${org.organisationId} and lease_id = ${leaseId}
         and status = 'posted'
       order by issue_date desc limit 1
    `;
    documentId = document!.id;

    residentPortalUser = await grantPortalAccess(
      org.organisationId, leaseId, resident.residentId, 'Thandiwe Portal',
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('reads an invoice from what was posted, not from a template', async () => {
    const invoice = await as(org.adminUserId, (tx) =>
      loadInvoiceForOperator(tx, org.organisationId, documentId));

    expect(invoice.status).toBe('posted');
    expect(invoice.lines.length).toBeGreaterThan(0);
    // The sum of the lines IS the posted total: nothing here recomputes it.
    const sum = invoice.lines.reduce((total, line) => total + line.amountMinor, 0n);
    expect(sum).toBe(invoice.totalMinor);
    expect(invoice.totalMinor).toBe(R('9000'));

    // Who, where and on what lease.
    expect(invoice.residentName).toBe('Thandiwe Mokoena');
    expect(invoice.propertyName).toBe('Protea Court');
    expect(invoice.propertyAddress[0]).toBe('14 Protea Street');
    expect(invoice.landlord.legalName).toBe('Invoice Documents (Pty) Ltd');
    expect(invoice.landlord.vatNumber).toBe('4998877665');

    // The reference a tenant must quote is the lease reference, because that
    // is what reconciliation matches a payment on. If this ever changes, the
    // bank import stops suggesting the right lease.
    const [lease] = await ownerSql()<{ reference: string }[]>`
      select reference from leases where id = ${leaseId}
    `;
    expect(invoice.leaseReference).toBe(lease!.reference);
  });

  it('gives the tenant the same document their landlord sees', async () => {
    const operator = await as(org.adminUserId, (tx) =>
      loadInvoiceForOperator(tx, org.organisationId, documentId));
    const resident = await as(residentPortalUser, (tx) =>
      loadInvoiceForResident(tx, leaseId, documentId));

    expect(resident.documentNumber).toBe(operator.documentNumber);
    expect(resident.totalMinor).toBe(operator.totalMinor);
    expect(resident.leaseReference).toBe(operator.leaseReference);
    expect(resident.lines).toHaveLength(operator.lines.length);
    // Including who is charging them — which lives on a table a resident
    // cannot read, and reaches them through a function instead.
    expect(resident.landlord.legalName).toBe('Invoice Documents (Pty) Ltd');
    expect(resident.landlord.registrationNumber).toBe('2020/654321/07');
  });

  it('refuses a document that belongs to somebody else', async () => {
    // Another landlord, naming this document by its own id.
    await expect(as(other.adminUserId, (tx) =>
      loadInvoiceForOperator(tx, other.organisationId, documentId))).rejects.toThrow(/not/i);
    // And the same organisation id with a document id from nowhere.
    await expect(as(org.adminUserId, (tx) => loadInvoiceForOperator(
      tx, org.organisationId, '00000000-0000-0000-0000-000000000000',
    ))).rejects.toThrow(/not/i);
  });

  it('refuses a resident a lease that is not theirs', async () => {
    const stranger = await createOrganisation('Stranger Rentals');
    const strangerHouse = await as(stranger.adminUserId, (tx) =>
      createStandaloneHouse(tx, stranger.organisationId, stranger.adminUserId, {
        name: 'Stranger House', code: `STR${Date.now().toString().slice(-6)}`,
        propertyType: 'house', addressLine1: '1 Elsewhere Road', city: 'Durban',
      }));
    const strangerResident = await as(stranger.adminUserId, (tx) =>
      createResident(tx, stranger.organisationId, stranger.adminUserId, {
        firstName: 'Nomsa', lastName: 'Dube',
      }));
    const strangerLease = await as(stranger.adminUserId, (tx) =>
      draftLease(tx, stranger.organisationId, stranger.adminUserId, {
        unitId: strangerHouse.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('5000'), depositRequiredMinor: R('5000'),
        parties: [{ residentId: strangerResident.residentId, role: 'primary_resident' }],
      }));
    const strangerUser = await grantPortalAccess(
      stranger.organisationId, strangerLease.leaseId, strangerResident.residentId, 'Nomsa Portal',
    );

    // Their own lease id with our document id: the document does not belong to
    // that lease, so there is nothing to read.
    await expect(as(strangerUser, (tx) =>
      loadInvoiceForResident(tx, strangerLease.leaseId, documentId))).rejects.toThrow(/not/i);
    // Our lease id with our document id, as them: the lease is not theirs.
    await expect(as(strangerUser, (tx) =>
      loadInvoiceForResident(tx, leaseId, documentId))).rejects.toThrow(/not/i);
  });

  it('lists the posted invoices on a lease, and nobody else’s', async () => {
    const mine = await as(residentPortalUser, (tx) => listInvoicesForLease(tx, leaseId));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((invoice) => invoice.documentId === documentId)).toBe(true);

    // Another organisation's admin asking for this lease by its id gets an
    // empty list rather than a refusal, because row-level security simply
    // shows them nothing.
    expect(await as(other.adminUserId, (tx) => listInvoicesForLease(tx, leaseId))).toEqual([]);
  });

  it('renders in whichever design the landlord chose, with the real figures', async () => {
    await as(org.adminUserId, (tx) =>
      setInvoiceTemplate(tx, org.organisationId, org.adminUserId, 'modern'));

    const invoice = await as(org.adminUserId, (tx) =>
      loadInvoiceForOperator(tx, org.organisationId, documentId));
    const pdf = renderInvoicePdf(invoice, { template: 'modern', accent: 'forest' });
    const text = Buffer.from(pdf).toString('latin1');

    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain(invoice.documentNumber);
    expect(text).toContain(invoice.leaseReference);
    expect(text).toContain('9,000.00');

    // And the choice is recorded, like every other setting.
    const [event] = await ownerSql()<{ action: string }[]>`
      select action from audit_events
       where organisation_id = ${org.organisationId}
         and action = 'organisation_branding.invoice_template_set'
       order by occurred_at desc limit 1
    `;
    expect(event?.action).toBe('organisation_branding.invoice_template_set');
  });
});
