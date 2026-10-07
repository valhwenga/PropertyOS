/**
 * Rental applications captured from a link you can share anywhere.
 *
 * The applicant has no account. Their only credential is the token in the URL,
 * so the submission goes through app.submit_rental_application, which checks
 * the token itself. Nothing here lets an anonymous caller read anything back:
 * a link that could read would turn a shared URL into a disclosure of everyone
 * else who applied.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { invalid, notFound } from './errors';
import { requirePermission } from './permissions';

export interface ApplicationLink {
  id: string;
  token: string;
  label: string;
  unitLabel: string | null;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
  received: number;
}

export interface RentalApplication {
  id: string;
  reference: string;
  status: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  currentAddress: string | null;
  employment: string | null;
  monthlyIncomeMinor: string | null;
  occupants: number | null;
  moveInDate: string | null;
  message: string | null;
  submittedAt: string;
  linkLabel: string;
  reviewNote: string | null;
}

export async function listApplicationLinks(
  tx: Sql, organisationId: string,
): Promise<ApplicationLink[]> {
  await requirePermission(tx, organisationId, 'lease.create');
  const rows = await tx<
    { id: string; token: string; label: string; unit_label: string | null; active: boolean;
      expires_at: string | null; created_at: string; received: string }[]
  >`
    select al.id, al.token, al.label, al.active,
           al.expires_at::text, al.created_at::text,
           case when u.id is null then null else p.name || ' / ' || u.code end as unit_label,
           (select count(*) from rental_applications ra where ra.link_id = al.id)::text as received
      from application_links al
      left join units u on u.id = al.unit_id
      left join properties p on p.id = u.property_id
     where al.organisation_id = ${organisationId}::uuid
     order by al.created_at desc
  `;
  return rows.map((r) => ({
    id: r.id, token: r.token, label: r.label, unitLabel: r.unit_label,
    active: r.active, expiresAt: r.expires_at, createdAt: r.created_at,
    received: Number(r.received),
  }));
}

export async function createApplicationLink(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { label: string; unitId?: string | null },
): Promise<{ id: string; token: string }> {
  await requirePermission(tx, organisationId, 'lease.create');
  const label = z.string().trim().min(1).max(120).parse(input.label);

  // 32 bytes of randomness, base64url. The token is the only credential a
  // stranger needs, so it is generated the way a credential should be and never
  // derived from anything guessable such as the label or the unit.
  const token = randomBytes(32).toString('base64url');

  const [row] = await tx<{ id: string }[]>`
    insert into application_links (organisation_id, token, label, unit_id, created_by)
    values (${organisationId}, ${token}, ${label}, ${input.unitId ?? null}, ${actorUserId})
    returning id
  `;
  if (!row) throw invalid('Could not create that link.');

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'application_link.created', resourceType: 'application_link', resourceId: row.id,
    after: { label },
  });
  return { id: row.id, token };
}

/** Revoking is immediate: the function that accepts submissions checks `active`. */
export async function setApplicationLinkActive(
  tx: Sql, organisationId: string, actorUserId: string,
  params: { linkId: string; active: boolean },
): Promise<void> {
  await requirePermission(tx, organisationId, 'lease.create');
  const rows = await tx`
    update application_links set active = ${params.active}
     where id = ${params.linkId}::uuid and organisation_id = ${organisationId}::uuid
    returning id
  `;
  if (rows.length === 0) throw notFound('Application link');
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: params.active ? 'application_link.enabled' : 'application_link.revoked',
    resourceType: 'application_link', resourceId: params.linkId,
  });
}

