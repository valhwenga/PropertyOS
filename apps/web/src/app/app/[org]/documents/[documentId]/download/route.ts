import { NextResponse } from 'next/server';
import { authoriseDownload, DomainError } from '@propertyos/domain';
import { resolveStorageAdapter } from '@propertyos/integrations';
import { getViewer, readAs } from '@/lib/auth';
import { log } from '@/lib/logger';

/**
 * Authorised download of a private document.
 *
 * Order matters and is deliberate:
 *   1. the caller's identity comes from the signed session;
 *   2. `authoriseDownload` runs under their own RLS context, so a document they
 *      cannot see produces the same "not found" as one that does not exist;
 *   3. it records the access grant in the same transaction;
 *   4. only then is a short-lived signed URL minted.
 *
 * There is no path that mints a URL first and checks afterwards.
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
    const grant = await readAs(viewer, (tx) =>
      authoriseDownload(tx, organisation.id, viewer.authUserId, {
        documentId, reason, ttlSeconds: 300,
      }),
    );

    const storage = resolveStorageAdapter();
    const signed = await storage.signedDownload({ key: grant.storageKey, ttlSeconds: 300 });

    log('info', 'document download authorised', {
      organisationId: organisation.id, documentId, actor: viewer.authUserId,
    });

    // 302 to a URL that expires in five minutes, with no caching anywhere.
    return NextResponse.redirect(signed.url, {
      status: 302,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === 'not_found') return new NextResponse('Not found', { status: 404 });
      if (error.code === 'forbidden') return new NextResponse(error.message, { status: 403 });
    }
    log('error', 'document download failed', {
      organisationId: organisation.id, documentId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return new NextResponse('Could not prepare this download.', { status: 500 });
  }
}
