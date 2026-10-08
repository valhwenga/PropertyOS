'use server';

import { revalidatePath } from 'next/cache';
import {
  adoptSystemTemplate, createLeaseTemplate, publishLeaseTemplateVersion, saveLeaseTemplateDraft, saveOrganisationProfile,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

export async function createTemplateAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return createLeaseTemplate(tx, context.organisationId, viewer.authUserId, {
      name: String(formData.get('name') ?? ''),
      layout: String(formData.get('layout') ?? 'inline') as 'schedule' | 'inline',
      sourceNote: String(formData.get('sourceNote') ?? '').trim() || undefined,
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/lease-templates`);
  return result;
}

export async function saveDraftAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const templateId = String(formData.get('templateId'));
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return saveLeaseTemplateDraft(tx, context.organisationId, viewer.authUserId, {
      templateId,
      body: String(formData.get('body') ?? ''),
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/lease-templates/${templateId}`);
  return result;
}

export async function publishVersionAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const templateId = String(formData.get('templateId'));
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return publishLeaseTemplateVersion(tx, context.organisationId, viewer.authUserId, {
      templateId,
      versionId: String(formData.get('versionId')),
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/lease-templates/${templateId}`);
  return result;
}

export async function saveOrganisationProfileAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const text = (key: string) => String(formData.get(key) ?? '').trim() || undefined;
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await saveOrganisationProfile(tx, context.organisationId, viewer.authUserId, {
      legalName: text('legalName'), tradingName: text('tradingName'),
      registrationNumber: text('registrationNumber'), vatNumber: text('vatNumber'),
      identityNumber: text('identityNumber'),
      physicalAddress: text('physicalAddress'), postalAddress: text('postalAddress'),
      phone: text('phone'), email: text('email'),
      nextOfKinName: text('nextOfKinName'), nextOfKinPhone: text('nextOfKinPhone'),
      agentName: text('agentName'), agentContact: text('agentContact'),
      agentRegistrationNumber: text('agentRegistrationNumber'),
      agentPractitioner: text('agentPractitioner'),
      agentCertificateNumber: text('agentCertificateNumber'),
    });
    return { saved: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/landlord`);
  return result;
}

/**
 * Takes a copy of a Spike-provided template into this organisation.
 *
 * It becomes an ordinary draft of theirs. A later change by Spike never reaches
 * wording a landlord has already adopted, which on a signed lease would be
 * indefensible.
 */
export async function adoptSystemTemplateAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const systemTemplateId = String(formData.get('systemTemplateId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return adoptSystemTemplate(tx, context.organisationId, viewer.authUserId, { systemTemplateId });
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/lease-templates`);
  return result;
}
