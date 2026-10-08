/**
 * Commands for lease agreement templates and for generating an agreement.
 *
 * Every mutation here runs under the caller's RLS context and checks its own
 * permission, so a command cannot be reached by a role the policies would
 * refuse. Generating opens sealed identity and bank numbers, which is why it
 * carries its own permission and writes an audit event naming the lease.
 */
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { lastFour, sealField } from '@propertyos/integrations';
import { recordAudit } from './audit';
import { DomainError, invalid, notFound } from './errors';
import { requirePermission } from './permissions';
import { buildMergeContext, renderTemplate, templatePlaceholders } from './lease-agreements';

export interface LeaseTemplateSummary {
  id: string;
  name: string;
  layout: 'schedule' | 'inline';
  status: 'draft' | 'published' | 'archived';
  sourceNote: string | null;
  latestVersion: number | null;
  publishedVersion: number | null;
  updatedAt: string;
}

export async function listLeaseTemplates(tx: Sql, organisationId: string): Promise<LeaseTemplateSummary[]> {
  const rows = await tx<Record<string, string | null>[]>`
    select t.id, t.name, t.layout::text as layout, t.status::text as status, t.source_note,
           t.updated_at::text as updated_at,
           (select max(v.version)::text from lease_template_versions v where v.template_id = t.id) as latest_version,
           (select max(v.version)::text from lease_template_versions v
             where v.template_id = t.id and v.published_at is not null) as published_version
      from lease_templates t
     where t.organisation_id = ${organisationId} and t.status <> 'archived'
     order by t.name
  `;
  return rows.map((r) => ({
    id: r.id!, name: r.name!, layout: r.layout as 'schedule' | 'inline',
    status: r.status as 'draft' | 'published' | 'archived',
    sourceNote: r.source_note ?? null,
    latestVersion: r.latest_version ? Number(r.latest_version) : null,
    publishedVersion: r.published_version ? Number(r.published_version) : null,
    updatedAt: r.updated_at!,
  }));
}

export interface LeaseTemplateDetail extends LeaseTemplateSummary {
  draftVersionId: string | null;
  body: string;
  placeholders: string[];
}

export async function getLeaseTemplate(
  tx: Sql, organisationId: string, templateId: string,
): Promise<LeaseTemplateDetail> {
  const [summary] = await listLeaseTemplates(tx, organisationId).then((all) =>
    all.filter((t) => t.id === templateId),
  );
  if (!summary) throw notFound('That lease template does not exist.');

  // The draft is the newest unpublished version; otherwise show the newest
  // published one, read-only, as the starting point for the next version.
  const [version] = await tx<{ id: string; body: string; published_at: string | null }[]>`
    select id, body, published_at::text as published_at
      from lease_template_versions
     where template_id = ${templateId} and organisation_id = ${organisationId}
     order by version desc
     limit 1
  `;
  const body = version?.body ?? '';
  return {
    ...summary,
    draftVersionId: version && !version.published_at ? version.id : null,
    body,
    placeholders: templatePlaceholders(body),
  };
}

const createSchema = z.object({
  name: z.string().trim().min(3).max(120),
  layout: z.enum(['schedule', 'inline']),
  sourceNote: z.string().trim().max(500).optional(),
});

