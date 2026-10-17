import { NextResponse } from 'next/server';
import { authoriseDownload, DomainError } from '@propertyos/domain';
import { resolveStorageAdapter } from '@propertyos/integrations';
import { getViewer, readAs } from '@/lib/auth';
import { log } from '@/lib/logger';

/**
 * A resident downloading a document their landlord shared with them.
 *
 * The portal has listed these documents and linked to this path since the
 * portal was built, and the route did not exist: every "your documents" link
 * answered 404. The link checker never found it because it signs in as an
 * operator, and an operator never sees this page.
 *
 * The order is the same as the operator's download, and for the same reasons:
 *   1. identity from the signed session;
 *   2. the lease is matched against the viewer's OWN portal links, so another
 *      lease's id in the URL resolves to nothing;
 *   3. `authoriseDownload` runs under the resident's own RLS context, which
 *      filters a document that is not shared with them to "not found";
 *   4. the access is recorded in the same transaction;
 *   5. only then is a short-lived signed URL minted.
 *
 * The extra check here is the lease. A resident with two tenancies must not be
 * able to read the other landlord's document by pairing their own lease id
 * with a document id they guessed, so the document must belong to the lease in
 * the path as well as being visible to them.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ leaseId: string; documentId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { leaseId, documentId } = await context.params;
  const link = viewer.residentLeases.find((l) => l.leaseId === leaseId);
  if (!link) return new NextResponse('Not found', { status: 404 });

  try {
    const grant = await readAs(viewer, async (tx) => {
      const [document] = await tx<{ id: string }[]>`
        select id from documents
        where id = ${documentId}::uuid
          and lease_id = ${leaseId}::uuid
          and visibility = 'resident_shared'
          and quarantined = false
          and deleted_at is null
      `;
      if (!document) throw new DomainError('not_found', 'Document');
      return authoriseDownload(tx, link.organisationId, viewer.authUserId, {
        documentId,
        reason: 'Resident portal download',
        ttlSeconds: 300,
      });
    });

    const storage = resolveStorageAdapter();
    const signed = await storage.signedDownload({ key: grant.storageKey, ttlSeconds: 300 });

    log('info', 'resident document download authorised', {
      organisationId: link.organisationId, documentId, actor: viewer.authUserId,
    });

    return NextResponse.redirect(signed.url, {
      status: 302,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === 'not_found') return new NextResponse('Not found', { status: 404 });
      if (error.code === 'forbidden') return new NextResponse(error.message, { status: 403 });
    }
    log('error', 'resident document download failed', {
      organisationId: link.organisationId, documentId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return new NextResponse('Could not prepare this download.', { status: 500 });
  }
}
