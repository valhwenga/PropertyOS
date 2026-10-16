'use server';

import { revalidatePath } from 'next/cache';
import { provisionCustomer } from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Provisioning a customer.
 *
 * Runs privileged because every write policy in the schema is keyed on
 * membership and a Spike operator is deliberately a member of nothing — they
 * are not acting inside a customer organisation, they are bringing one into
 * existence. The operator's verified identity is still on the transaction, so
 * `provisionCustomer` performs its own platform-operator and second-factor
 * checks in SQL; the privilege lifts the row filtering, not the decision.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function provisionCustomerAction(_previous: unknown, formData: FormData) {
  const result = await command(async ({ tx, viewer }) => {
    const provisioned = await provisionCustomer(tx, viewer.authUserId, {
      name: str(formData, 'name'),
      slug: str(formData, 'slug'),
      legalEntityName: str(formData, 'legalEntityName'),
      planKey: str(formData, 'planKey'),
      administrator: {
        fullName: str(formData, 'administratorName'),
        email: str(formData, 'administratorEmail'),
      },
      reason: str(formData, 'reason'),
    });
    return {
      // The one moment the token exists in readable form.
      token: provisioned.token,
      slug: str(formData, 'slug'),
      administratorName: str(formData, 'administratorName'),
      administratorEmail: str(formData, 'administratorEmail').trim().toLowerCase(),
      expiresAt: provisioned.expiresAt.toISOString(),
    };
  }, { privileged: true });

  // The customer list is marked stale, not this page: the form holds the link
  // and re-rendering it would throw the link away.
  if (result.ok) revalidatePath('/platform');
  return result;
}
