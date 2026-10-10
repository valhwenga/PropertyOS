/**
 * Milestone 3 acceptance: maintenance, inspections, private documents and
 * resident invitations.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  acceptInvitation, activateLease, addComment, approveQuoteAndIssueWorkOrder,
  authoriseDownload, completeWorkOrder, createInspection, createResident,
  createStandaloneHouse, createTemplateVersion, createTicket, draftLease,
  finaliseInspection, issueInvitation, parseMajorToMinor, prepareInvitation,
  recordQuote, registerDocument, respondToInspection, reviseInspection,
  revokePortalAccess, shareDocument, transitionTicket,
} from '@propertyos/domain';
import type { Sql } from '@propertyos/db';
import {
  addMember, as, closeOwner, createAuthUser, createOrganisation,
  grantPortalAccess, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');
const CLEAN = { status: 'clean' as const };
const UNSCANNED = {
  status: 'skipped_not_configured' as const,
  detail: 'No malware scanner is configured, so this file has NOT been scanned.',
};

describe('Property operations', () => {
  let org: OrganisationFixture;
  let propertyId: string;
  let unitId: string;
  let residentId: string;
  let leaseId: string;
  let residentUser: string;
  let vendorId: string;

  beforeAll(async () => {
    org = await createOrganisation('Operations Co');
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Ops House', code: 'OPS1', propertyType: 'house',
        addressLine1: '5 Ops Street', city: 'Cape Town',
      }),
    );
    propertyId = house.propertyId;
    unitId = house.unitId;

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Ops', lastName: 'Resident', email: 'ops.resident@demo.invalid',
      }),
    );
    residentId = resident.residentId;

    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId, startDate: '2026-01-01', endDate: '2026-12-31', rentMinor: R('7000'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Executed contract filed offline.',
      }),
    );
    residentUser = await grantPortalAccess(org.organisationId, leaseId, residentId, 'Ops Portal User');

    const [vendor] = await ownerSql()<{ id: string }[]>`
      insert into vendors (organisation_id, name, is_contractor)
      values (${org.organisationId}, 'Cape Plumbing CC', true) returning id
    `;
    vendorId = vendor!.id;
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------------------------ maintenance */

  describe('maintenance', () => {
    let ticketId: string;

    it('lets a resident log a request on their own lease', async () => {
      const result = await as(residentUser, (tx) =>
        createTicket(tx, org.organisationId, residentUser, {
          propertyId, unitId, leaseId, residentId,
          category: 'plumbing',
          description: 'The kitchen tap has been dripping steadily since Tuesday.',
          urgency: 'normal',
        }, { asResident: true }),
      );
      ticketId = result.ticketId;
      expect(result.reference).toMatch(/^TKT-\d{6}$/);
    });

    it('refuses a resident request against a lease they do not hold', async () => {
      const otherResident = await as(org.adminUserId, (tx) =>
        createResident(tx, org.organisationId, org.adminUserId, {
          firstName: 'Other', lastName: 'Person',
        }),
      );
      const otherHouse = await as(org.adminUserId, (tx) =>
        createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
          name: 'Other Ops House', code: 'OPS2', propertyType: 'house',
          addressLine1: '6 Ops Street', city: 'Cape Town',
        }),
      );
      const otherLease = await as(org.adminUserId, (tx) =>
        draftLease(tx, org.organisationId, org.adminUserId, {
          unitId: otherHouse.unitId, startDate: '2026-01-01', rentMinor: R('5000'),
          parties: [{ residentId: otherResident.residentId, role: 'primary_resident' }],
        }),
      );

      await expect(
        as(residentUser, (tx) =>
          createTicket(tx, org.organisationId, residentUser, {
            propertyId: otherHouse.propertyId, leaseId: otherLease.leaseId,
            category: 'plumbing',
            description: 'Attempting to log against a lease that is not mine.',
          }, { asResident: true }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('keeps the resident claim and the manager assessment separate', async () => {
      await as(org.adminUserId, (tx) =>
        transitionTicket(tx, org.organisationId, org.adminUserId, {
          ticketId, to: 'triaged', triagedUrgency: 'high',
          note: 'Water damage risk to the cabinet below.',
        }),
      );
      const [ticket] = await ownerSql()<{ urgency: string; triaged_urgency: string }[]>`
        select urgency, triaged_urgency from maintenance_tickets where id = ${ticketId}
      `;
      // The resident said "normal"; the manager says "high". Both survive.
      expect(ticket).toMatchObject({ urgency: 'normal', triaged_urgency: 'high' });
    });

    it('rejects an illegal state transition', async () => {
      await expect(
        as(org.adminUserId, (tx) =>
          transitionTicket(tx, org.organisationId, org.adminUserId, {
            ticketId, to: 'closed',
          }),
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('requires a reason to put a ticket on hold', async () => {
      await expect(
        as(org.adminUserId, (tx) =>
          transitionTicket(tx, org.organisationId, org.adminUserId, { ticketId, to: 'on_hold' }),
        ),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it('hides internal comments from the resident and shows resident-visible ones', async () => {
      await as(org.adminUserId, (tx) =>
        addComment(tx, org.organisationId, org.adminUserId, {
          ticketId, audience: 'internal',
          body: 'INTERNAL: tenant has been slow to pay; get a fixed quote before committing.',
        }),
      );
      await as(org.adminUserId, (tx) =>
        addComment(tx, org.organisationId, org.adminUserId, {
          ticketId, audience: 'resident_visible',
          body: 'Thanks for reporting this. A plumber will contact you to arrange access.',
        }),
      );
      await as(org.adminUserId, (tx) =>
        addComment(tx, org.organisationId, org.adminUserId, {
          ticketId, audience: 'contractor_visible',
          body: 'CONTRACTOR: access via the side gate, code on the work order.',
        }),
      );

      const operatorSees = await as(org.adminUserId, (tx) =>
        tx`select audience, body from maintenance_comments where ticket_id = ${ticketId}::uuid`,
      );
      expect(operatorSees).toHaveLength(3);

      const residentSees = await as(residentUser, (tx) =>
        tx<{ audience: string; body: string }[]>`
          select audience, body from maintenance_comments where ticket_id = ${ticketId}::uuid
        `,
      );
      expect(residentSees).toHaveLength(1);
      expect(residentSees[0]!.audience).toBe('resident_visible');
      // The internal note must not be reachable at all, not merely unrendered.
      expect(JSON.stringify(residentSees)).not.toContain('INTERNAL');
      expect(JSON.stringify(residentSees)).not.toContain('CONTRACTOR');
    });

    it('refuses to let a resident write an internal comment', async () => {
      await expect(
        as(residentUser, (tx) =>
          addComment(tx, org.organisationId, residentUser, {
            ticketId, audience: 'internal', body: 'Trying to write an internal note.',
          }, { asResident: true }),
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('separates triage authority from spending authority', async () => {
      // This member can manage tickets but cannot approve spending.
      const triager = await addMember(
        org.organisationId, 'Triage Only', ['property_manager'], { type: 'organisation' },
      );
      const quote = await as(org.adminUserId, (tx) =>
        recordQuote(tx, org.organisationId, org.adminUserId, {
          ticketId, vendorId, amountMinor: R('2400'), currencyCode: 'ZAR',
        }),
      );
      await expect(
        as(triager, (tx) =>
          approveQuoteAndIssueWorkOrder(tx, org.organisationId, triager, {
            quoteId: quote.quoteId, scope: 'Replace kitchen tap',
          }),
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('records the expense once, linked to the work order', async () => {
      const quote = await as(org.adminUserId, (tx) =>
        recordQuote(tx, org.organisationId, org.adminUserId, {
          ticketId, vendorId, amountMinor: R('2400'), currencyCode: 'ZAR',
        }),
      );
      const workOrder = await as(org.adminUserId, (tx) =>
        approveQuoteAndIssueWorkOrder(tx, org.organisationId, org.adminUserId, {
          quoteId: quote.quoteId, scope: 'Replace kitchen tap and washer',
        }),
      );
      const completion = await as(org.adminUserId, (tx) =>
        completeWorkOrder(tx, org.organisationId, org.adminUserId, {
          workOrderId: workOrder.workOrderId,
          completionNote: 'Tap and washer replaced, tested.',
          invoiceReference: 'CP-2026-0042',
          invoiceAmountMinor: R('2400'),
          expenseDate: '2026-02-10',
        }),
      );
      expect(completion.exceededCeiling).toBe(false);

      const [expense] = await ownerSql()<{ status: string; work_order_id: string; amount_minor: string }[]>`
        select status, work_order_id, amount_minor::text from expenses where id = ${completion.expenseId}
      `;
      // A draft, not an approved cost.
      //
      // This asserted `status: 'approved'` when nothing in the product could
      // post an expense, so the label meant nothing. It means something now,
      // and what it meant here was false: no journal was posted, no approver
      // was named, and `completeWorkOrder` requires only `expense.record`.
      // Completing a work order records the supplier's invoice; approving it
      // into the books is a separate act with its own permission.
      expect(expense).toMatchObject({ status: 'draft', work_order_id: workOrder.workOrderId });

      const [posted] = await ownerSql()<{ journal_id: string | null }[]>`
        select journal_id::text from expenses where id = ${completion.expenseId}
      `;
      expect(posted!.journal_id).toBeNull();
    });

    it('refuses to record the same supplier invoice twice', async () => {
      const quote = await as(org.adminUserId, (tx) =>
        recordQuote(tx, org.organisationId, org.adminUserId, {
          ticketId, vendorId, amountMinor: R('500'), currencyCode: 'ZAR',
        }),
      );
      const workOrder = await as(org.adminUserId, (tx) =>
        approveQuoteAndIssueWorkOrder(tx, org.organisationId, org.adminUserId, {
          quoteId: quote.quoteId, scope: 'Follow-up visit',
        }),
      );
      await expect(
        as(org.adminUserId, (tx) =>
          completeWorkOrder(tx, org.organisationId, org.adminUserId, {
            workOrderId: workOrder.workOrderId,
            completionNote: 'Duplicate invoice attempt.',
            // Same reference as the previous test: a receipt must not be counted twice.
            invoiceReference: 'CP-2026-0042',
            invoiceAmountMinor: R('500'),
            expenseDate: '2026-02-11',
          }),
        ),
      ).rejects.toMatchObject({ code: 'duplicate' });
    });

    it('holds an over-ceiling invoice as a draft for approval', async () => {
      const quote = await as(org.adminUserId, (tx) =>
        recordQuote(tx, org.organisationId, org.adminUserId, {
          ticketId, vendorId, amountMinor: R('1000'), currencyCode: 'ZAR',
        }),
      );
      const workOrder = await as(org.adminUserId, (tx) =>
        approveQuoteAndIssueWorkOrder(tx, org.organisationId, org.adminUserId, {
          quoteId: quote.quoteId, scope: 'Capped job', ceilingMinor: R('1000'),
        }),
      );
      const completion = await as(org.adminUserId, (tx) =>
        completeWorkOrder(tx, org.organisationId, org.adminUserId, {
          workOrderId: workOrder.workOrderId,
          completionNote: 'Additional parts were required on site.',
          invoiceReference: 'CP-2026-0099',
          invoiceAmountMinor: R('1600'),
          expenseDate: '2026-02-12',
        }),
      );
      expect(completion.exceededCeiling).toBe(true);
      const [expense] = await ownerSql()<{ status: string }[]>`
        select status from expenses where id = ${completion.expenseId}
      `;
      expect(expense!.status).toBe('draft');
    });

    it('retains the full history when a ticket is reopened', async () => {
      await as(org.adminUserId, (tx) =>
        transitionTicket(tx, org.organisationId, org.adminUserId, { ticketId, to: 'assigned' }),
      );
      await as(org.adminUserId, (tx) =>
        transitionTicket(tx, org.organisationId, org.adminUserId, { ticketId, to: 'in_progress' }),
      );
      await as(org.adminUserId, (tx) =>
        transitionTicket(tx, org.organisationId, org.adminUserId, { ticketId, to: 'resolved' }),
      );
      await as(org.adminUserId, (tx) =>
        transitionTicket(tx, org.organisationId, org.adminUserId, {
          ticketId, to: 'in_progress', note: 'Resident reports the drip has returned.',
        }),
      );
      const events = await ownerSql()<{ to_status: string }[]>`
        select to_status from maintenance_ticket_events
        where ticket_id = ${ticketId} order by occurred_at, id
      `;
      expect(events.map((e) => e.to_status)).toEqual([
        'submitted', 'triaged', 'assigned', 'in_progress', 'resolved', 'in_progress',
      ]);
    });
  });

  /* ------------------------------------------------------------ inspections */

  describe('inspections', () => {
    let templateId: string;
    let inspectionId: string;

    it('versions a checklist template instead of editing it', async () => {
      const v1 = await as(org.adminUserId, (tx) =>
        createTemplateVersion(tx, org.organisationId, org.adminUserId, {
          name: 'Standard residential',
          items: [
            { room: 'Kitchen', item: 'Sink and taps' },
            { room: 'Kitchen', item: 'Oven' },
            { room: 'Bathroom', item: 'Shower' },
          ],
        }),
      );
      expect(v1.version).toBe(1);

      const v2 = await as(org.adminUserId, (tx) =>
        createTemplateVersion(tx, org.organisationId, org.adminUserId, {
          name: 'Standard residential',
          items: [
            { room: 'Kitchen', item: 'Sink and taps' },
            { room: 'Kitchen', item: 'Oven' },
            { room: 'Bathroom', item: 'Shower' },
            { room: 'Bathroom', item: 'Extractor fan' },
          ],
        }),
      );
      expect(v2.version).toBe(2);
      templateId = v2.templateId;

      // Version 1 still exists and is readable.
      const versions = await ownerSql()<{ version: number; is_active: boolean }[]>`
        select version, is_active from inspection_templates
        where organisation_id = ${org.organisationId} and name = 'Standard residential'
        order by version
      `;
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({ version: 1, is_active: false });
    });

    it('records the template version on the inspection', async () => {
      const result = await as(org.adminUserId, (tx) =>
        createInspection(tx, org.organisationId, org.adminUserId, {
          unitId, leaseId, templateId, inspectionType: 'move_in', scheduledFor: '2026-01-01',
        }),
      );
      inspectionId = result.inspectionId;

      const [inspection] = await ownerSql()<{ template_version: number }[]>`
        select template_version from inspections where id = ${inspectionId}
      `;
      expect(inspection!.template_version).toBe(2);

      const items = await ownerSql()<{ room: string }[]>`
        select room from inspection_items where inspection_id = ${inspectionId}
      `;
      expect(items).toHaveLength(4);
    });

    it('hides a draft inspection from the resident, and shows it once finalised', async () => {
      let residentSees = await as(residentUser, (tx) =>
        tx`select id from inspections where id = ${inspectionId}::uuid`,
      );
      expect(residentSees).toHaveLength(0);

      await ownerSql()`
        update inspection_items set condition = 'good' where inspection_id = ${inspectionId}
      `;
      await as(org.adminUserId, (tx) =>
        finaliseInspection(tx, org.organisationId, org.adminUserId, {
          inspectionId, performedOn: '2026-01-01', attendees: 'Landlord and resident',
        }),
      );

      residentSees = await as(residentUser, (tx) =>
        tx`select id from inspections where id = ${inspectionId}::uuid`,
      );
      expect(residentSees).toHaveLength(1);
    });

    it('refuses to finalise the same inspection twice', async () => {
      await expect(
        as(org.adminUserId, (tx) =>
          finaliseInspection(tx, org.organisationId, org.adminUserId, {
            inspectionId, performedOn: '2026-01-02',
          }),
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('lets a resident dispute without editing the inspector record', async () => {
      await as(residentUser, (tx) =>
        respondToInspection(tx, org.organisationId, residentUser, {
          inspectionId, residentId, response: 'disputed',
          comment: 'The oven was already scratched when I moved in.',
        }),
      );
      const [inspection] = await ownerSql()<{ status: string }[]>`
        select status from inspections where id = ${inspectionId}
      `;
      expect(inspection!.status).toBe('disputed');

      // The resident cannot change the recorded conditions. Row Level Security
      // filters the UPDATE to zero rows rather than raising, so the assertion
      // that matters is that nothing actually changed.
      const before = await ownerSql()<{ condition: string }[]>`
        select condition from inspection_items where inspection_id = ${inspectionId} order by sort_order
      `;
      await as(residentUser, (tx) =>
        tx`update inspection_items set condition = 'damaged' where inspection_id = ${inspectionId}::uuid`,
      );
      const after = await ownerSql()<{ condition: string }[]>`
        select condition from inspection_items where inspection_id = ${inspectionId} order by sort_order
      `;
      expect(after).toEqual(before);
      expect(after.every((i) => i.condition === 'good')).toBe(true);
    });

    it('revises a finalised inspection into a new version, retaining the original', async () => {
      const revision = await as(org.adminUserId, (tx) =>
        reviseInspection(tx, org.organisationId, org.adminUserId, {
          inspectionId, reason: 'Oven condition corrected after reviewing move-in photos.',
        }),
      );
      const [original] = await ownerSql()<{ status: string }[]>`
        select status from inspections where id = ${inspectionId}
      `;
      const [revised] = await ownerSql()<{ supersedes_inspection_id: string; revision_reason: string }[]>`
        select supersedes_inspection_id, revision_reason from inspections where id = ${revision.inspectionId}
      `;
      expect(original!.status).toBe('superseded');
      expect(revised!.supersedes_inspection_id).toBe(inspectionId);
    });
  });

  /* -------------------------------------------------------------- documents */

  describe('private documents', () => {
    it('quarantines an upload when no scanner is configured, and refuses to share it', async () => {
      const doc = await as(org.adminUserId, (tx) =>
        registerDocument(tx, org.organisationId, org.adminUserId, {
          classification: 'lease', title: 'Signed lease agreement',
          filename: 'lease.pdf', contentType: 'application/pdf', byteSize: 204800,
          leaseId,
        }, UNSCANNED),
      );
      expect(doc.quarantined).toBe(true);

      await expect(
        as(org.adminUserId, (tx) =>
          shareDocument(tx, org.organisationId, org.adminUserId, {
            documentId: doc.documentId, visibility: 'resident_shared',
          }),
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('rejects sharing a quarantined file even when written directly to the table', async () => {
      const doc = await as(org.adminUserId, (tx) =>
        registerDocument(tx, org.organisationId, org.adminUserId, {
          classification: 'lease', title: 'Another unscanned file',
          filename: 'other.pdf', contentType: 'application/pdf', byteSize: 1024, leaseId,
        }, UNSCANNED),
      );
      // The database check constraint is the real guard.
      await expect(
        ownerSql()`
          update documents set visibility = 'resident_shared' where id = ${doc.documentId}
        `,
      ).rejects.toThrow(/documents_quarantine_not_shared/);
    });

    it('shares a clean document and lets the resident download it', async () => {
      const doc = await as(org.adminUserId, (tx) =>
        registerDocument(tx, org.organisationId, org.adminUserId, {
          classification: 'lease', title: 'Lease agreement (scanned clean)',
          filename: 'clean-lease.pdf', contentType: 'application/pdf', byteSize: 102400, leaseId,
        }, CLEAN),
      );
      expect(doc.quarantined).toBe(false);

      await as(org.adminUserId, (tx) =>
        shareDocument(tx, org.organisationId, org.adminUserId, {
          documentId: doc.documentId, visibility: 'resident_shared',
        }),
      );

      const grant = await as(residentUser, (tx) =>
        authoriseDownload(tx, org.organisationId, residentUser, { documentId: doc.documentId }),
      );
      expect(grant.storageKey).toContain(org.organisationId);
      expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now());
      // Short lived: never more than 15 minutes.
      expect(grant.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);

      const [recorded] = await ownerSql()<{ count: string }[]>`
        select count(*)::text from document_access_grants where document_id = ${doc.documentId}
      `;
      expect(recorded!.count).toBe('1');
    });

    it('denies a resident an internal document on their own lease', async () => {
      const internal = await as(org.adminUserId, (tx) =>
        registerDocument(tx, org.organisationId, org.adminUserId, {
          classification: 'other', title: 'Internal arrears note',
          filename: 'internal.pdf', contentType: 'application/pdf', byteSize: 2048, leaseId,
        }, CLEAN),
      );
      await expect(
        as(residentUser, (tx) =>
          authoriseDownload(tx, org.organisationId, residentUser, { documentId: internal.documentId }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('requires a separate permission to download an identity document', async () => {
      const identity = await as(org.adminUserId, (tx) =>
        registerDocument(tx, org.organisationId, org.adminUserId, {
          classification: 'identity', title: 'ID copy',
          filename: 'id.pdf', contentType: 'application/pdf', byteSize: 4096, residentId,
        }, CLEAN),
      );
      // A property manager has document.read but NOT document.identity.read.
      const manager = await addMember(
        org.organisationId, 'Doc Manager', ['property_manager'], { type: 'organisation' },
      );
      await expect(
        as(manager, (tx) =>
          authoriseDownload(tx, org.organisationId, manager, { documentId: identity.documentId }),
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });

      // The administrator does hold it.
      const grant = await as(org.adminUserId, (tx) =>
        authoriseDownload(tx, org.organisationId, org.adminUserId, {
          documentId: identity.documentId, reason: 'Verifying lease party identity',
        }),
      );
      expect(grant.storageKey).toBeTruthy();
    });
  });

  /* ------------------------------------------------------------ invitations */

  describe('resident invitations', () => {
    it('shows the lease and recipient for review before sending', async () => {
      const review = await as(org.adminUserId, (tx) =>
        prepareInvitation(tx, org.organisationId, { leaseId, residentId }),
      );
      expect(review.residentName).toBe('Ops Resident');
      expect(review.unitLabel).toContain('Ops House');
      expect(review.leaseReference).toMatch(/^LSE-/);
    });

    it('refuses to invite a resident who is not a party to the lease', async () => {
      const stranger = await as(org.adminUserId, (tx) =>
        createResident(tx, org.organisationId, org.adminUserId, {
          firstName: 'Not', lastName: 'OnThisLease',
        }),
      );
      await expect(
        as(org.adminUserId, (tx) =>
          prepareInvitation(tx, org.organisationId, {
            leaseId, residentId: stranger.residentId,
          }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('refuses when the confirmed recipient does not match the lease party', async () => {
      await expect(
        as(org.adminUserId, (tx) =>
          issueInvitation(tx, org.organisationId, org.adminUserId, {
            leaseId, residentId, email: 'typo@demo.invalid',
            confirmedRecipient: 'Somebody Else',
          }),
        ),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it('stores only the token hash, never the token', async () => {
      const invitation = await as(org.adminUserId, (tx) =>
        issueInvitation(tx, org.organisationId, org.adminUserId, {
          leaseId, residentId, email: 'ops.resident@demo.invalid',
          confirmedRecipient: 'Ops Resident',
        }),
      );
      const [row] = await ownerSql()<{ hash_hex: string; token_present: boolean }[]>`
        select encode(invite_token_hash, 'hex') as hash_hex,
               (invite_token_hash::text like ${`%${invitation.token}%`}) as token_present
        from portal_links where id = ${invitation.portalLinkId}
      `;
      expect(row!.hash_hex).toHaveLength(64);
      expect(row!.token_present).toBe(false);

      // The token is not in the audit trail either.
      const audit = await ownerSql()<{ after_state: unknown }[]>`
        select after_state from audit_events
        where resource_id = ${invitation.portalLinkId} and action = 'portal.invitation.issued'
      `;
      expect(JSON.stringify(audit)).not.toContain(invitation.token);
    });

    it('consumes the token on acceptance so it cannot be replayed', async () => {
      const newResident = await as(org.adminUserId, (tx) =>
        createResident(tx, org.organisationId, org.adminUserId, {
          firstName: 'Replay', lastName: 'Target',
        }),
      );
      await ownerSql()`
        insert into lease_parties (organisation_id, lease_id, resident_id, role)
        values (${org.organisationId}, ${leaseId}, ${newResident.residentId}, 'co_lessee')
      `;
      const invitation = await as(org.adminUserId, (tx) =>
        issueInvitation(tx, org.organisationId, org.adminUserId, {
          leaseId, residentId: newResident.residentId,
          email: 'replay@demo.invalid', confirmedRecipient: 'Replay Target',
        }),
      );

      const firstUser = await createAuthUser('First Acceptor');
      const accepted = await ownerSql().begin((tx) =>
        acceptInvitation(tx as unknown as Sql, { token: invitation.token, authUserId: firstUser }),
      );
      expect(accepted).toMatchObject({ leaseId });

      // An attacker replaying the same link gets the same generic refusal as a
      // completely invalid token.
      const secondUser = await createAuthUser('Replay Attacker');
      await expect(
        ownerSql().begin((tx) =>
          acceptInvitation(tx as unknown as Sql, { token: invitation.token, authUserId: secondUser }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });

      await expect(
        ownerSql().begin((tx) =>
          acceptInvitation(tx as unknown as Sql, {
            token: 'completely-invalid-token', authUserId: secondUser,
          }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('cuts off access immediately when the link is revoked', async () => {
      const [link] = await ownerSql()<{ id: string }[]>`
        select id from portal_links where lease_id = ${leaseId} and auth_user_id = ${residentUser}
      `;
      await as(org.adminUserId, (tx) =>
        revokePortalAccess(tx, org.organisationId, org.adminUserId, {
          portalLinkId: link!.id, reason: 'Resident moved out',
        }),
      );
      const seen = await as(residentUser, (tx) =>
        tx`select id from leases where id = ${leaseId}::uuid`,
      );
      expect(seen).toHaveLength(0);
    });
  });
});
