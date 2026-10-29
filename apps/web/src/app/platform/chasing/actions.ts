'use server';

import { revalidatePath } from 'next/cache';
import { stopChasing, suspendForNonPayment } from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * The two ends of the ladder, both of them a person's decision.
 *
 * Privileged for the same reason the collections actions are: the application
 * role holds `select` on `subscription_dunning_steps` and nothing more, so the
 * automatic pass and these two actions are the only things that write to it.
 * The permission is still checked in SQL against the caller's own identity
 * inside each domain function — privileged lifts RLS, it does not lift
 * authorisation.
 */
export async function suspendForNonPaymentAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    suspendForNonPayment(tx, viewer.authUserId, {
      invoiceId: String(formData.get('invoiceId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    }).then(() => ({})), { privileged: true });
  if (result.ok) revalidatePath('/platform/chasing');
  return result;
}

export async function stopChasingAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    stopChasing(tx, viewer.authUserId, {
      invoiceId: String(formData.get('invoiceId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    }).then(() => ({})), { privileged: true });
  if (result.ok) revalidatePath('/platform/chasing');
  return result;
}
