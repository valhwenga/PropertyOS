'use server';

import { revalidatePath } from 'next/cache';
import { createProperty, createStandaloneHouse, parseMajorToMinor } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

type PropertyType = 'house' | 'cottage' | 'apartment' | 'apartment_block' | 'townhouse' | 'other';

/**
 * Creates a property.
 *
 * A block is created as a property on its own, because its units differ and
 * have to be described individually. Anything else is created WITH its single
 * rentable unit, so it can be let immediately rather than appearing in the
 * portfolio with nothing to lease.
 */
export async function createPropertyAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const propertyType = String(formData.get('propertyType') ?? 'house') as PropertyType;

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const rentText = String(formData.get('advertisedRent') ?? '').trim();

    const input = {
      name: String(formData.get('name') ?? '').trim(),
      code: String(formData.get('code') ?? '').trim(),
      propertyType,
      addressLine1: String(formData.get('addressLine1') ?? '').trim(),
      addressLine2: String(formData.get('addressLine2') ?? '').trim(),
      suburb: String(formData.get('suburb') ?? '').trim(),
      city: String(formData.get('city') ?? '').trim(),
      province: String(formData.get('province') ?? '').trim(),
      postalCode: String(formData.get('postalCode') ?? '').trim(),
      // The schema defaults this; South Africa is the product's market.
      countryCode: 'ZA',
      ...(rentText
        ? { advertisedRentMinor: parseMajorToMinor(rentText, context.currencyCode) }
        : {}),
    };

    if (propertyType === 'apartment_block') {
      const { propertyId } = await createProperty(tx, context.organisationId, viewer.authUserId, input);
      return { propertyId, unitCreated: false };
    }
    const { propertyId } = await createStandaloneHouse(
      tx, context.organisationId, viewer.authUserId, input,
    );
    return { propertyId, unitCreated: true };
  });

  if (result.ok) revalidatePath(`/app/${org}/portfolio`);
  return result;
}
