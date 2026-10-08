import { NextResponse } from 'next/server';
import { authoriseDownload, DomainError } from '@propertyos/domain';
import { resolveStorageAdapter } from '@propertyos/integrations';
import { getViewer, readAs } from '@/lib/auth';
import { log } from '@/lib/logger';

/**
 * Shows a PropertyOS-generated PDF in the browser instead of handing it over as
 * a file.
 *
 * This exists because a lease agreement that can only be downloaded cannot be
 * checked before it is sent, and sending the wrong agreement to a tenant is not
 * a mistake you can take back.
 *
 * It is a SEPARATE route from the download, not a flag on it, so that the
 * download's rule — every file leaves as an attachment of type
 * application/octet-stream, never rendered in this origin — stays
 * unconditionally true for anything a person uploaded. What may be rendered here
 * is decided in `authoriseDownload({ inline: true })`: a PDF whose bytes
 * PropertyOS itself rendered, and nothing else.
 *
 * The bytes are read server-side and returned from here rather than redirecting
 * to a signed storage URL, because the signed URL exists to serve attachments
 * and carries the headers for that.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ org: string; documentId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { org, documentId } = await context.params;
  const organisation = viewer.organisations.find((o) => o.slug === org);
  if (!organisation) return new NextResponse('Not found', { status: 404 });

  const reason = new URL(request.url).searchParams.get('reason') ?? undefined;

  try {
    // Authorised and audited exactly as a download is, under the caller's own
    // RLS context, before a single byte is read.
    const grant = await readAs(viewer, (tx) =>
      authoriseDownload(tx, organisation.id, viewer.authUserId, {
        documentId, reason, ttlSeconds: 300, inline: true,
      }),
    );

    const bytes = await resolveStorageAdapter().get(grant.storageKey);

    log('info', 'document preview authorised', {
      organisationId: organisation.id, documentId, actor: viewer.authUserId,
    });

    return new NextResponse(bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        // `inline` is the whole point, but the filename still travels with it so
        // that saving from the browser's own viewer produces a sensible name.
        'Content-Disposition': `inline; filename="${
          grant.title.replace(/[^\w.\- ]/g, '_').slice(0, 120)}.pdf"`,
        // The narrow Content-Security-Policy for this path is set in
        // next.config.ts, NOT here: a header from `headers()` wins over one set
        // on the response, so setting it here would look like protection while
        // the app-wide policy was the one actually sent.
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store, private',
      },
    });
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === 'not_found') return new NextResponse('Not found', { status: 404 });
      if (error.code === 'forbidden') return new NextResponse(error.message, { status: 403 });
    }
    log('error', 'document preview failed', {
      organisationId: organisation.id, documentId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return new NextResponse('Could not show this document.', { status: 500 });
  }
}
