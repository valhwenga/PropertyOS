'use server';

import { revalidatePath } from 'next/cache';
import { setResidentIdentityNumber, updateResident } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function updateResidentAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const residentId = str(formData, 'residentId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await updateResident(tx, context.organisationId, viewer.authUserId, {
      residentId,
      firstName: str(formData, 'firstName'),
      lastName: str(formData, 'lastName'),
      email: str(formData, 'email'),
      phone: str(formData, 'phone'),
      dateOfBirth: str(formData, 'dateOfBirth') || undefined,
      communicationPreference:
        (str(formData, 'communicationPreference') as 'email' | 'in_app' | 'none') || 'email',
      status: (str(formData, 'status') || undefined) as
        'prospect' | 'active' | 'former' | 'archived' | undefined,
      notes: str(formData, 'notes'),
    });
    return { saved: true };
  });

  if (result.ok) revalidatePath(`/app/${org}/residents/${residentId}`);
  return result;
}

/**
 * Stores a resident's identity number, sealed.
 *
 * Separate from the profile form on purpose. §6: "Collect identity and income
 * documents only for a defined purpose; restrict access separately from
 * ordinary profile access." Mixing it into the ordinary edit would mean every
 * profile correction re-submits an identity number, and the field would have to
 * be pre-filled to avoid wiping it — which would mean displaying it.
 */
export async function setResidentIdentityAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const residentId = str(formData, 'residentId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await setResidentIdentityNumber(tx, context.organisationId, viewer.authUserId, {
      residentId,
      identityNumber: str(formData, 'identityNumber'),
    });
    return { saved: true };
  });

  if (result.ok) revalidatePath(`/app/${org}/residents/${residentId}`);
  return result;
}
