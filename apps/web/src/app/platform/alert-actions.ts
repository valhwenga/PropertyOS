'use server';

import { revalidatePath } from 'next/cache';
import { silenceAlert, unsilenceAlert } from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Quietening a condition, and changing your mind.
 *
 * Not privileged: the silence table's policies are keyed on
 * `platform.operations.manage`, so the operator's own context is enough and
 * the permission is resolved in SQL like everything else in this console.
 */
export async function silenceAlertAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    silenceAlert(tx, viewer.authUserId, {
      alertKey: String(formData.get('alertKey') ?? ''),
      hours: Number(formData.get('hours') ?? 24),
      reason: String(formData.get('reason') ?? ''),
    }).then(() => ({})));
  if (result.ok) revalidatePath('/platform');
  return result;
}

export async function unsilenceAlertAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    unsilenceAlert(tx, viewer.authUserId, {
      alertKey: String(formData.get('alertKey') ?? ''),
    }).then(() => ({})));
  if (result.ok) revalidatePath('/platform');
  return result;
}