export async function listRentalApplications(
  tx: Sql, organisationId: string, options: { status?: string } = {},
): Promise<RentalApplication[]> {
  await requirePermission(tx, organisationId, 'lease.create');
  const rows = await tx<
    { id: string; reference: string; status: string; full_name: string; email: string | null;
      phone: string | null; current_address: string | null; employment: string | null;
      monthly_income_minor: string | null; occupants: number | null; move_in_date: string | null;
      message: string | null; submitted_at: string; link_label: string; review_note: string | null }[]
  >`
    select ra.id, ra.reference, ra.status::text, ra.full_name, ra.email, ra.phone,
           ra.current_address, ra.employment, ra.monthly_income_minor::text,
           ra.occupants, ra.move_in_date::text, ra.message, ra.submitted_at::text,
           ra.review_note, al.label as link_label
      from rental_applications ra
      join application_links al on al.id = ra.link_id
     where ra.organisation_id = ${organisationId}::uuid
       ${options.status ? tx`and ra.status = ${options.status}::app.rental_application_status` : tx``}
     order by ra.submitted_at desc
     limit 500
  `;
  return rows.map((r) => ({
    id: r.id, reference: r.reference, status: r.status, fullName: r.full_name,
    email: r.email, phone: r.phone, currentAddress: r.current_address,
    employment: r.employment, monthlyIncomeMinor: r.monthly_income_minor,
    occupants: r.occupants, moveInDate: r.move_in_date, message: r.message,
    submittedAt: r.submitted_at, linkLabel: r.link_label, reviewNote: r.review_note,
  }));
}

/**
 * Records a decision on an application.
 *
 * The note is kept with the decision. "Declined" with no reason is the sort of
 * record that is impossible to defend later, and a rental decision is exactly
 * the kind someone may be asked to justify.
 */
export async function decideRentalApplication(
  tx: Sql, organisationId: string, actorUserId: string,
  params: { applicationId: string; status: 'screening' | 'approved' | 'declined' | 'withdrawn'; note: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'lease.create');
  const note = z.string().trim().min(3).max(2000).parse(params.note);

  const rows = await tx`
    update rental_applications
       set status = ${params.status}::app.rental_application_status,
           reviewed_at = now(), reviewed_by = ${actorUserId}, review_note = ${note}
     where id = ${params.applicationId}::uuid and organisation_id = ${organisationId}::uuid
    returning id
  `;
  if (rows.length === 0) throw notFound('Application');

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'rental_application.decided', resourceType: 'rental_application',
    resourceId: params.applicationId, after: { status: params.status }, reason: note,
  });
}

/** What a public link says about itself. Null when it is dead, revoked or fake. */
export async function describeApplicationLink(
  tx: Sql, token: string,
): Promise<{ organisationName: string; label: string; unitLabel: string | null } | null> {
  const [row] = await tx<
    { organisation_name: string; label: string; unit_label: string | null }[]
  >`select organisation_name, label, unit_label from app.application_link_details(${token})`;
  return row
    ? { organisationName: row.organisation_name, label: row.label, unitLabel: row.unit_label }
    : null;
}

export const rentalApplicationSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  currentAddress: z.string().trim().max(300).optional().or(z.literal('')),
  employment: z.string().trim().max(300).optional().or(z.literal('')),
  monthlyIncomeMinor: z.bigint().nonnegative().optional(),
  occupants: z.number().int().min(1).max(30).optional(),
  moveInDate: z.string().date().optional(),
  message: z.string().trim().max(2000).optional().or(z.literal('')),
});

/**
 * Submits an application. The token is the only thing that authorises it, and
 * the database checks it — this never trusts an organisation id from the form.
 */
export async function submitRentalApplication(
  tx: Sql, token: string, input: z.input<typeof rentalApplicationSchema>,
): Promise<{ reference: string }> {
  const a = rentalApplicationSchema.parse(input);
  const [row] = await tx<{ reference: string }[]>`
    select app.submit_rental_application(
      ${token},
      ${a.fullName},
      ${a.email || null},
      ${a.phone || null},
      ${a.currentAddress || null},
      ${a.employment || null},
      ${a.monthlyIncomeMinor ?? null},
      ${a.occupants ?? null},
      ${a.moveInDate ?? null},
      ${a.message || null}
    ) as reference
  `;
  if (!row?.reference) throw invalid('That application could not be submitted.');
  return { reference: row.reference };
}
