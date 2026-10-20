import { NextResponse } from 'next/server';
import {
  DomainError, getBrandingForLease, getLogoForLease, loadInvoiceForResident, renderInvoicePdf,
} from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

/**
 * The tenant's own copy of an invoice.
 *
 * The lease comes from the viewer's OWN portal links, and the document must
 * belong to that lease, so changing either id in the URL reaches nothing. It
 * renders in the landlord's chosen design, because a tenant comparing the
 * document they downloaded with the one they were emailed should find the same
 * document.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ leaseId: string; documentId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { leaseId, documentId } = await context.params;
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    const { invoice, pdf } = await readAs(viewer, async (tx) => {
      const loaded = await loadInvoiceForResident(tx, leaseId, documentId);
      const [branding, logo] = await Promise.all([
        getBrandingForLease(tx, leaseId),
        getLogoForLease(tx, leaseId),
      ]);
      return {
        invoice: loaded,
        pdf: renderInvoicePdf(loaded, {
          template: branding.invoiceTemplate,
          accent: branding.accent,
          logo: logo?.bytes ?? null,
        }),
      };
    });

    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="invoice-${invoice.documentNumber}.pdf"`,
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
