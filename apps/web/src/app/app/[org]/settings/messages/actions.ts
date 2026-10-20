'use server';

import { revalidatePath } from 'next/cache';
import { resetInvoiceMessageTemplate, setInvoiceMessageTemplate } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

export async function saveMessageAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org') ?? '');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return {
      template: await setInvoiceMessageTemplate(tx, context.organisationId, viewer.authUserId, {
        subject: String(formData.get('subject') ?? ''),
        body: String(formData.get('body') ?? ''),
      }),
    };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/messages`);
  return result;
}

export async function resetMessageAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org') ?? '');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return {
      template: await resetInvoiceMessageTemplate(tx, context.organisationId, viewer.authUserId),
    };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/messages`);
  return result;
}
