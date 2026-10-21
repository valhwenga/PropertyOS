import 'server-only';
import type { Sql } from '@propertyos/db';
import { DomainError, registerDocument, sha256 } from '@propertyos/domain';
import {
  DOCUMENT_CONSTRAINTS, resolveStorageAdapter, scanDocument, validateUpload,
} from '@propertyos/integrations';
import { log } from './logger';

/**
 * Taking a file from a form and storing it safely, once.
 *
 * The order is the security property and it was written out by hand in the
 * documents action; a second and third copy — for a resident's photograph of a
 * leak, and for an inspector's photograph of a scratch — is three places for
 * the order to drift:
 *
 *   1. validate the type, the size and the MAGIC BYTES before anything is
 *      stored, so a `.pdf` that is really an executable never reaches a bucket;
 *   2. scan the bytes;
 *   3. store the object;
 *   4. register the row, quarantined unless the scanner came back clean.
 *
 * A file flagged as malicious is never stored at all. A scan that cannot
 * complete leaves the file stored and quarantined: nothing here records a file
 * as clean on the strength of having tried to check it.
 *
 * Worth knowing when reading the screens: with no scanner configured every
 * upload is `skipped_not_configured`, which IS quarantined, and
 * `authoriseDownload` then refuses the file to everybody — the landlord
 * included. The screens say so in those words rather than offering a link that
 * will not work.
 */
export async function storeUpload(
  tx: Sql,
  params: {
    organisationId: string;
    actorUserId: string;
    file: unknown;
    classification: string;
    title?: string;
    leaseId?: string;
    propertyId?: string;
    /** Only images, for a photograph. Anything else is refused by name. */
    imagesOnly?: boolean;
    /**
     * The portal's path. `registerDocument` demands `document.manage`, which
     * no resident holds; with this it checks instead that the lease is theirs
     * and the classification is one a resident may upload — the same two
     * conditions the row-level policy enforces a step later.
     */
    asResident?: boolean;
    correlationId?: string;
  },
): Promise<{ documentId: string; quarantined: boolean; scanStatus: string; title: string }> {
  const { file } = params;
  if (!(file instanceof File) || file.size === 0) {
    throw new DomainError('validation_failed', 'Choose a file to upload.');
  }
  if (file.size > DOCUMENT_CONSTRAINTS.maxBytes) {
    throw new DomainError(
      'validation_failed',
      `That file is larger than the ${DOCUMENT_CONSTRAINTS.maxBytes / (1024 * 1024)} MB limit.`,
    );
  }
  const contentType = file.type || 'application/octet-stream';
  if (params.imagesOnly && !contentType.startsWith('image/')) {
    throw new DomainError(
      'validation_failed',
      'Attach a photograph — a JPEG or a PNG. For other kinds of file, use Documents.',
    );
  }

  const body = new Uint8Array(await file.arrayBuffer());

  const validation = validateUpload({
    filename: file.name,
    declaredContentType: contentType,
    byteSize: body.byteLength,
    head: body.subarray(0, 16),
  });
  if (!validation.ok) {
    log('warn', 'upload rejected', {
      organisationId: params.organisationId,
      correlationId: params.correlationId,
      reason: validation.reason,
    });
    throw new DomainError('validation_failed', validation.reason ?? 'That file was not accepted.');
  }

  const scan = await scanDocument({
    bucket: 'propertyos-private', key: file.name, body,
  });
  if (scan.status === 'infected') {
    log('warn', 'upload flagged as malicious', {
      organisationId: params.organisationId, correlationId: params.correlationId,
    });
    throw new DomainError(
      'forbidden', 'That file was flagged as malicious and has not been stored.',
    );
  }

  const title = params.title?.trim() || file.name;
  const registered = await registerDocument(
    tx, params.organisationId, params.actorUserId,
    {
      classification: params.classification as 'lease',
      title,
      filename: file.name,
      contentType,
      byteSize: body.byteLength,
      contentSha256: sha256(body),
      ...(params.leaseId ? { leaseId: params.leaseId } : {}),
      ...(params.propertyId ? { propertyId: params.propertyId } : {}),
    },
    { status: scan.status, detail: 'detail' in scan ? scan.detail : undefined },
    params.asResident ? { asResident: true } : {},
  );

  await resolveStorageAdapter().put({
    key: registered.storageKey, body, contentType,
  });

  return {
    documentId: registered.documentId,
    quarantined: registered.quarantined,
    scanStatus: scan.status,
    title,
  };
}
