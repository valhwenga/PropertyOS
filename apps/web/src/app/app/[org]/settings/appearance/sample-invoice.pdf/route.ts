import { NextResponse } from 'next/server';
import {
  getBranding, getLogo, invoiceTemplateByKey, renderInvoicePdf, SAMPLE_INVOICE,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * A specimen invoice, for choosing a design.
 *
 * It uses invented figures and an invented tenant — showing somebody a real
 * tenant's debt in order to pick a layout would be using a person as a swatch
 * — and it is marked SAMPLE on its face. The organisation's own accent and
 * logo ARE used, because that is the part being judged.
 *
 * `?template=` lets the administrator look at a design before saving it; it is
 * validated against the list, so an unknown value draws the default rather
 * than nothing.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ org: string }> },
) {
  const { org } = await params;
  const context = await requireOperator(org);

  const asked = new URL(request.url).searchParams.get('template');
  const template = invoiceTemplateByKey(asked).key;

  const pdf = await readAs(context.viewer, async (tx) => {
    const [branding, logo] = await Promise.all([
      getBranding(tx, context.organisationId),
      getLogo(tx, context.organisationId),
    ]);
    return renderInvoicePdf(SAMPLE_INVOICE, {
      template,
      accent: branding.accent,
      logo: logo?.bytes ?? null,
      sample: true,
    });
  });

  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="sample-invoice-${template}.pdf"`,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
