import { NextResponse } from 'next/server';
import { buildStatement, DomainError, renderStatementPdf } from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

/**
 * The resident's own statement as a PDF.
 *
 * The lease is resolved from the viewer's OWN portal links, so changing the id
 * in the URL cannot reach another household's statement. The contact details
 * come from the organisation, because a statement a resident keeps is useless
 * if it does not say who to ask about it.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ leaseId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { leaseId } = await context.params;
  const link = viewer.residentLeases.find((l) => l.leaseId === leaseId);
  if (!link) return new NextResponse('Not found', { status: 404 });

  const cutOff = new URL(request.url).searchParams.get('cutOff')
    ?? new Date().toISOString().slice(0, 10);

  try {
    const { statement, pdf } = await readAs(viewer, async (tx) => {
      const built = await buildStatement(tx, link.organisationId, { leaseId, cutOff });
      const [detail] = await tx<
        { property_label: string; organisation_name: string; resident_name: string | null }[]
      >`
        select p.name || ' / ' || u.code as property_label,
               o.name as organisation_name,
               (rp.first_name || ' ' || rp.last_name) as resident_name
        from leases l
        join properties p on p.id = l.property_id
        join units u on u.id = l.unit_id
        join organisations o on o.id = l.organisation_id
        left join lease_parties lp on lp.lease_id = l.id
          and lp.role = 'primary_resident' and lp.removed_on is null
        left join resident_profiles rp on rp.id = lp.resident_id
        where l.id = ${leaseId}::uuid
      `;
      return {
        statement: built,
        pdf: renderStatementPdf(built, {
          organisationName: detail?.organisation_name ?? 'Your landlord',
          propertyLabel: detail?.property_label ?? 'Your home',
          residentName: detail?.resident_name ?? viewer.fullName,
        }),
      };
    });

    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          `attachment; filename="statement-${statement.leaseReference}-${cutOff}.pdf"`,
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
