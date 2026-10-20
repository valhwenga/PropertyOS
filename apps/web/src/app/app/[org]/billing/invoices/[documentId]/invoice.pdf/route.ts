import { NextResponse } from 'next/server';
import {
  DomainError, getBranding, getLogo, loadInvoiceForOperator, renderInvoicePdf,
} from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

/**
 * An invoice, as the landlord's own document.
 *
 * Read under the caller's own row-level security and scoped to the slug in the
 * URL as well, so a document id belonging to another customer produces the
 * same "not found" as one that does not exist. The design, the accent and the
 * logo are the organisation's own, so the operator downloads exactly what
 * their tenant will.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ org: string; documentId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { org, documentId } = await context.params;
  const organisation = viewer.organisations.find((o) => o.slug === org);
  if (!organisation) return new NextResponse('Not found', { status: 404 });

  try {
    const { invoice, pdf } = await readAs(viewer, async (tx) => {
      const loaded = await loadInvoiceForOperator(tx, organisation.id, documentId);
      const [branding, logo] = await Promise.all([
        getBranding(tx, organisation.id),
        getLogo(tx, organisation.id),
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