export async function createLeaseTemplate(
  tx: Sql, organisationId: string, actorUserId: string, input: z.input<typeof createSchema>,
): Promise<{ templateId: string }> {
  await requirePermission(tx, organisationId, 'lease.template.manage');
  const d = createSchema.parse(input);
  const [row] = await tx<{ id: string }[]>`
    insert into lease_templates (organisation_id, name, layout, source_note, created_by)
    values (${organisationId}, ${d.name}, ${d.layout}::app.lease_template_layout,
            ${d.sourceNote ?? null}, ${actorUserId})
    returning id
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'lease_template.created', resourceType: 'lease_template', resourceId: row!.id,
    after: { name: d.name, layout: d.layout },
  });
  return { templateId: row!.id };
}

/**
 * Saves the working draft.
 *
 * A published version is immutable — the database refuses to change one — so
 * editing after publication opens the next version number instead.
 */
export async function saveLeaseTemplateDraft(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { templateId: string; body: string },
): Promise<{ versionId: string; version: number }> {
  await requirePermission(tx, organisationId, 'lease.template.manage');
  const body = String(input.body ?? '');
  if (body.trim().length < 20) {
    throw invalid('A lease template needs more than a line of text before it can be saved.');
  }

  const [existing] = await tx<{ id: string; version: number; published_at: string | null }[]>`
    select id, version, published_at::text as published_at
      from lease_template_versions
     where template_id = ${input.templateId} and organisation_id = ${organisationId}
     order by version desc limit 1
  `;

  if (existing && !existing.published_at) {
    await tx`
      update lease_template_versions set body = ${body}
       where id = ${existing.id} and organisation_id = ${organisationId}
    `;
    return { versionId: existing.id, version: existing.version };
  }

  const nextVersion = (existing?.version ?? 0) + 1;
  const [row] = await tx<{ id: string }[]>`
    insert into lease_template_versions
      (organisation_id, template_id, version, body, created_by)
    values (${organisationId}, ${input.templateId}, ${nextVersion}, ${body}, ${actorUserId})
    returning id
  `;
  return { versionId: row!.id, version: nextVersion };
}

export async function publishLeaseTemplateVersion(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { templateId: string; versionId: string },
): Promise<{ version: number }> {
  await requirePermission(tx, organisationId, 'lease.template.manage');
  const [row] = await tx<{ version: number }[]>`
    update lease_template_versions
       set published_at = now(), published_by = ${actorUserId}
     where id = ${input.versionId} and organisation_id = ${organisationId}
       and template_id = ${input.templateId} and published_at is null
    returning version
  `;
  if (!row) throw invalid('That version does not exist, or it is already published.');
  await tx`
    update lease_templates set status = 'published', updated_at = now()
     where id = ${input.templateId} and organisation_id = ${organisationId}
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'lease_template.published', resourceType: 'lease_template',
    resourceId: input.templateId, after: { version: row.version },
  });
  return { version: row.version };
}

/* ------------------------------------------------- landlord particulars */

const profileSchema = z.object({
  legalName: z.string().trim().max(200).optional(),
  tradingName: z.string().trim().max(200).optional(),
  registrationNumber: z.string().trim().max(60).optional(),
  vatNumber: z.string().trim().max(40).optional(),
  identityNumber: z.string().trim().max(40).optional(),
  physicalAddress: z.string().trim().max(400).optional(),
  postalAddress: z.string().trim().max(400).optional(),
  phone: z.string().trim().max(60).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  nextOfKinName: z.string().trim().max(200).optional(),
  nextOfKinPhone: z.string().trim().max(60).optional(),
  agentName: z.string().trim().max(200).optional(),
  agentContact: z.string().trim().max(200).optional(),
  agentRegistrationNumber: z.string().trim().max(60).optional(),
  agentPractitioner: z.string().trim().max(160).optional(),
  agentCertificateNumber: z.string().trim().max(60).optional(),
});

