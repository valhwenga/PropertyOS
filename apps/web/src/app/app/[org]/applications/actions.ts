'use server';

import { revalidatePath } from 'next/cache';
import {
  createApplicationLink, decideRentalApplication, setApplicationLinkActive,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

export async function createLinkAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return createApplicationLink(tx, context.organisationId, viewer.authUserId, {
      label: String(formData.get('label') ?? ''),
      unitId: String(formData.get('unitId') ?? '') || null,
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/applications`);
  return result;
}

export async function setLinkActiveAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const active = String(formData.get('active')) === 'yes';
    await setApplicationLinkActive(tx, context.organisationId, viewer.authUserId, {
      linkId: String(formData.get('linkId')), active,
    });
    return { active };
  });
  if (result.ok) revalidatePath(`/app/${org}/applications`);
  return result;
}

export async function decideApplicationAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const status = String(formData.get('status')) as 'screening' | 'approved' | 'declined' | 'withdrawn';
    await decideRentalApplication(tx, context.organisationId, viewer.authUserId, {
      applicationId: String(formData.get('applicationId')),
      status,
      note: String(formData.get('note') ?? ''),
    });
    return { status };
  });
  if (result.ok) revalidatePath(`/app/${org}/applications`);
  return result;
}
