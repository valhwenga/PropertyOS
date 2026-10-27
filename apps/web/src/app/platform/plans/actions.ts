'use server';

import { revalidatePath } from 'next/cache';
import {
  createPlan, parseMajorToMinor, removePlanPrice, setPlanActive, setPlanEntitlement,
  setPlanPrice,
} from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * The price list.
 *
 * Prices arrive from the form in rands and are stored in cents, through the
 * same `parseMajorToMinor` every money field in the product uses — a price
 * typed as 899 and stored as 899 would charge R8.99, which is the kind of
 * mistake that only shows up on somebody's invoice.
 *
 * Not privileged: `plan_prices` is written under a policy keyed on
 * `platform.billing.manage`, the same permission that issues the invoices
 * these prices produce.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');
const minor = (f: FormData, k: string, currency: string) =>
  Number(parseMajorToMinor(str(f, k), currency));

export async function setPlanPriceAction(_previous: unknown, formData: FormData) {
  const currency = str(formData, 'currencyCode') || 'ZAR';
  const result = await command(({ tx, viewer }) =>
    setPlanPrice(tx, viewer.authUserId, {
      planKey: str(formData, 'planKey'),
      effectiveFrom: str(formData, 'effectiveFrom'),
      includedUnits: Number(str(formData, 'includedUnits')),
      monthlyPriceMinor: minor(formData, 'monthlyPrice', currency),
      additionalUnitPriceMinor: minor(formData, 'additionalUnitPrice', currency),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/plans');
  return result;
}

export async function removePlanPriceAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    removePlanPrice(tx, viewer.authUserId, {
      planKey: str(formData, 'planKey'),
      effectiveFrom: str(formData, 'effectiveFrom'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/plans');
  return result;
}

export async function createPlanAction(_previous: unknown, formData: FormData) {
  const currency = str(formData, 'currencyCode') || 'ZAR';
  const result = await command(({ tx, viewer }) =>
    createPlan(tx, viewer.authUserId, {
      key: str(formData, 'key'),
      name: str(formData, 'name'),
      currencyCode: currency,
      includedUnits: Number(str(formData, 'includedUnits')),
      monthlyPriceMinor: minor(formData, 'monthlyPrice', currency),
      additionalUnitPriceMinor: minor(formData, 'additionalUnitPrice', currency),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/plans');
  return result;
}

export async function setPlanActiveAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    setPlanActive(tx, viewer.authUserId, {
      key: str(formData, 'key'),
      isActive: str(formData, 'isActive') === 'true',
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/plans');
  return result;
}

export async function setPlanEntitlementAction(_previous: unknown, formData: FormData) {
  const raw = str(formData, 'limitValue').trim();
  const result = await command(({ tx, viewer }) =>
    setPlanEntitlement(tx, viewer.authUserId, {
      key: str(formData, 'key'),
      feature: str(formData, 'feature'),
      // An empty box means no limit, which is a row that does not exist.
      limitValue: raw === '' ? null : Number(raw),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/plans');
  return result;
}
