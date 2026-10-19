'use server';

import { revalidatePath } from 'next/cache';
import { removeLogo, setBranding, setLogo } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Appearance, changed by somebody who may change settings.
 *
 * The permission is checked in SQL by the domain command, as everywhere else;
 * resolving the slug here only turns a slug into the organisation the caller
 * is actually a member of.
 */
export async function saveAppearanceAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org') ?? '');
  const accent = String(formData.get('accent') ?? '');
  const typeface = String(formData.get('typeface') ?? '');

  const result = await command(async ({ tx }) => {
    const context = await requireOperator(org);
    return { branding: await setBranding(tx, context.organisationId, context.viewer.authUserId, {
      accent, typeface,
    }) };
  });
  if (result.ok) revalidatePath(`/app/${org}`, 'layout');
  return result;
}

export async function uploadLogoAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org') ?? '');
  const file = formData.get('logo');

  const result = await command(async ({ tx }) => {
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a file first.');
    // Read once, here, and hand the domain the bytes. Everything that decides
    // whether this is an image happens there, on the bytes themselves — the
    // name and the browser's content type are not consulted at all.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const context = await requireOperator(org);
    return {
      branding: await setLogo(tx, context.organisationId, context.viewer.authUserId, {
        bytes, filename: file.name,
      }),
    };
  });
  if (result.ok) revalidatePath(`/app/${org}`, 'layout');
  return result;
}

export async function removeLogoAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org') ?? '');
  const result = await command(async ({ tx }) => {
    const context = await requireOperator(org);
    return {
      branding: await removeLogo(tx, context.organisationId, context.viewer.authUserId),
    };
  });
  if (result.ok) revalidatePath(`/app/${org}`, 'layout');
  return result;
}
