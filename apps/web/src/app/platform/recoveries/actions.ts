'use server';

import { revalidatePath } from 'next/cache';
import { approveRecoveryAsSpike, cancelRecovery } from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Spike deciding a recovery, which it may do only for somebody who has nobody
 * else to ask.
 *
 * Not privileged, and that matters here more than anywhere else in this
 * console. `recovery_requests` hides from an operator every request that the
 * customer's own administrator could decide, and reading or writing these
 * through a privileged connection would lift that away. The rule is also
 * stated in the domain function and in the list query, because it is the only
 * thing standing between "Spike helps a solo landlord" and "Spike can get into
 * any account".
 */
export async function approveRecoveryAsSpikeAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    approveRecoveryAsSpike(tx, viewer.authUserId, {
      requestId: String(formData.get('requestId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    }));
  if (result.ok) revalidatePath('/platform/recoveries');
  return result;
}

export async function declineRecoveryAsSpikeAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    cancelRecovery(tx, viewer.authUserId, {
      requestId: String(formData.get('requestId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    }).then(() => ({})));
  if (result.ok) revalidatePath('/platform/recoveries');
  return result;
}