export async function saveOrganisationProfile(
  tx: Sql, organisationId: string, actorUserId: string, input: z.input<typeof profileSchema>,
): Promise<void> {
  await requirePermission(tx, organisationId, 'organisation.settings.manage');
  const d = profileSchema.parse(input);

  // An identity number is sealed before it reaches the database, and bound to
  // this organisation so the sealed value cannot be moved to another row.
  const id = d.identityNumber?.replace(/\s/g, '') ?? '';
  const cipher = id ? sealField(id, `organisation:${organisationId}`) : null;

  await tx`
    insert into organisation_profiles (
      organisation_id, legal_name, trading_name, registration_number, vat_number,
      identity_number_cipher, identity_number_last4, physical_address, postal_address,
      phone, email, next_of_kin_name, next_of_kin_phone, agent_name, agent_contact,
      agent_registration_number, agent_practitioner, agent_certificate_number,
      updated_by)
    values (
      ${organisationId}, ${d.legalName ?? null}, ${d.tradingName ?? null},
      ${d.registrationNumber ?? null}, ${d.vatNumber ?? null},
      ${cipher}, ${id ? lastFour(id) : null},
      ${d.physicalAddress ?? null}, ${d.postalAddress ?? null},
      ${d.phone ?? null}, ${d.email || null}, ${d.nextOfKinName ?? null},
      ${d.nextOfKinPhone ?? null}, ${d.agentName ?? null}, ${d.agentContact ?? null},
      ${d.agentRegistrationNumber ?? null}, ${d.agentPractitioner ?? null},
      ${d.agentCertificateNumber ?? null},
      ${actorUserId})
    on conflict (organisation_id) do update set
      legal_name = excluded.legal_name, trading_name = excluded.trading_name,
      registration_number = excluded.registration_number, vat_number = excluded.vat_number,
      -- An empty identity field leaves the stored one alone rather than erasing
      -- it, because the form never shows the full value back.
      identity_number_cipher = coalesce(excluded.identity_number_cipher, organisation_profiles.identity_number_cipher),
      identity_number_last4 = coalesce(excluded.identity_number_last4, organisation_profiles.identity_number_last4),
      physical_address = excluded.physical_address, postal_address = excluded.postal_address,
      phone = excluded.phone, email = excluded.email,
      next_of_kin_name = excluded.next_of_kin_name, next_of_kin_phone = excluded.next_of_kin_phone,
      agent_name = excluded.agent_name, agent_contact = excluded.agent_contact,
      agent_registration_number = excluded.agent_registration_number,
      agent_practitioner = excluded.agent_practitioner,
      agent_certificate_number = excluded.agent_certificate_number,
      updated_at = now(), updated_by = excluded.updated_by
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'organisation_profile.updated', resourceType: 'organisation',
    resourceId: organisationId, after: { identityNumberChanged: Boolean(cipher) },
  });
}

/** Stores a resident's full identity number, sealed. */
export async function setResidentIdentityNumber(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { residentId: string; identityNumber: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'resident.manage');
  const value = input.identityNumber.replace(/\s/g, '');
  if (value.length < 6) throw invalid('That identity number is too short.');
  const [row] = await tx<{ id: string }[]>`
    update resident_profiles
       set identity_number_cipher = ${sealField(value, `resident:${input.residentId}`)},
           identity_number_last4 = ${lastFour(value)},
           updated_at = now()
     where id = ${input.residentId} and organisation_id = ${organisationId}
    returning id
  `;
  if (!row) throw notFound('That resident does not exist.');
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'resident.identity_number.set', resourceType: 'resident',
    resourceId: input.residentId, after: { last4: lastFour(value) },
  });
}

/* ------------------------------------------------------ agreement terms */

const termsSchema = z.object({
  leaseId: z.string().uuid(),
  parkingBays: z.string().trim().max(120).optional(),
  maxOccupants: z.coerce.number().int().min(0).max(50).optional(),
  permanentVehicles: z.coerce.number().int().min(0).max(50).optional(),
  smokingAllowed: z.boolean().optional(),
  petsAllowed: z.boolean().optional(),
  petsDetail: z.string().trim().max(300).optional(),
  adminFeeMinor: z.coerce.number().int().min(0).optional(),
  creditCheckFeeMinor: z.coerce.number().int().min(0).optional(),
  inspectionFeeMinor: z.coerce.number().int().min(0).optional(),
  arrearInterestMonthlyPercent: z.coerce.number().min(0).max(100).optional(),
  arrearInterestAnnualCapPercent: z.coerce.number().min(0).max(100).optional(),
  renewalOptionMonths: z.coerce.number().int().min(0).max(240).optional(),
  renewalNoticeMonths: z.coerce.number().int().min(0).max(24).optional(),
  cancellationPenaltyMonths: z.coerce.number().min(0).max(24).optional(),
  salesCommissionPercent: z.coerce.number().min(0).max(100).optional(),
  paymentMethod: z.enum(['debit_order', 'bank_deposit', 'eft', 'other']).optional(),
  placeOfPayment: z.string().trim().max(300).optional(),
  jurisdictionCourt: z.string().trim().max(120).optional(),
  keyReturnAt: z.string().trim().optional(),
  surchargeDetail: z.string().trim().max(300).optional(),
  specialConditions: z.string().trim().max(4000).optional(),

  // Added for the master lease, which asks for each of these by name.
  depositRefundDays: z.coerce.number().int().min(0).max(365).optional(),
  defectsNoticeDays: z.coerce.number().int().min(0).max(365).optional(),
  maintenanceCalloutFeeMinor: z.coerce.number().int().min(0).optional(),
  earlyCancellationCapMinor: z.coerce.number().int().min(0).optional(),
  namedOccupants: z.string().trim().max(2000).optional(),
  // 1 and up: a threshold of nought would make every tenancy breachable on day
  // one, and leaving it empty is how a landlord says the clause does not apply.
  complaintsThreshold: z.coerce.number().int().min(1).max(50).optional(),
  paymentReference: z.string().trim().max(80).optional(),
  refundAccountHolder: z.string().trim().max(160).optional(),
  refundBankName: z.string().trim().max(120).optional(),
  // Matches the column's own check, so a bad branch code is refused with a
  // readable message rather than a constraint violation.
  refundBranchCode: z.string().trim().regex(/^[0-9]{4,10}$/, 'A branch code is 4 to 10 digits.').optional(),
  refundAccountNumber: z.string().trim().regex(/^[0-9 -]{4,34}$/, 'An account number is digits, spaces or dashes.').optional(),
});

export async function saveLeaseAgreementTerms(
  tx: Sql, organisationId: string, actorUserId: string, input: z.input<typeof termsSchema>,
): Promise<void> {
  await requirePermission(tx, organisationId, 'lease.create');
  const d = termsSchema.parse(input);
  const n = (v: number | undefined) => (v === undefined ? null : v);

  // The deposit refund account belongs to the TENANT. It is sealed on the way
  // in, exactly like the landlord's account number, and only the last four
  // digits stay readable — enough to identify the account on the agreement,
  // not enough to pay anyone from it.
  const refundDigits = d.refundAccountNumber?.replace(/[^0-9]/g, '') ?? '';
  const refundCipher = refundDigits.length >= 4
    ? sealField(refundDigits, `lease_refund_account:${d.leaseId}`)
    : null;
  const refundLast4 = refundCipher ? lastFour(refundDigits) : null;

  await tx`
    insert into lease_agreement_terms (
      lease_id, organisation_id, parking_bays, max_occupants, permanent_vehicles,
      smoking_allowed, pets_allowed, pets_detail, admin_fee_minor, credit_check_fee_minor,
      inspection_fee_minor, arrear_interest_monthly_percent, arrear_interest_annual_cap_percent,
      renewal_option_months, renewal_notice_months, cancellation_penalty_months,
      sales_commission_percent, payment_method, place_of_payment, jurisdiction_court,
      key_return_at, surcharge_detail, special_conditions,
      deposit_refund_days, defects_notice_days, maintenance_callout_fee_minor,
      early_cancellation_cap_minor, named_occupants, payment_reference, complaints_threshold,
      refund_account_holder, refund_bank_name, refund_branch_code,
      refund_account_number_cipher, refund_account_number_last4, updated_by)
    values (
      ${d.leaseId}, ${organisationId}, ${d.parkingBays ?? null}, ${n(d.maxOccupants)},
      ${n(d.permanentVehicles)}, ${d.smokingAllowed ?? null}, ${d.petsAllowed ?? null},
      ${d.petsDetail ?? null}, ${n(d.adminFeeMinor)}, ${n(d.creditCheckFeeMinor)},
      ${n(d.inspectionFeeMinor)}, ${n(d.arrearInterestMonthlyPercent)},
      ${n(d.arrearInterestAnnualCapPercent)}, ${n(d.renewalOptionMonths)},
      ${n(d.renewalNoticeMonths)}, ${n(d.cancellationPenaltyMonths)},
      ${n(d.salesCommissionPercent)},
      ${d.paymentMethod ? tx`${d.paymentMethod}::app.lease_payment_method` : null},
      ${d.placeOfPayment ?? null}, ${d.jurisdictionCourt ?? null},
      ${d.keyReturnAt || null}, ${d.surchargeDetail ?? null},
      ${d.specialConditions ?? null},
      ${n(d.depositRefundDays)}, ${n(d.defectsNoticeDays)},
      ${n(d.maintenanceCalloutFeeMinor)}, ${n(d.earlyCancellationCapMinor)},
      ${d.namedOccupants ?? null}, ${d.paymentReference ?? null},
      ${n(d.complaintsThreshold)},
      ${d.refundAccountHolder ?? null}, ${d.refundBankName ?? null},
      ${d.refundBranchCode ?? null}, ${refundCipher}, ${refundLast4}, ${actorUserId})
    on conflict (lease_id) do update set
      parking_bays = excluded.parking_bays, max_occupants = excluded.max_occupants,
      permanent_vehicles = excluded.permanent_vehicles,
      smoking_allowed = excluded.smoking_allowed, pets_allowed = excluded.pets_allowed,
      pets_detail = excluded.pets_detail, admin_fee_minor = excluded.admin_fee_minor,
      credit_check_fee_minor = excluded.credit_check_fee_minor,
      inspection_fee_minor = excluded.inspection_fee_minor,
      arrear_interest_monthly_percent = excluded.arrear_interest_monthly_percent,
      arrear_interest_annual_cap_percent = excluded.arrear_interest_annual_cap_percent,
      renewal_option_months = excluded.renewal_option_months,
      renewal_notice_months = excluded.renewal_notice_months,
      cancellation_penalty_months = excluded.cancellation_penalty_months,
      sales_commission_percent = excluded.sales_commission_percent,
      payment_method = excluded.payment_method, place_of_payment = excluded.place_of_payment,
      jurisdiction_court = excluded.jurisdiction_court, key_return_at = excluded.key_return_at,
      surcharge_detail = excluded.surcharge_detail,
      special_conditions = excluded.special_conditions,
      deposit_refund_days = excluded.deposit_refund_days,
      defects_notice_days = excluded.defects_notice_days,
      maintenance_callout_fee_minor = excluded.maintenance_callout_fee_minor,
      early_cancellation_cap_minor = excluded.early_cancellation_cap_minor,
      named_occupants = excluded.named_occupants,
      payment_reference = excluded.payment_reference,
      complaints_threshold = excluded.complaints_threshold,
      refund_account_holder = excluded.refund_account_holder,
      refund_bank_name = excluded.refund_bank_name,
      refund_branch_code = excluded.refund_branch_code,
      -- An account number left blank on the form leaves the stored one alone.
      -- Clearing it is a deliberate act, not a side effect of saving the page
      -- with the field empty because the browser never showed it.
      refund_account_number_cipher =
        coalesce(excluded.refund_account_number_cipher, lease_agreement_terms.refund_account_number_cipher),
      refund_account_number_last4 =
        coalesce(excluded.refund_account_number_last4, lease_agreement_terms.refund_account_number_last4),
      updated_at = now(), updated_by = excluded.updated_by
  `;
}

export interface GeneratedAgreement {
  generationId: string;
  documentId: string;
  missingFields: string[];
  unknownFields: string[];
  /** The rendered bytes, handed straight to the caller to stream or store. */
  pdf: Uint8Array;
  filename: string;
}

/**
 * Renders an agreement for a lease from a published template version.
 *
 * Only PUBLISHED versions may be used. Generating from a draft would produce a
 * document nobody can reproduce later, which is the opposite of what a signed
 * agreement needs.
 */
export async function generateLeaseAgreement(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { leaseId: string; templateId: string },
  render: (
    body: string,
    missing: string[],
    reference: string,
    summary: { label: string; value: string }[],
  ) => Uint8Array,
  registerPdf: (
    bytes: Uint8Array,
    filename: string,
    title: string,
    supersedesDocumentId: string | undefined,
  ) => Promise<{ documentId: string }>,
): Promise<GeneratedAgreement> {
  await requirePermission(tx, organisationId, 'lease.agreement.generate');

  const [version] = await tx<{ id: string; version: number; body: string; name: string }[]>`
    select v.id, v.version, v.body, t.name
      from lease_template_versions v
      join lease_templates t
        on t.id = v.template_id and t.organisation_id = v.organisation_id
     where v.template_id = ${input.templateId}
       and v.organisation_id = ${organisationId}
       and v.published_at is not null
     order by v.version desc
     limit 1
  `;
  if (!version) {
    throw invalid(
      'That template has no published version. Publish one before generating an agreement from it.',
    );
  }

  const context = await buildMergeContext(tx, organisationId, input.leaseId);
  // Marked for the PDF, which sets each merged value in bold; stripped for
  // everything that keeps or shows the text, so a control character never
  // reaches a record, a screen or a search.
  const rendered = renderTemplate(version.body, context.values, { markValues: true });
  const pdf = render(
    rendered.text, rendered.missing, context.leaseReference, scheduleRows(context.values),
  );

  // Which agreement this one replaces, if any.
  //
  // Regenerating used to leave identical rows side by side — same name, same
  // size, same day — with nothing to say which was current or which the parties
  // actually signed. Each generation now points at the one before it, so the
  // document list reads as a history.
  const [previous] = await tx<{ document_id: string }[]>`
    select document_id
      from lease_agreement_generations
     where lease_id = ${input.leaseId} and organisation_id = ${organisationId}
     order by generated_at desc
     limit 1
  `;

  // The ordinal makes each generation distinguishable. The template version
  // alone does not: two agreements from the same version are otherwise
  // identical in name forever.
  const [counted] = await tx<{ count: string }[]>`
    select count(*)::text as count
      from lease_agreement_generations
     where lease_id = ${input.leaseId} and organisation_id = ${organisationId}
  `;
  const ordinal = Number(counted?.count ?? '0') + 1;

  const filename =
    `lease-agreement-${context.leaseReference}-v${version.version}-${String(ordinal).padStart(2, '0')}.pdf`;
  // Separated with middle dots, not dashes: a template is free to have a dash in
  // its own name ("Residential lease — natural person"), and three em-dashes in
  // one line stop telling the reader where one part ends.
  const title =
    `Lease agreement ${context.leaseReference} · issue ${ordinal} · ` +
    `${version.name} v${version.version}`;
  const { documentId } = await registerPdf(pdf, filename, title, previous?.document_id);

  const [generation] = await tx<{ id: string }[]>`
    insert into lease_agreement_generations (
      organisation_id, lease_id, template_version_id, document_id,
      field_values, missing_fields, generated_by)
    values (
      ${organisationId}, ${input.leaseId}, ${version.id}, ${documentId},
      ${tx.json(context.redacted as never)}, ${rendered.missing}, ${actorUserId})
    returning id
  `;

  // Named explicitly because generating opened sealed identity and bank numbers.
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'lease_agreement.generated', resourceType: 'lease', resourceId: input.leaseId,
    after: {
      template: version.name, templateVersion: version.version,
      documentId, missingFields: rendered.missing,
      sealedFieldsOpened: ['identity numbers', 'bank account number'],
    },
  });

  return {
    generationId: generation!.id, documentId,
    missingFields: rendered.missing, unknownFields: rendered.unknown,
    pdf, filename,
  };
}

export async function listLeaseAgreementGenerations(
  tx: Sql, organisationId: string, leaseId: string,
): Promise<{ id: string; documentId: string; templateName: string; version: number;
             missingFields: string[]; generatedAt: string; issue: number;
             visibility: string; superseded: boolean }[]> {
  const rows = await tx<Record<string, unknown>[]>`
    select g.id, g.document_id, t.name as template_name, v.version,
           g.missing_fields, g.generated_at::text as generated_at,
           d.visibility::text as visibility,
           -- Whether a later generation replaced this one, so the panel can show
           -- which agreement is the current one.
           exists (
             select 1 from lease_agreement_generations newer
              where newer.lease_id = g.lease_id and newer.generated_at > g.generated_at
           ) as superseded,
           row_number() over (order by g.generated_at) as issue
      from lease_agreement_generations g
      join lease_template_versions v on v.id = g.template_version_id
      join lease_templates t on t.id = v.template_id
      join documents d on d.id = g.document_id
     where g.lease_id = ${leaseId} and g.organisation_id = ${organisationId}
     order by g.generated_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string, documentId: r.document_id as string,
    templateName: r.template_name as string, version: Number(r.version),
    missingFields: (r.missing_fields as string[]) ?? [],
    generatedAt: r.generated_at as string,
    issue: Number(r.issue),
    visibility: r.visibility as string,
    superseded: Boolean(r.superseded),
  }));
}

