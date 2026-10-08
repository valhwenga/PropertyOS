/**
 * An agreement with blanks in its operative terms may be drafted, not sent.
 *
 * The catalogue has marked ten fields `essential` since it was written — the
 * ones without which the document is not a usable lease — and until now nothing
 * read the flag. An agreement with no tenant name, no commencement date and no
 * rent could be generated AND shared with the resident, who would receive a PDF
 * reading "[money.rent]" where the rent belongs.
 *
 * Generating an incomplete draft stays possible on purpose: it is how an
 * operator SEES what is still missing. Sharing it is what is refused.
 *
 * This suite also covers resident editing, because the gaps are filled from the
 * resident record and the two were built together.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, createLeaseTemplate, createResident, createStandaloneHouse,
  draftLease, generateLeaseAgreement, publishLeaseTemplateVersion, registerDocument,
  saveLeaseAgreementTerms, saveLeaseTemplateDraft, saveOrganisationProfile,
  setResidentIdentityNumber, shareDocument, updateResident,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

/**
 * A template that asks for a handful of essential fields and one that is not.
 * Small on purpose: the master lease asks for 75 fields, which would make a
 * failure here hard to read.
 */
const TEMPLATE_BODY = [
  'LEASE AGREEMENT',
  '',
  'Between {{landlord.name}} (the Landlord)',
  'and {{tenant.primary_name}}, identity number {{tenant.primary_identity_number}} (the Tenant).',
  '',
  'The premises are {{property.full_address}}.',
  'The lease runs from {{term.effective_date}} to {{term.termination_date}}.',
  'The rent is {{money.rent}} per month. The deposit is {{money.deposit}}.',
  '',
  'The Landlord VAT number, where applicable, is {{landlord.vat_number}}.',
].join('\n');

