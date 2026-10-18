import { NextResponse } from 'next/server';
import { buildCustomerExport, DomainError } from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';
import { log } from '@/lib/logger';

/**
 * The organisation's own records, as a documented archive.
 *
 * Runs under the caller's RLS context, like every other export here, so the
 * file contains exactly what that person can see and nothing more. The
 * permission check, the audit entry and the scoping all live in the domain
 * function; this route's job is to hand the bytes over with headers that stop
 * a browser treating a customer's tenancy history as something to render.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ org: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { org } = await context.params;
  const organisation = viewer.organisations.find((o) => o.slug === org);
  if (!organisation) return new NextResponse('Not found', { status: 404 });

  try {
    const archive = await readAs(viewer, (tx) =>
      buildCustomerExport(tx, organisation.id, viewer.authUserId),
    );

    log('info', 'customer export produced', {
      organisationId: organisation.id,
      byteSize: archive.bytes.length,
    });

    return new NextResponse(new Uint8Array(archive.bytes), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${archive.filename}"`,
        'Content-Length': String(archive.bytes.length),
        // Nothing about this file may be cached or sniffed into something the
        // browser will execute.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'forbidden') {
      return new NextResponse(error.message, { status: 403 });
    }
    throw error;
  }
}