/** A template Spike publishes for every customer to start from. */
export interface SystemTemplateSummary {
  id: string;
  name: string;
  provenance: string;
  summary: string;
  version: number;
  /** True once this organisation already has a copy, so it is not offered twice. */
  alreadyCopied: boolean;
}

/**
 * The published templates Spike provides.
 *
 * Read-only from a customer's side. RLS exposes only published rows, so a draft
 * Spike is still writing is not visible here.
 */
export async function listSystemTemplates(
  tx: Sql,
  organisationId: string,
): Promise<SystemTemplateSummary[]> {
  await requirePermission(tx, organisationId, 'lease.template.manage');
  const rows = await tx<
    { id: string; name: string; provenance: string; summary: string;
      version: number; already: boolean }[]
  >`
    select t.id, t.name, t.provenance, t.summary, v.version,
           exists (
             select 1 from lease_templates lt
             where lt.organisation_id = ${organisationId}::uuid
               and lt.source_note = 'Spike template: ' || t.name
           ) as already
    from system_lease_templates t
    join lateral (
      select version from system_lease_template_versions
      where template_id = t.id and published_at is not null
      order by version desc limit 1
    ) v on true
    where t.status = 'published'
    order by t.name
  `;
  return rows.map((r) => ({
    id: r.id, name: r.name, provenance: r.provenance, summary: r.summary,
    version: r.version, alreadyCopied: r.already,
  }));
}

