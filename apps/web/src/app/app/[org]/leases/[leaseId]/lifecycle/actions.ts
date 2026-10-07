'use server';

import { revalidatePath } from 'next/cache';
import {
  extendLease, invalid, parseDayMonthYear, postInAppNotice, terminateLease,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/** Everyone with a live portal link to this lease. */
async function portalUsers(tx: Parameters<Parameters<typeof command>[0]>[0]['tx'],
                           organisationId: string, leaseId: string): Promise<string[]> {
  const rows = await tx<{ auth_user_id: string }[]>`
    select auth_user_id from portal_links
     where organisation_id = ${organisationId}::uuid
       and lease_id = ${leaseId}::uuid and status = 'active'
  `;
  return rows.map((r) => r.auth_user_id);
}

export async function terminateLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const effectiveDate = parseDayMonthYear(String(formData.get('effectiveDate') ?? '').trim());
    if (!effectiveDate) throw invalid('Enter the end date as dd/mm/yyyy.');

    const outcome = await terminateLease(tx, context.organisationId, viewer.authUserId, {
      leaseId, reason: String(formData.get('reason') ?? ''), effectiveDate,
    });

    // The resident is told, because a lease ending is the sort of thing they
    // should hear from the system rather than discover.
    await postInAppNotice(tx, context.organisationId, {
      recipientUserIds: await portalUsers(tx, context.organisationId, leaseId),
      templateKey: 'lease.terminated',
      title: 'Your lease has been ended',
      body: `Your lease ends on ${String(formData.get('effectiveDate'))}. Reason given: ${String(formData.get('reason'))}. Any balance still owing remains payable.`,
      linkPath: `/portal/${leaseId}`,
    });
    return outcome;
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}

export async function extendLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const newEndDate = parseDayMonthYear(String(formData.get('newEndDate') ?? '').trim());
    if (!newEndDate) throw invalid('Enter the new end date as dd/mm/yyyy.');

    const outcome = await extendLease(tx, context.organisationId, viewer.authUserId, {
      leaseId, newEndDate, reason: String(formData.get('reason') ?? ''),
    });

    await postInAppNotice(tx, context.organisationId, {
      recipientUserIds: await portalUsers(tx, context.organisationId, leaseId),
      templateKey: 'lease.extended',
      title: 'Your lease has been extended',
      body: `Your lease now runs to ${String(formData.get('newEndDate'))}. Reason given: ${String(formData.get('reason'))}.`,
      linkPath: `/portal/${leaseId}`,
    });
    return outcome;
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}
