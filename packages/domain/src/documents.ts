import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import { requirePermission } from './permissions';

export type DocumentVisibility = 'internal' | 'resident_shared' | 'contractor_shared' | 'owner_shared';
export type ScanStatus =
  | 'pending'
  | 'skipped_not_configured'
  | 'clean'
  | 'infected'
  | 'failed'
  // Bytes PropertyOS authored itself, such as a generated lease agreement.
  // Not scanned, because a scanner is for untrusted input and this is not any.
  | 'system_generated';

export const registerDocumentSchema = z.object({
  classification: z.enum([
    'lease', 'identity', 'proof_of_payment', 'invoice', 'inspection',
    'maintenance', 'deposit_evidence', 'statement_export', 'other',
  ]),
  title: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(3).max(120),
  byteSize: z.number().int().positive(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  propertyId: z.string().uuid().optional(),
  leaseId: z.string().uuid().optional(),
  residentId: z.string().uuid().optional(),
});

/**
 * Builds the object key for a private bucket.
 *
 * The key is namespaced by organisation and carries random entropy, so it is
 * neither guessable nor enumerable. It is NOT a security control on its own —
 * access is decided by a permission check before any URL is minted — but it
 * removes the "someone shared the path" failure mode.
 */
export function buildStorageKey(organisationId: string, classification: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
  return `${organisationId}/${classification}/${randomBytes(16).toString('hex')}/${safe}`;
}

export function sha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Registers an uploaded document.
 *
 * It is created QUARANTINED and `internal` regardless of what the caller asked
 * for. Sharing is a separate, explicit step that can only succeed once the file
 * has cleared quarantine — and the database check constraint
 * `documents_quarantine_not_shared` rejects the combination even if this code
 * were wrong.
 */
export async function registerDocument(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof registerDocumentSchema>,
  scan: { status: ScanStatus; detail?: string },
): Promise<{ documentId: string; storageKey: string; quarantined: boolean }> {
  await requirePermission(tx, organisationId, 'document.manage');
  const d = registerDocumentSchema.parse(input);

  const storageKey = buildStorageKey(organisationId, d.classification, d.filename);
  // Only a clean result from a real scanner releases an UPLOAD from quarantine.
  // A document the system generated was never untrusted input, so it is not held;
  // it carries its own status rather than borrowing 'clean' from a scan that
  // never ran.
  const quarantined = scan.status !== 'clean' && scan.status !== 'system_generated';

  try {
    const [doc] = await tx<{ id: string }[]>`
      insert into documents (
        organisation_id, classification, title, storage_key, content_type, byte_size,
        content_sha256, visibility, property_id, lease_id, resident_id,
        scan_status, scan_detail, scanned_at, quarantined, uploaded_by
      ) values (
        ${organisationId}, ${d.classification}, ${d.title}, ${storageKey},
        ${d.contentType}, ${d.byteSize},
        ${d.contentSha256 ? tx`decode(${d.contentSha256}, 'hex')` : null},
        'internal', ${d.propertyId ?? null}, ${d.leaseId ?? null}, ${d.residentId ?? null},
        ${scan.status}, ${scan.detail ?? null},
        ${scan.status === 'pending' ? null : tx`now()`},
        ${quarantined}, ${actorUserId}
      )
      returning id
    `;
    if (!doc) throw new DomainError('internal', 'Document insert returned no row.');

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'document.registered', resourceType: 'document', resourceId: doc.id,
      // The storage key is redacted by recordAudit; the title and size are not sensitive.
      after: {
        classification: d.classification, title: d.title,
        byteSize: d.byteSize, scanStatus: scan.status, quarantined,
      },
    });

    return { documentId: doc.id, storageKey, quarantined };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Shares a document with an audience.
 *
 * Refuses while the file is quarantined or its scan says infected. The database
 * would refuse too; this produces the readable reason.
 */
export async function shareDocument(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { documentId: string; visibility: DocumentVisibility },
): Promise<void> {
  await requirePermission(tx, organisationId, 'document.manage');

  const [doc] = await tx<
    { id: string; quarantined: boolean; scan_status: ScanStatus; scan_detail: string | null;
      visibility: string; lease_id: string | null }[]
  >`
    select id, quarantined, scan_status, scan_detail, visibility::text, lease_id
    from documents
    where id = ${params.documentId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!doc) throw notFound('Document');

  if (params.visibility !== 'internal') {
    if (doc.scan_status === 'infected') {
      throw new DomainError('forbidden', 'This file was flagged as malicious and cannot be shared.');
    }
    if (doc.quarantined) {
      throw new DomainError(
        'forbidden',
        'This file is still quarantined and cannot be shared. ' +
          (doc.scan_detail ?? 'It has not been confirmed clean by a malware scanner.'),
      );
    }
    if (params.visibility === 'resident_shared' && !doc.lease_id) {
      throw invalid('A document can only be shared with a resident when it is linked to a lease.');
    }
  }

  await tx`
    update documents set visibility = ${params.visibility}
    where id = ${params.documentId}::uuid and organisation_id = ${organisationId}::uuid
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'document.shared', resourceType: 'document', resourceId: params.documentId,
    before: { visibility: doc.visibility }, after: { visibility: params.visibility },
  });
}

/**
 * Authorises a download and records the grant.
 *
 * The permission check happens HERE, under the caller's own RLS context: if the
 * select returns nothing, the caller cannot see the document and gets the same
 * "not found" as for a document that does not exist. Only then is a short lived
 * signed URL minted by the storage adapter.
 */
export async function authoriseDownload(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { documentId: string; reason?: string; ttlSeconds?: number },
): Promise<{ storageBucket: string; storageKey: string; expiresAt: Date }> {
  const ttl = Math.min(params.ttlSeconds ?? 300, 900);

  const [doc] = await tx<
    { id: string; storage_bucket: string; storage_key: string; classification: string;
      quarantined: boolean; scan_status: string; deleted_at: string | null }[]
  >`
    select id, storage_bucket, storage_key, classification, quarantined,
           scan_status::text, deleted_at
    from documents
    where id = ${params.documentId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  // RLS already filtered by audience and scope. A miss is indistinguishable from
  // a document that does not exist.
  if (!doc || doc.deleted_at) throw notFound('Document');

  if (doc.quarantined || doc.scan_status === 'infected') {
    throw new DomainError(
      'forbidden',
      'This file has not cleared quarantine and cannot be downloaded.',
    );
  }

  // Identity documents need their own permission, separate from ordinary
  // document access.
  if (doc.classification === 'identity') {
    await requirePermission(tx, organisationId, 'document.identity.read');
  }

  const expiresAt = new Date(Date.now() + ttl * 1000);
  await tx`
    insert into document_access_grants (
      organisation_id, document_id, granted_to, expires_at, reason
    ) values (
      ${organisationId}, ${params.documentId}, ${actorUserId},
      ${expiresAt.toISOString()}, ${params.reason ?? null}
    )
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'document.downloaded', resourceType: 'document', resourceId: params.documentId,
    reason: params.reason ?? null,
  });

  return { storageBucket: doc.storage_bucket, storageKey: doc.storage_key, expiresAt };
}