/**
 * Copies a Spike template into this organisation's own templates.
 *
 * The copy is theirs from that moment: their draft, their edits, their
 * publication. Nothing generates an agreement from a system template directly,
 * so a later change by Spike never silently alters wording a landlord has
 * already adopted — which on a signed lease would be indefensible.
 */
export async function adoptSystemTemplate(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { systemTemplateId: string },
): Promise<{ templateId: string; name: string }> {
  await requirePermission(tx, organisationId, 'lease.template.manage');

  const [source] = await tx<
    { name: string; layout: string; body: string; version: number }[]
  >`
    select t.name, t.layout::text, v.body, v.version
    from system_lease_templates t
    join lateral (
      select body, version from system_lease_template_versions
      where template_id = t.id and published_at is not null
      order by version desc limit 1
    ) v on true
    where t.id = ${params.systemTemplateId}::uuid and t.status = 'published'
  `;
  if (!source) throw notFound('Template');

  // A template name is unique within an organisation, and taking a second copy
  // is a legitimate thing to do: the first copy has your edits on it, and the
  // newest Spike version is something you want to read alongside them rather
  // than instead of them. Copying under the same name used to hit the unique
  // constraint and surface as "something went wrong", with no hint that the
  // name was the problem.
  const name = await freeTemplateName(tx, organisationId, source.name);

  const [template] = await tx<{ id: string }[]>`
    insert into lease_templates (organisation_id, name, layout, source_note, status, created_by)
    values (
      ${organisationId}, ${name}, ${source.layout}::app.lease_template_layout,
      ${`Spike template: ${source.name}`}, 'draft', ${actorUserId}
    )
    returning id
  `;
  if (!template) throw new DomainError('internal', 'Template copy returned no row.');

  await tx`
    insert into lease_template_versions
      (organisation_id, template_id, version, body, created_by)
    values (${organisationId}, ${template.id}, 1, ${source.body}, ${actorUserId})
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'lease.template.adopted', resourceType: 'lease_template', resourceId: template.id,
    after: { name, fromSystemVersion: source.version },
  });

  return { templateId: template.id, name };
}

/**
 * A name for this copy that is not already taken in the organisation.
 *
 * "Residential lease — South Africa", then "… (copy 2)", "… (copy 3)". Numbered
 * from the names actually present rather than from a count, so deleting copy 2
 * and copying again gives copy 2 back instead of leaving a hole.
 */
async function freeTemplateName(tx: Sql, organisationId: string, base: string): Promise<string> {
  const rows = await tx<{ name: string }[]>`
    select name from lease_templates
     where organisation_id = ${organisationId}::uuid
       and (name = ${base} or name like ${`${base} (copy %)`})
  `;
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(base)) return base;
  // The ceiling is a guard, not a limit anyone should reach: a hundred copies of
  // one template is a mistake, and failing loudly beats looping forever.
  for (let n = 2; n <= 100; n += 1) {
    const candidate = `${base} (copy ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  throw invalid(
    `There are already 100 copies of "${base}". Delete some before taking another.`,
  );
}

/** What an agreement would say, without creating anything. */
export interface AgreementPreview {
  leaseReference: string;
  templateName: string;
  version: number;
  text: string;
  /** Fields the template asks for that this lease cannot supply yet. */
  missing: string[];
  /** Placeholders that are not fields at all, usually a typo in the wording. */
  unknown: string[];
  /**
   * The field values as they are STORED on a generation: sensitive ones masked.
   * The rendered text above shows the real values, because that is the document
   * the parties sign; this is what the record of it keeps.
   */
  redacted: Record<string, string>;
}

/**
 * Renders the agreement without writing a thing.
 *
 * No document, no generation row, no audit of a disclosure — because nothing is
 * disclosed to anyone but the operator already entitled to see it. It carries
 * the same permission as generating, since it opens the same sealed identity
 * and bank numbers to build the text.
 *
 * This is what makes "check before you send" possible. A lease with a missing
 * field should be fixed before a resident ever receives it, not after.
 */
export async function previewLeaseAgreement(
  tx: Sql,
  organisationId: string,
  input: { leaseId: string; templateId: string },
): Promise<AgreementPreview> {
  await requirePermission(tx, organisationId, 'lease.agreement.generate');

  const [version] = await tx<{ version: number; body: string; name: string }[]>`
    select v.version, v.body, t.name
      from lease_template_versions v
      join lease_templates t
        on t.id = v.template_id and t.organisation_id = v.organisation_id
     where v.template_id = ${input.templateId}
       and v.organisation_id = ${organisationId}
       and v.published_at is not null
     order by v.version desc
     limit 1
  `;
  if (!version) throw invalid('That template has no published version to preview.');

  const context = await buildMergeContext(tx, organisationId, input.leaseId);
  const rendered = renderTemplate(version.body, context.values);

  return {
    leaseReference: context.leaseReference,
    templateName: version.name,
    version: version.version,
    text: rendered.text,
    missing: rendered.missing,
    unknown: rendered.unknown,
    redacted: context.redacted,
  };
}

/**
 * The terms that go in the schedule on the first page.
 *
 * Taken from the same merged values the body is rendered from, so the schedule
 * cannot say one thing and clause 4 another. A value the lease does not have is
 * left out rather than shown blank: an empty row in a schedule reads like a term
 * that was agreed to be nothing.
 */
function scheduleRows(values: Record<string, string>): { label: string; value: string }[] {
  const rows: { label: string; key: string }[] = [
    { label: 'Landlord', key: 'landlord.name' },
    { label: 'Tenant', key: 'tenant.names' },
    { label: 'Property', key: 'property.full_address' },
    { label: 'Commencement', key: 'term.effective_date' },
    { label: 'Termination', key: 'term.termination_date' },
    { label: 'Monthly rental', key: 'money.rent' },
    { label: 'Deposit', key: 'money.deposit' },
  ];
  return rows
    .map((row) => ({ label: row.label, value: values[row.key] ?? '' }))
    .filter((row) => row.value.trim() !== '');
}
