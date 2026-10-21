import { NextResponse } from 'next/server';
import {
  billerForInvoice, renderSubscriptionInvoicePdf, subscriptionInvoiceById,
} from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

/**
 * The landlord's own copy of what Spike charged them.
 *
 * Read under the caller's row-level security, where the policy on
 * `subscription_invoices` is `organisation.settings.manage` — so a colleague
 * without it, and anybody from another customer, gets the same "not found" as
 * an invoice that does not exist. The slug in the URL is checked against the
 * invoice's own organisation as well: a correct id under the wrong slug is a
 * mistake worth refusing rather than quietly serving.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ org: string; invoiceId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { org, invoiceId } = await context.params;
  const organisation = viewer.organisations.find((o) => o.slug === org);
  if (!organisation) return new NextResponse('Not found', { status: 404 });

  const result = await readAs(viewer, async (tx) => {
    const invoice = await subscriptionInvoiceById(tx, invoiceId);
    if (!invoice || invoice.organisationId !== organisation.id) return null;
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
