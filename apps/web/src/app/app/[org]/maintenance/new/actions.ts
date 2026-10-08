'use server';

import { revalidatePath } from 'next/cache';
import { createTicket, invalid } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Logs a request as the operator.
 *
 * The unit decides the property, the lease and the resident: the form submits a
 * unit and this reads the rest from the database rather than trusting three ids
 * that arrived together in one request. A client that sends a unit from one
 * organisation and a lease from another gets nothing — the lookup is scoped, and
 * `createTicket` checks the property scope again on top.
 */
export async function logRequestAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const unitId = String(formData.get('unitId') ?? '').trim();

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    if (!unitId) throw invalid('Choose the unit the request is about.');

    const [unit] = await tx<
      { property_id: string; lease_id: string | null; resident_id: string | null }[]
    >`
      select u.property_id,
             l.id as lease_id,
             lp.resident_id
        from units u
        left join leases l
          on l.unit_id = u.id and l.status in ('active', 'notice_given', 'awaiting_execution')
        left join lease_parties lp
          on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
       where u.id = ${unitId}::uuid and u.organisation_id = ${context.organisationId}::uuid
    `;
    if (!unit) throw invalid('That unit is not one of yours.');

    const text = (key: string) => {
      const value = String(formData.get(key) ?? '').trim();
      return value === '' ? undefined : value;
    };

    return createTicket(tx, context.organisationId, viewer.authUserId, {
      propertyId: unit.property_id,
      unitId,
      // Linked to the tenancy when there is one, so the ticket appears on the
      // lease rather than floating against the unit alone.
      leaseId: unit.lease_id ?? undefined,
      residentId: unit.resident_id ?? undefined,
      category: (text('category') ?? '') as never,
      urgency: (text('urgency') ?? 'normal') as never,
      location: text('location'),
      description: String(formData.get('description') ?? ''),
      accessNotes: text('accessNotes'),
    });
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/maintenance`);
  }
  return result;
}
