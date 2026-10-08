import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, fromDatabaseError, notFound, parsed } from './errors';
import { requirePermission } from './permissions';

export const createResidentSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  dateOfBirth: z.string().date().optional(),
  communicationPreference: z.enum(['email', 'in_app', 'none']).default('email'),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

/**
 * Creates a resident profile.
 *
 * A resident is a person record, NOT a login. They can exist indefinitely with
 * no portal account, and the same person can later appear on several leases.
 */
export async function createResident(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof createResidentSchema>,
): Promise<{ residentId: string }> {
  await requirePermission(tx, organisationId, 'resident.manage');
  const r = createResidentSchema.parse(input);
  const blank = (v: string | undefined) => (v === undefined || v === '' ? null : v);

  try {
    const [row] = await tx<{ id: string }[]>`
      insert into resident_profiles (
        organisation_id, first_name, last_name, email, phone, date_of_birth,
        communication_preference, notes, status
      ) values (
        ${organisationId}, ${r.firstName}, ${r.lastName}, ${blank(r.email)},
        ${blank(r.phone)}, ${r.dateOfBirth ?? null}, ${r.communicationPreference},
        ${blank(r.notes)}, 'prospect'
      )
      returning id
    `;
    if (!row) throw new DomainError('internal', 'Resident insert returned no row.');
    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'resident.created', resourceType: 'resident', resourceId: row.id,
      // Names are operational data the operator already entered; identity numbers
      // and documents are never written to the audit trail.
      after: { firstName: r.firstName, lastName: r.lastName },
    });
    return { residentId: row.id };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/** The editable part of a profile. Status and identity number are separate. */
export const updateResidentSchema = createResidentSchema.extend({
  residentId: z.string().uuid(),
  status: z.enum(['prospect', 'active', 'former', 'archived']).optional(),
});

/**
 * Edits a resident profile.
 *
 * Deliberately excludes two things. The identity number has its own command,
 * because capturing one opens a sealed field and is gated separately from
 * ordinary profile access. And nothing here deletes: §6 says to archive an
 * inactive resident "while preserving authorised historical records", so the
 * status moves and the row stays, because leases, statements and audit events
 * all point at it.
 */
export async function updateResident(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof updateResidentSchema>,
): Promise<void> {
  await requirePermission(tx, organisationId, 'resident.manage');
  const r = parsed(updateResidentSchema, input);
  const blank = (v: string | undefined) => (v === undefined || v === '' ? null : v);

  const [before] = await tx<
    { first_name: string; last_name: string; status: string; email: string | null }[]
  >`
    select first_name, last_name, status, email::text as email from resident_profiles
     where id = ${r.residentId} and organisation_id = ${organisationId}
     for update
  `;
  if (!before) throw notFound('Resident');

  try {
    await tx`
      update resident_profiles
         set first_name = ${r.firstName}, last_name = ${r.lastName},
             email = ${blank(r.email)}, phone = ${blank(r.phone)},
             date_of_birth = ${r.dateOfBirth ?? null},
             communication_preference = ${r.communicationPreference},
             notes = ${blank(r.notes)},
             status = ${r.status ?? before.status},
             updated_at = now()
       where id = ${r.residentId} and organisation_id = ${organisationId}
    `;
  } catch (error) {
    throw fromDatabaseError(error);
  }

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'resident.updated', resourceType: 'resident', resourceId: r.residentId,
    // Names, status and contact address only. The identity number is not read
    // by this command and never reaches the audit trail.
    before: {
      firstName: before.first_name, lastName: before.last_name,
      status: before.status, email: before.email,
    },
    after: {
      firstName: r.firstName, lastName: r.lastName,
      status: r.status ?? before.status, email: blank(r.email),
    },
  });
}

/**
 * Masks an identity number for list views. The full value is never selected by
 * ordinary profile reads; only the last four digits are stored at all.
 */
export function maskIdentity(last4: string | null): string {
  return last4 ? `••••••• ${last4}` : '—';
}
