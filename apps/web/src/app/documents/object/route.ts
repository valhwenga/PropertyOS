import { NextResponse } from 'next/server';
import { resolveStorageAdapter, verifyObjectToken, LocalFilesystemStorage } from '@propertyos/integrations';

/**
 * Redeems a locally signed download token.
 *
 * Only used when PropertyOS is running on filesystem storage (development, or a
 * self-hosted deployment without Supabase Storage). With Supabase Storage the
 * signed URL points at Supabase and this route is never reached.
 *
 * The token is the authorisation: it was minted only after the permission check
 * in the download route, it names one object, and it expires. This route
 * therefore verifies the signature and expiry and nothing else — it must not
 * accept a bare object key.
 */
export async function GET(request: Request) {
  const secret = process.env.SESSION_SECRET ?? '';
  if (secret.length < 32) return new NextResponse('Not available', { status: 503 });

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const expires = Number(url.searchParams.get('expires'));
  const token = url.searchParams.get('token');
  const filename = url.searchParams.get('filename') ?? 'document';

  if (!key || !token || !Number.isFinite(expires)) {
    return new NextResponse('Invalid download link', { status: 400 });
  }

  const verdict = verifyObjectToken(secret, { key, expiresUnix: expires, token });
  if (!verdict.valid) {
    return new NextResponse(
      verdict.reason === 'expired'
        ? 'This download link has expired. Open the document again to get a fresh one.'
        : 'Invalid download link',
      { status: verdict.reason === 'expired' ? 410 : 403 },
    );
  }

  const storage = resolveStorageAdapter();
  if (!(storage instanceof LocalFilesystemStorage)) {
    return new NextResponse('Not available', { status: 404 });
  }

  try {
    const body = await storage.get(key);
    return new NextResponse(body as unknown as BodyInit, {
      headers: {
        // Always an attachment and always octet-stream: never let an uploaded
        // file be rendered inline in the browser's origin.
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store, private',
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
