import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, fromDatabaseError } from './errors';
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

/**
 * Masks an identity number for list views. The full value is never selected by
 * ordinary profile reads; only the last four digits are stored at all.
 */
export function maskIdentity(last4: string | null): string {
  return last4 ? `••••••• ${last4}` : '—';
}
