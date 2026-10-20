'use server';

import { revalidatePath } from 'next/cache';
import { chargeCategoryByKey, parseMajorToMinor, postCharge } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Raising a charge on one lease.
 *
 * `postCharge` has existed since §5 with no screen, so a landlord could bill a
 * fixed monthly amount through a schedule and nothing else — which covers rent
 * and covers none of water, electricity, sewerage or refuse, every one of
 * which moves each month because it is a reading times a tariff.
 *
 * The amount is typed in major units because that is what a municipal account
 * shows; `parseMajorToMinor` is the same parser the rest of the product uses,
 * so "1 234,56" and "1,234.56" both mean the same thing here as everywhere
 * else. Nothing is computed from the meter readings: the amount posted is the
 * amount the operator entered, and the readings are stored as evidence beside
 * it. A form that silently recalculated the total would be deciding what a
 * tenant owes.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** An optional number field: blank means absent, not zero. */
function optionalNumber(f: FormData, k: string): number | undefined {
  const raw = str(f, k);
  if (!raw) return undefined;
  const value = Number(raw.replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${k} must be a number, or left blank.`);
  }
  return value;
}

export async function raiseChargeAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const leaseId = str(formData, 'leaseId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);

    const category = str(formData, 'category');
    const definition = chargeCategoryByKey(category);
    if (!definition) throw new Error('Choose what this charge is for.');

    const currency = context.currencyCode ?? 'ZAR';
    const amountMinor = parseMajorToMinor(str(formData, 'amount'), currency);
    if (amountMinor <= 0n) throw new Error('A charge must be more than nothing.');

    const quantity = optionalNumber(formData, 'quantity');
    const rate = str(formData, 'unitRate');
    const unit = str(formData, 'unit') || definition.unit;

    // The document type follows the category, so a water recovery lands in the
    // invoice queue as a utility invoice rather than as an adjustment nobody
    // sends.
    const documentType = category === 'rent'
      ? 'rent_invoice' as const
      : category.startsWith('utility_')
        ? 'utility_invoice' as const
        : 'adjustment_debit' as const;

    const issueDate = str(formData, 'issueDate');
    const dueDate = str(formData, 'dueDate') || issueDate;
    const periodStart = str(formData, 'periodStart') || undefined;
    const periodEnd = str(formData, 'periodEnd') || undefined;

    const posted = await postCharge(tx, context.organisationId, viewer.authUserId, {
      leaseId,
      documentType,
      issueDate,
      dueDate,
      periodStart,
      periodEnd,
      lines: [{
        category,
        description: str(formData, 'description') || definition.defaultDescription,
        amountMinor,
        dueDate,
        servicePeriodStart: periodStart,
        servicePeriodEnd: periodEnd,
        ...(quantity !== undefined && rate
          ? {
            quantity,
            unit: unit ?? 'units',
            unitRateMinor: parseMajorToMinor(rate, currency),
          }
          : {}),
        ...(str(formData, 'meterCurrent')
          ? {
            meterPrevious: optionalNumber(formData, 'meterPrevious'),
            meterCurrent: optionalNumber(formData, 'meterCurrent'),
          }
          : {}),
      }],
    });

    return {
      documentNumber: posted.documentNumber,
      documentId: posted.documentId,
      totalMinor: posted.totalMinor.toString(),
    };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/leases/${leaseId}`);
    revalidatePath(`/app/${org}/billing/invoices`);
  }
  return result;
}
