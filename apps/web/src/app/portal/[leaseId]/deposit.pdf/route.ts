import { NextResponse } from 'next/server';
import {
  DomainError, getBrandingForLease, getLogoForLease, loadDepositStatementForResident,
  loadLandlordIdentityForLease, renderDepositStatementPdf,
} from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

/**
 * The tenant's own deposit statement.
 *
 * Everything in it is their money's history: what was received, what interest
 * was credited, what was deducted and the reason recorded for it. Nothing
 * about who approved anything reaches this document — see
 * `app.resident_deposit_history`.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ leaseId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { leaseId } = await context.params;
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    const { statement, pdf } = await readAs(viewer, async (tx) => {
      const loaded = await loadDepositStatementForResident(tx, leaseId);
      const [branding, logo, landlord] = await Promise.all([
        getBrandingForLease(tx, leaseId),
        getLogoForLease(tx, leaseId),
        loadLandlordIdentityForLease(tx, leaseId),
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
