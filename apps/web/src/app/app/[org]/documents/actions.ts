'use server';

import { revalidatePath } from 'next/cache';
import {
  DomainError, registerDocument, shareDocument, sha256,
  type DocumentVisibility,
} from '@propertyos/domain';
import {
  resolveStorageAdapter, scanDocument, validateUpload, DOCUMENT_CONSTRAINTS,
} from '@propertyos/integrations';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';
import { log } from '@/lib/logger';

/**
 * Uploads a private document.
 *
 * The order is the security property:
 *   1. validate type, size and magic bytes BEFORE anything is stored;
 *   2. scan the bytes;
 *   3. store the object;
 *   4. register the row, quarantined unless the scanner returned clean.
 *
 * If the scan cannot complete, the file is still stored but stays quarantined
 * and unshareable. We never record a file as clean because the scanner was
 * unavailable.
 */
export async function uploadDocument(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const file = formData.get('file');
  const title = String(formData.get('title') ?? '').trim();
  const classification = String(formData.get('classification') ?? 'other');
  const leaseId = String(formData.get('leaseId') ?? '').trim() || undefined;
  const propertyId = String(formData.get('propertyId') ?? '').trim() || undefined;

  return command(async ({ tx, viewer, correlationId }) => {
    const context = await requireOperator(org);

    if (!(file instanceof File) || file.size === 0) {
      throw new DomainError('validation_failed', 'Choose a file to upload.');
    }
    if (file.size > DOCUMENT_CONSTRAINTS.maxBytes) {
      throw new DomainError(
        'validation_failed',
        `That file is larger than the ${DOCUMENT_CONSTRAINTS.maxBytes / (1024 * 1024)} MB limit.`,
      );
    }

    const body = new Uint8Array(await file.arrayBuffer());

    const validation = validateUpload({
      filename: file.name,
      declaredContentType: file.type || 'application/octet-stream',
      byteSize: body.byteLength,
      head: body.subarray(0, 16),
    });
    if (!validation.ok) {
      log('warn', 'upload rejected', {
        organisationId: context.organisationId, correlationId, reason: validation.reason,
      });
      throw new DomainError('validation_failed', validation.reason ?? 'That file was not accepted.');
    }

    const scan = await scanDocument({ bucket: 'propertyos-private', key: file.name, body });
    if (scan.status === 'infected') {
      // Never stored at all.
      log('warn', 'upload flagged as malicious', {
        organisationId: context.organisationId, correlationId,
      });
      throw new DomainError('forbidden', 'That file was flagged as malicious and has not been stored.');
    }

    const registered = await registerDocument(
      tx, context.organisationId, viewer.authUserId,
      {
        classification: classification as 'lease',
        title: title || file.name,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        byteSize: body.byteLength,
        contentSha256: sha256(body),
        leaseId, propertyId,
      },
      { status: scan.status, detail: 'detail' in scan ? scan.detail : undefined },
    );

    const storage = resolveStorageAdapter();
    await storage.put({
      key: registered.storageKey,
      body,
      contentType: file.type || 'application/octet-stream',
    });

    revalidatePath(`/app/${org}/documents`);
    return {
      documentId: registered.documentId,
      quarantined: registered.quarantined,
      scanStatus: scan.status,
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
