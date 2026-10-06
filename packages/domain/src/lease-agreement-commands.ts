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
import { invalid, notFound } from './errors';
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
      updated_by)
    values (
      ${organisationId}, ${d.legalName ?? null}, ${d.tradingName ?? null},
      ${d.registrationNumber ?? null}, ${d.vatNumber ?? null},
      ${cipher}, ${id ? lastFour(id) : null},
      ${d.physicalAddress ?? null}, ${d.postalAddress ?? null},
      ${d.phone ?? null}, ${d.email || null}, ${d.nextOfKinName ?? null},
      ${d.nextOfKinPhone ?? null}, ${d.agentName ?? null}, ${d.agentContact ?? null},
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
});

export async function saveLeaseAgreementTerms(
  tx: Sql, organisationId: string, actorUserId: string, input: z.input<typeof termsSchema>,
): Promise<void> {
  await requirePermission(tx, organisationId, 'lease.create');
  const d = termsSchema.parse(input);
  const n = (v: number | undefined) => (v === undefined ? null : v);

  await tx`
    insert into lease_agreement_terms (
      lease_id, organisation_id, parking_bays, max_occupants, permanent_vehicles,
      smoking_allowed, pets_allowed, pets_detail, admin_fee_minor, credit_check_fee_minor,
      inspection_fee_minor, arrear_interest_monthly_percent, arrear_interest_annual_cap_percent,
      renewal_option_months, renewal_notice_months, cancellation_penalty_months,
      sales_commission_percent, payment_method, place_of_payment, jurisdiction_court,
      key_return_at, surcharge_detail, special_conditions, updated_by)
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
      ${d.specialConditions ?? null}, ${actorUserId})
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
  render: (body: string, missing: string[], reference: string) => Uint8Array,
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
  const rendered = renderTemplate(version.body, context.values);
  const pdf = render(rendered.text, rendered.missing, context.leaseReference);

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
             missingFields: string[]; generatedAt: string }[]> {
  const rows = await tx<Record<string, unknown>[]>`
    select g.id, g.document_id, t.name as template_name, v.version,
           g.missing_fields, g.generated_at::text as generated_at
      from lease_agreement_generations g
      join lease_template_versions v on v.id = g.template_version_id
      join lease_templates t on t.id = v.template_id
     where g.lease_id = ${leaseId} and g.organisation_id = ${organisationId}
     order by g.generated_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string, documentId: r.document_id as string,
    templateName: r.template_name as string, version: Number(r.version),
    missingFields: (r.missing_fields as string[]) ?? [],
    generatedAt: r.generated_at as string,
  }));
}
