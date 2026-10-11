'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  archiveProperty, createUnit, parseMajorToMinor, reinstateProperty, reinstateUnit,
  retireUnit, updateProperty, updateUnit,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Editing the portfolio.
 *
 * Only the fields the form sends are passed on, because the domain decides what
 * "not supplied" means and it is not the same as "clear it". A form that always
 * sent every field would turn an untouched optional into a deletion.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function updatePropertyAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const propertyId = str(formData, 'propertyId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await updateProperty(tx, context.organisationId, viewer.authUserId, propertyId, {
      name: str(formData, 'name'),
      code: str(formData, 'code'),
      propertyType: str(formData, 'propertyType') as
        'house' | 'cottage' | 'apartment' | 'apartment_block' | 'townhouse' | 'other',
      addressLine1: str(formData, 'addressLine1'),
      addressLine2: str(formData, 'addressLine2'),
      suburb: str(formData, 'suburb'),
      city: str(formData, 'city'),
      province: str(formData, 'province'),
      postalCode: str(formData, 'postalCode'),
      reason: str(formData, 'reason') || undefined,
    });
    return { saved: true };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/portfolio/${propertyId}`);
    revalidatePath(`/app/${org}/portfolio`);
    redirect(`/app/${org}/portfolio/${propertyId}`);
  }
  return result;
}

export async function updateUnitAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const propertyId = str(formData, 'propertyId');
  const unitId = str(formData, 'unitId');
  const rent = str(formData, 'advertisedRent').trim();

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await updateUnit(tx, context.organisationId, viewer.authUserId, unitId, {
      code: str(formData, 'code'),
      description: str(formData, 'description'),
      rentableType: str(formData, 'rentableType') as
        'whole_property' | 'apartment' | 'cottage' | 'room' | 'other',
      bedrooms: str(formData, 'bedrooms') ? Number(str(formData, 'bedrooms')) : undefined,
      bathrooms: str(formData, 'bathrooms') ? Number(str(formData, 'bathrooms')) : undefined,
      floor: str(formData, 'floor'),
      floorAreaSqm: str(formData, 'floorAreaSqm')
        ? Number(str(formData, 'floorAreaSqm')) : undefined,
      // The ADVERTISED rent. What a resident owes is on their lease and is
      // changed by a renewal, never from here.
      advertisedRentMinor: rent ? parseMajorToMinor(rent, context.currencyCode) : undefined,
    });
    return { saved: true };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/portfolio/${propertyId}`);
    revalidatePath(`/app/${org}/portfolio/${propertyId}/units/${unitId}`);
    redirect(`/app/${org}/portfolio/${propertyId}`);
  }
  return result;
}

export async function retireUnitAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const propertyId = str(formData, 'propertyId');
  const unitId = str(formData, 'unitId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await retireUnit(tx, context.organisationId, viewer.authUserId, {
      unitId, reason: str(formData, 'reason'),
    });
    return { retired: true };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/portfolio/${propertyId}`);
    revalidatePath(`/app/${org}/portfolio/${propertyId}/units/${unitId}`);
  }
  return result;
}

export async function reinstateUnitAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const propertyId = str(formData, 'propertyId');
  const unitId = str(formData, 'unitId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await reinstateUnit(tx, context.organisationId, viewer.authUserId, {
      unitId, reason: str(formData, 'reason'),
    });
    return { reinstated: true };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/portfolio/${propertyId}`);
    revalidatePath(`/app/${org}/portfolio/${propertyId}/units/${unitId}`);
  }
  return result;
}

export async function archivePropertyAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const propertyId = str(formData, 'propertyId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await archiveProperty(tx, context.organisationId, viewer.authUserId, {
      propertyId, reason: str(formData, 'reason'),
    });
    return { archived: true };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/portfolio/${propertyId}`);
    revalidatePath(`/app/${org}/portfolio`);
  }
  return result;
}

export async function reinstatePropertyAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const propertyId = str(formData, 'propertyId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await reinstateProperty(tx, context.organisationId, viewer.authUserId, {
      propertyId, reason: str(formData, 'reason'),
    });
    return { reinstated: true };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/portfolio/${propertyId}`);
    revalidatePath(`/app/${org}/portfolio`);
  }
  return result;
}

/**
 * Adds a unit to a property that already exists.
 *
 * `createUnit` had no screen anywhere: a property was created with whatever
 * units it was born with, and an apartment block that gained a flat could
 * never record it. Creating a property is a different act with its own page,
 * so this lives beside the edit form rather than on it.
 */
export async function addUnitAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const propertyId = str(formData, 'propertyId');
  const rent = str(formData, 'advertisedRent').trim();

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return createUnit(tx, context.organisationId, viewer.authUserId, {
      propertyId,
      code: str(formData, 'code'),
      description: str(formData, 'description'),
      rentableType: (str(formData, 'rentableType') || 'apartment') as
        'whole_property' | 'apartment' | 'cottage' | 'room' | 'other',
      bedrooms: str(formData, 'bedrooms') ? Number(str(formData, 'bedrooms')) : undefined,
      bathrooms: str(formData, 'bathrooms') ? Number(str(formData, 'bathrooms')) : undefined,
      advertisedRentMinor: rent ? parseMajorToMinor(rent, context.currencyCode) : undefined,
    });
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/portfolio/${propertyId}`);
    redirect(`/app/${org}/portfolio/${propertyId}`);
  }
  return result;
}