describe('Agreement completeness', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let residentId: string;
  let templateId: string;

  /** Generates an agreement and registers its PDF, as the web action does. */
  async function generate(): Promise<{ documentId: string; essentialMissing: string[] }> {
    return as(org.adminUserId, async (tx) => {
      const result = await generateLeaseAgreement(
        tx, org.organisationId, org.adminUserId, { leaseId, templateId },
        // The real renderer is not the subject here; the bytes only have to be
        // bytes. What is being tested is which fields were missing.
        (body) => new TextEncoder().encode(body),
        async (bytes, filename, title, supersedes) => {
          const registered = await registerDocument(
            tx, org.organisationId, org.adminUserId,
            {
              classification: 'lease', title, filename, contentType: 'application/pdf',
              byteSize: bytes.byteLength,
              contentSha256: 'a'.repeat(64),
              leaseId, supersedesDocumentId: supersedes,
            },
            { status: 'system_generated', detail: 'Rendered by PropertyOS in a test.' },
          );
          return { documentId: registered.documentId };
        },
      );
      return { documentId: result.documentId, essentialMissing: result.essentialMissing };
    });
  }

  beforeAll(async () => {
    org = await createOrganisation('Agreement Co');

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
      }),
    );
    residentId = resident.residentId;

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Agreement House', code: 'AGR', propertyType: 'house',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: 800000n,
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );

    const template = await as(org.adminUserId, (tx) =>
      createLeaseTemplate(tx, org.organisationId, org.adminUserId, {
        name: 'Short lease', layout: 'inline',
      }),
    );
    templateId = template.templateId;
    const draft = await as(org.adminUserId, (tx) =>
      saveLeaseTemplateDraft(tx, org.organisationId, org.adminUserId, {
        templateId, body: TEMPLATE_BODY,
      }),
    );
    await as(org.adminUserId, (tx) =>
      publishLeaseTemplateVersion(tx, org.organisationId, org.adminUserId, {
        templateId, versionId: draft.versionId,
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('names the essential field that is missing', async () => {
    // One field, not three. The landlord name falls back to the organisation's
    // own name and the deposit falls back to the lease's recorded amount, so
    // neither can be absent; the tenant's identity number has no fallback and
    // nothing has supplied it yet.
    //
    // That is the right answer and it is worth pinning: an agreement naming a
    // tenant with no identity number is precisely the document a landlord
    // cannot rely on.
    const { essentialMissing } = await generate();
    expect(essentialMissing).toEqual(['Primary tenant identity number']);
  });

  it('counts only fields the template actually asks for', async () => {
    // The template never mentions the tenant list field, so its absence is not
    // this agreement's problem. An incomplete-document warning that lists
    // fields the document does not contain is noise, and noise gets ignored.
    const { essentialMissing } = await generate();
    expect(essentialMissing).not.toContain('All tenant names');
  });

  it('does not treat a non-essential gap as a blocker', async () => {
    // The VAT number is in the template and unfilled. It is not essential, so
    // it must not stop the agreement reaching the resident.
    const { essentialMissing } = await generate();
    expect(essentialMissing).not.toContain('VAT number');
  });

  it('refuses to share an agreement that is missing essential terms', async () => {
    const { documentId } = await generate();
    await expect(
      as(org.adminUserId, (tx) =>
        shareDocument(tx, org.organisationId, org.adminUserId, {
          documentId, visibility: 'resident_shared',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('still allows it to be kept internally', async () => {
    // A draft is a legitimate thing to have. The refusal is about sending it.
    const { documentId } = await generate();
    await as(org.adminUserId, (tx) =>
      shareDocument(tx, org.organisationId, org.adminUserId, {
        documentId, visibility: 'internal',
      }),
    );
    const [doc] = await ownerSql()<{ visibility: string }[]>`
      select visibility::text from documents where id = ${documentId}
    `;
    expect(doc!.visibility).toBe('internal');
  });

  it('shares once the essential terms are filled in', async () => {
    // Filled through the command that owns it, which is the point of the
    // exercise: the operator is told what is missing and where to put it.
    await as(org.adminUserId, (tx) =>
      saveOrganisationProfile(tx, org.organisationId, org.adminUserId, {
        legalName: 'Agreement Co (Pty) Ltd',
      }),
    );
    await as(org.adminUserId, (tx) =>
      setResidentIdentityNumber(tx, org.organisationId, org.adminUserId, {
        residentId, identityNumber: '830120 5832 086',
      }),
    );
    await as(org.adminUserId, (tx) =>
      saveLeaseAgreementTerms(tx, org.organisationId, org.adminUserId, { leaseId }),
    );
    const { documentId, essentialMissing } = await generate();
    expect(essentialMissing).toEqual([]);

    await as(org.adminUserId, (tx) =>
      shareDocument(tx, org.organisationId, org.adminUserId, {
        documentId, visibility: 'resident_shared',
      }),
    );
    const [doc] = await ownerSql()<{ visibility: string }[]>`
      select visibility::text from documents where id = ${documentId}
    `;
    expect(doc!.visibility).toBe('resident_shared');
  });
});

describe('Editing a resident', () => {
  let org: OrganisationFixture;
  let residentId: string;

  beforeAll(async () => {
    org = await createOrganisation('Resident Edit Co');
    const r = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Sipho', lastName: 'Ndlovu', email: 'sipho@example.invalid',
      }),
    );
    residentId = r.residentId;
  });

  afterAll(async () => { await closeOwner(); });

  it('saves a correction and records what changed', async () => {
    await as(org.adminUserId, (tx) =>
      updateResident(tx, org.organisationId, org.adminUserId, {
        residentId, firstName: 'Sipho', lastName: 'Ndlovu-Khumalo',
        email: 'sipho.nk@example.invalid', phone: '082 000 0000',
        communicationPreference: 'in_app', status: 'active',
      }),
    );
    const [row] = await ownerSql()<{ last_name: string; communication_preference: string }[]>`
      select last_name, communication_preference from resident_profiles where id = ${residentId}
    `;
    expect(row!.last_name).toBe('Ndlovu-Khumalo');
    expect(row!.communication_preference).toBe('in_app');

    const [audit] = await ownerSql()<{ action: string; before_state: Record<string, unknown> }[]>`
      select action, before_state from audit_events
       where resource_id = ${residentId} and action = 'resident.updated'
       order by occurred_at desc limit 1
    `;
    expect(audit!.before_state.lastName).toBe('Ndlovu');
  });

  it('never writes an identity number to the audit trail', async () => {
    await as(org.adminUserId, (tx) =>
      setResidentIdentityNumber(tx, org.organisationId, org.adminUserId, {
        residentId, identityNumber: '9001015800085',
      }),
    );
    const rows = await ownerSql()<Record<string, unknown>[]>`
      select * from audit_events where resource_id = ${residentId}
    `;
    expect(JSON.stringify(rows)).not.toContain('9001015800085');
    // The last four digits are deliberately there: they are how an operator
    // confirms which number was stored without the number being stored twice.
    expect(JSON.stringify(rows)).toContain('0085');
  });

  it('archives rather than deletes', async () => {
    await as(org.adminUserId, (tx) =>
      updateResident(tx, org.organisationId, org.adminUserId, {
        residentId, firstName: 'Sipho', lastName: 'Ndlovu-Khumalo',
        communicationPreference: 'none', status: 'archived',
      }),
    );
    const [row] = await ownerSql()<{ status: string }[]>`
      select status::text from resident_profiles where id = ${residentId}
    `;
    expect(row!.status).toBe('archived');
  });

  it('refuses an edit from another organisation holding a valid id', async () => {
    const other = await createOrganisation('Elsewhere Co');
    await expect(
      as(other.adminUserId, (tx) =>
        updateResident(tx, other.organisationId, other.adminUserId, {
          residentId, firstName: 'Taken', lastName: 'Over',
          communicationPreference: 'email',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
