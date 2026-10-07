'use server';

import { revalidatePath } from 'next/cache';
import { draftLease, parseDayMonthYear, parseMajorToMinor } from '@propertyos/domain';
import { invalid } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Drafts a lease.
 *
 * A DRAFT only. It has no billing effect and does not reserve the unit, so
 * filling this in charges nobody. Activating it is a separate, deliberate step.
 */
export async function draftLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const deposit = String(formData.get('depositRequired') ?? '').trim();
    const noticeDays = String(formData.get('noticeDays') ?? '').trim();

    // DateField submits what the operator typed, dd/mm/yyyy, so that the entry
    // reads the same on every machine regardless of the browser's locale. The
    // conversion to a stored date belongs here.
    const startDate = parseDayMonthYear(String(formData.get('startDate') ?? '').trim());
    if (!startDate) throw invalid('Enter the start date as dd/mm/yyyy, for example 01/12/2026.');
    const endText = String(formData.get('endDate') ?? '').trim();
    const endDate = endText ? parseDayMonthYear(endText) : null;
    if (endText && !endDate) {
      throw invalid('Enter the end date as dd/mm/yyyy, or leave it blank for month to month.');
    }

    const { leaseId, reference } = await draftLease(
      tx, context.organisationId, viewer.authUserId,
      {
        unitId: String(formData.get('unitId') ?? ''),
        startDate,
        ...(endDate ? { endDate } : {}),
        rentMinor: parseMajorToMinor(String(formData.get('rent') ?? '').trim(), context.currencyCode),
        billingDay: Number(formData.get('billingDay') ?? 1),
        depositRequiredMinor: deposit ? parseMajorToMinor(deposit, context.currencyCode) : 0n,
        ...(noticeDays ? { noticeDays: Number(noticeDays) } : {}),
        parties: [{
          residentId: String(formData.get('residentId') ?? ''),
          role: 'primary_resident' as const,
          canViewFinancials: true,
        }],
      },
    );
    return { leaseId, reference };
  });

  if (result.ok) revalidatePath(`/app/${org}/leases`);
  return result;
}
