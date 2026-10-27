'use server';

import { revalidatePath } from 'next/cache';
import {
  clearOrganisationSetting, clearPlatformSetting, setOrganisationSetting, setPlatformSetting,
} from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Changing what the product does without a deploy.
 *
 * Not privileged: the setting tables are written under a policy keyed on
 * `platform.config.manage`, so the operator's own context is enough and the
 * permission is resolved in SQL. The types and bounds are enforced by a
 * trigger, which reports them in words, so nothing here re-validates them
 * badly.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function setPlatformSettingAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    setPlatformSetting(tx, viewer.authUserId, {
      key: str(formData, 'key'),
      value: str(formData, 'value'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/settings');
  return result;
}

export async function clearPlatformSettingAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    clearPlatformSetting(tx, viewer.authUserId, {
      key: str(formData, 'key'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/settings');
  return result;
}

export async function setOrganisationSettingAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const result = await command(({ tx, viewer }) =>
    setOrganisationSetting(tx, viewer.authUserId, {
      organisationId: str(formData, 'organisationId'),
      key: str(formData, 'key'),
      value: str(formData, 'value'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath(`/platform/customers/${slug}`);
  return result;
}

export async function clearOrganisationSettingAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const result = await command(({ tx, viewer }) =>
    clearOrganisationSetting(tx, viewer.authUserId, {
      organisationId: str(formData, 'organisationId'),
      key: str(formData, 'key'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath(`/platform/customers/${slug}`);
  return result;
}
