import { NextResponse } from 'next/server';
import { authoriseDownload, DomainError } from '@propertyos/domain';
import { resolveStorageAdapter } from '@propertyos/integrations';
import { getViewer, readAs } from '@/lib/auth';
import { log } from '@/lib/logger';

/**
 * A photograph attached to the resident's own maintenance request.
 *
 * The same order as every other authorised download, with one extra link in
 * the chain: the document must be attached to THIS ticket, marked for the
 * resident audience, and the ticket must be on a lease this viewer holds a
 * portal link to. A document id guessed into the URL fails the first of those.
 *
 * It is a download, never an inline render: `authoriseDownload` allows inline
 * only for a PDF PropertyOS itself generated, because an uploaded file
 * rendered inside the app's origin is a different risk from one handed over.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ leaseId: string; ticketId: string; documentId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { leaseId, ticketId, documentId } = await context.params;
  const link = viewer.residentLeases.find((l) => l.leaseId === leaseId);
  if (!link) return new NextResponse('Not found', { status: 404 });

  try {
    const grant = await readAs(viewer, async (tx) => {
      const [attachment] = await tx<{ id: string }[]>`
        select a.id
        from maintenance_attachments a
        join maintenance_tickets t on t.id = a.ticket_id
        join documents d on d.id = a.document_id
        where a.document_id = ${documentId}::uuid
          and a.ticket_id = ${ticketId}::uuid
          and t.lease_id = ${leaseId}::uuid
          and a.audience = 'resident_visible'
          and d.deleted_at is null
          and d.quarantined = false
      `;
      if (!attachment) throw new DomainError('not_found', 'Photograph');
      return authoriseDownload(tx, link.organisationId, viewer.authUserId, {
        documentId,
        reason: 'Resident portal maintenance photograph',
        ttlSeconds: 300,
      });
    });

    const storage = resolveStorageAdapter();
    const signed = await storage.signedDownload({ key: grant.storageKey, ttlSeconds: 300 });

    log('info', 'resident photograph download authorised', {
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
    log('error', 'resident photograph download failed', {
      organisationId: link.organisationId, documentId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return new NextResponse('Could not prepare this download.', { status: 500 });
  }
}
