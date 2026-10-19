'use server';

import { revalidatePath } from 'next/cache';
import { parseMajorToMinor, setApprovalPolicy } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Changing how many people must approve a money action.
 *
 * The threshold is typed in rands and converted here with the same parser the
 * rest of the product uses, so "1 000" and "1000.00" mean the same thing and
 * nothing is rounded on its way into the database.
 */
export async function saveApprovalPolicyAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org') ?? '');
  const actionKey = String(formData.get('actionKey') ?? '');
  const required = Number(formData.get('approvalsRequired') ?? '1');
  const threshold = String(formData.get('threshold') ?? '').trim();

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const thresholdMinor = required === 2 && threshold
      ? parseMajorToMinor(threshold, context.currencyCode)
      : 0n;
    await setApprovalPolicy(tx, context.organisationId, viewer.authUserId, {
      actionKey, approvalsRequired: required, thresholdMinor,
    });
    return { actionKey, approvalsRequired: required };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/settings/approvals`);
    revalidatePath(`/app/${org}/approvals`);
  }
  return result;
}
