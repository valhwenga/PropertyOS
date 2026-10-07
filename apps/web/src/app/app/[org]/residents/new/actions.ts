'use server';

import { revalidatePath } from 'next/cache';
import { createResident } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Creates a resident profile.
 *
 * A resident is a person record, not a login. No portal account is created
 * here, and none is implied.
 */
export async function createResidentAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const { residentId } = await createResident(tx, context.organisationId, viewer.authUserId, {
      firstName: String(formData.get('firstName') ?? '').trim(),
      lastName: String(formData.get('lastName') ?? '').trim(),
      email: String(formData.get('email') ?? '').trim(),
      phone: String(formData.get('phone') ?? '').trim(),
      communicationPreference:
        (String(formData.get('communicationPreference') ?? 'email') as 'email' | 'in_app' | 'none'),
      notes: String(formData.get('notes') ?? '').trim(),
    });
    return { residentId };
  });
  if (result.ok) revalidatePath(`/app/${org}/residents`);
  return result;
}
