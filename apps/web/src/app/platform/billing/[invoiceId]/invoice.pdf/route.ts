import { NextResponse } from 'next/server';
import {
  billerForInvoice, renderSubscriptionInvoicePdf, subscriptionInvoiceById,
} from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

/**
 * The same document, from Spike's side.
 *
 * Byte-for-byte what the customer downloads: one renderer, one read, so an
 * operator answering "what does my invoice say" is looking at the invoice the
 * customer has rather than at a reconstruction of it.
 *
 * `isPlatformOperator` is checked here as well as by the policies. A platform
 * operator's own row-level security admits them to `subscription_invoices`;
 * this stops somebody who is not one from reaching the route at all, which is
 * the same thing the console's layout does for the pages.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ invoiceId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });
  if (!viewer.isPlatformOperator) return new NextResponse('Not found', { status: 404 });

  const { invoiceId } = await context.params;
  const result = await readAs(viewer, async (tx) => {
    const invoice = await subscriptionInvoiceById(tx, invoiceId);
    if (!invoice) return null;
    const biller = await billerForInvoice(tx);
    return {
      invoice,
      pdf: renderSubscriptionInvoicePdf(invoice, {
        legalName: biller?.legalName ?? null,
        address: biller?.address ?? null,
        email: biller?.email ?? null,
        vatNumber: biller?.vatNumber ?? null,
        bankDetails: biller?.bankDetails ?? null,
      }),
    };
  });
  if (!result) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(result.pdf as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${result.invoice.invoiceNumber}.pdf"`,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
