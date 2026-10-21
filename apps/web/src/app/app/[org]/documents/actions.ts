'use server';

import { revalidatePath } from 'next/cache';
import { shareDocument, type DocumentVisibility } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';
import { storeUpload } from '@/lib/uploads';

/**
 * Uploads a private document.
 *
 * The validate-scan-store-register order lives in `storeUpload`, shared with
 * the resident's photograph of a leak and the inspector's photograph of a
 * scratch — three copies of a security-critical order is three places for it
 * to drift.
 */
export async function uploadDocument(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));

  return command(async ({ tx, viewer, correlationId }) => {
    const context = await requireOperator(org);
    const stored = await storeUpload(tx, {
      organisationId: context.organisationId,
      actorUserId: viewer.authUserId,
      file: formData.get('file'),
      classification: String(formData.get('classification') ?? 'other'),
      title: String(formData.get('title') ?? ''),
      leaseId: String(formData.get('leaseId') ?? '').trim() || undefined,
      propertyId: String(formData.get('propertyId') ?? '').trim() || undefined,
      correlationId,
    });

    revalidatePath(`/app/${org}/documents`);
    return {
      documentId: stored.documentId,
      quarantined: stored.quarantined,
      scanStatus: stored.scanStatus,
    };
  });
}

export async function shareDocumentAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const documentId = String(formData.get('documentId'));
  const visibility = String(formData.get('visibility')) as DocumentVisibility;

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await shareDocument(tx, context.organisationId, viewer.authUserId, { documentId, visibility });
    return { visibility };
  });
  if (result.ok) revalidatePath(`/app/${org}/documents`);
  return result;
}
