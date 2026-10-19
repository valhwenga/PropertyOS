import { NextResponse } from 'next/server';
import { getLogoForLease } from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * The landlord's logo, for a resident of this lease.
 *
 * A resident belongs to no organisation, so this cannot go through the
 * branding table's own policy; it goes through `app.resident_logo`, which
 * checks that the caller can access this lease before it returns anything. A
 * lease that is not theirs produces the same 404 as one that does not exist.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ leaseId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { leaseId } = await params;
  const logo = await readAs(viewer, (tx) => getLogoForLease(tx, leaseId));
  if (!logo) return new NextResponse('No logo', { status: 404 });

  return new NextResponse(Buffer.from(logo.bytes) as unknown as BodyInit, {
    headers: {
      'Content-Type': logo.mime,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=300',
    },
  });
}
