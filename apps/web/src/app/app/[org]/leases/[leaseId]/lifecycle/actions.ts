'use server';

import { revalidatePath } from 'next/cache';
import { extendLease, invalid, parseDayMonthYear, terminateLease } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';
import { notifyLeaseResidents } from '@/lib/lease-notices';

export async function terminateLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const typedDate = String(formData.get('effectiveDate') ?? '').trim();
    const effectiveDate = parseDayMonthYear(typedDate);
    if (!effectiveDate) throw invalid('Enter the end date as dd/mm/yyyy.');
    const reason = String(formData.get('reason') ?? '');

    const outcome = await terminateLease(tx, context.organisationId, viewer.authUserId, {
      leaseId, reason, effectiveDate,
    });

    // The resident is told, because a lease ending is the sort of thing they
    // should hear from the system rather than discover. Both the notice and the
    // email carry the reason: a date with no explanation invites a phone call.
    //
    // This is the one notice that emails a resident who asked not to be
    // emailed. A lease ending changes where they live and what they owe, and a
    // preference set months earlier is not consent to miss it. The override is
    // counted and shown to the operator, never applied quietly.
    const delivery = await notifyLeaseResidents(tx, context.organisationId, {
      leaseId,
      templateKey: 'lease.terminated',
      title: 'Your lease has been ended',
      body: `Your lease ends on ${typedDate}. Reason given: ${reason}`
        + ' Any balance still owing remains payable.',
      linkPath: `/portal/${leaseId}`,
      email: {
        overridePreference: true,
        subject: 'Your lease has been ended',
        body: [
          `Your lease ends on ${typedDate}.`,
          '',
          `Reason given: ${reason}`,
          '',
          'Ending the lease does not clear what is owed. Any balance on your account '
            + 'remains payable, and your deposit is handled separately.',
          '',
          'Sign in to PropertyOS to see your statement and documents.',
        ].join('\n'),
      },
    });
    return { ...outcome, ...delivery };
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}

export async function extendLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const typedDate = String(formData.get('newEndDate') ?? '').trim();
    const newEndDate = parseDayMonthYear(typedDate);
    if (!newEndDate) throw invalid('Enter the new end date as dd/mm/yyyy.');
    const reason = String(formData.get('reason') ?? '');

    const outcome = await extendLease(tx, context.organisationId, viewer.authUserId, {
      leaseId, newEndDate, reason,
    });

    const delivery = await notifyLeaseResidents(tx, context.organisationId, {
      leaseId,
      templateKey: 'lease.extended',
      title: 'Your lease has been extended',
      body: `Your lease now runs to ${typedDate}. Reason given: ${reason}`,
      linkPath: `/portal/${leaseId}`,
      email: {
        subject: 'Your lease has been extended',
        body: [
          `Your lease now runs to ${typedDate}.`,
          '',
          `Reason given: ${reason}`,
          '',
          'Nothing else about the lease has changed. Sign in to PropertyOS to see your '
            + 'statement and documents.',
        ].join('\n'),
      },
    });
    return { ...outcome, ...delivery };
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}
