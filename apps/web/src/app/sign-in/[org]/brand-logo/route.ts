import { NextResponse } from 'next/server';
import { getSignInLogo } from '@propertyos/domain';
import { withAnonymous } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * The logo on a landlord's own sign-in page.
 *
 * Served without a session, because the page it appears on is the one people
 * reach before they have one. The read goes through `app.sign_in_logo`, which
 * matches the slug and refuses a suspended or closed organisation; a slug that
 * matches nothing gives the same 404 as one with no logo, so this cannot be
 * used to enumerate customers either.
 *
 * The content type is what the database recorded when the bytes were
 * validated, never what the upload claimed, and the response is sandboxed so a
 * file that somehow got past the parser still cannot render as a document.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ org: string }> },
) {
  const { org } = await params;
  const logo = await withAnonymous((tx) => getSignInLogo(tx, org));
  if (!logo) return new NextResponse('No logo', { status: 404 });

  return new NextResponse(Buffer.from(logo.bytes) as unknown as BodyInit, {
    headers: {
      'Content-Type': logo.mime,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Public, and the same bytes the landlord publishes on their own site.
      // Short so a change to the mark appears on the sign-in page the same day.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
