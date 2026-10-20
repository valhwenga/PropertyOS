import { NextResponse } from 'next/server';
import {
  DomainError, getBranding, getLogo, loadDepositStatementForOperator,
  loadLandlordIdentity, renderDepositStatementPdf,
} from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

/**
 * The deposit statement an operator hands over at the end of a lease.
 *
 * The same document the tenant can download, so neither side is working from
 * a different list of deductions.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ org: string; leaseId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { org, leaseId } = await context.params;
  const organisation = viewer.organisations.find((o) => o.slug === org);
  if (!organisation) return new NextResponse('Not found', { status: 404 });

  try {
    const { statement, pdf } = await readAs(viewer, async (tx) => {
      const loaded = await loadDepositStatementForOperator(tx, organisation.id, leaseId);
      const [branding, logo, landlord] = await Promise.all([
        getBranding(tx, organisation.id),
        getLogo(tx, organisation.id),
        loadLandlordIdentity(tx, organisation.id),
      ]);
      return {
        statement: loaded,
        pdf: renderDepositStatementPdf(loaded, {
          landlord,
          accent: branding.accent,
          logo: logo?.bytes ?? null,
        }),
      };
    });

    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          `attachment; filename="deposit-${statement.leaseReference}.pdf"`,
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'not_found') {
      return new NextResponse('Not found', { status: 404 });
    }
    throw error;
  }
}
