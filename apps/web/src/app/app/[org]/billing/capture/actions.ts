'use server';

import { revalidatePath } from 'next/cache';
import { captureCharge, discardCapturedCharge } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Typing the month's charges, and throwing one away.
 *
 * Not privileged: `pending_charges` carries policies keyed on
 * `billing.preview`, so the clerk's own context is enough and the permission
 * is resolved in SQL. Which is right — this is the same act as producing a
 * preview, typed instead of derived, and it is deliberately NOT the permission
 * that posts money.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const num = (f: FormData, k: string) => {
  const raw = str(f, k);
  return raw === '' ? undefined : Number(raw.replace(',', '.'));
};

export async function captureChargeAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const context = await requireOperator(org);

  // Rands in the form, minor units in the domain: the person typing has a
  // municipal account in front of them, not a cent count.
  const majorToMinor = (value: number | undefined) =>
    value === undefined ? undefined : BigInt(Math.round(value * 100));

  const result = await command(({ tx, viewer }) =>
    captureCharge(tx, context.organisationId, viewer.authUserId, {
      periodStart: str(formData, 'periodStart'),
      leaseId: str(formData, 'leaseId'),
      category: str(formData, 'category'),
      description: str(formData, 'description') || undefined,
      meterPrevious: num(formData, 'meterPrevious'),
      meterCurrent: num(formData, 'meterCurrent'),
      quantity: num(formData, 'quantity'),
      unitRateMinor: majorToMinor(num(formData, 'unitRate')),
      amountMinor: majorToMinor(num(formData, 'amount')),
      note: str(formData, 'note') || undefined,
    }).then((captured) => ({ amountMinor: captured.amountMinor.toString() })));

  if (result.ok) revalidatePath(`/app/${org}/billing/capture`);
  return result;
}

export async function discardCaptureAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const context = await requireOperator(org);

  const result = await command(({ tx, viewer }) =>
    discardCapturedCharge(
      tx, context.organisationId, viewer.authUserId, str(formData, 'pendingChargeId'),
    ).then(() => ({})));

  if (result.ok) revalidatePath(`/app/${org}/billing/capture`);
  return result;
}
