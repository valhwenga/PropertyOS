'use server';

import { revalidatePath } from 'next/cache';
import {
  addSystemLeaseTemplateVersion, createSystemLeaseTemplate, publishSystemLeaseTemplate,
} from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Spike publishes a lease template for every customer.
 *
 * RLS is the real guard: the write policies on system_lease_templates require
 * app.is_platform_operator(), so a customer operator reaching this action gets
 * nothing even if they bypass the interface.
 */
export async function createSystemTemplateAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    createSystemLeaseTemplate(tx, viewer.authUserId, {
      name: String(formData.get('name') ?? ''),
      provenance: String(formData.get('provenance') ?? ''),
      summary: String(formData.get('summary') ?? ''),
      body: String(formData.get('body') ?? ''),
    }),
  );
  if (result.ok) revalidatePath('/platform/lease-templates');
  return result;
}

export async function addSystemTemplateVersionAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    addSystemLeaseTemplateVersion(tx, viewer.authUserId, {
      templateId: String(formData.get('templateId') ?? ''),
      body: String(formData.get('body') ?? ''),
    }),
  );
  if (result.ok) revalidatePath('/platform/lease-templates');
  return result;
}

export async function publishSystemTemplateAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    publishSystemLeaseTemplate(tx, viewer.authUserId, {
      templateId: String(formData.get('templateId') ?? ''),
    }),
  );
  if (result.ok) revalidatePath('/platform/lease-templates');
  return result;
}
