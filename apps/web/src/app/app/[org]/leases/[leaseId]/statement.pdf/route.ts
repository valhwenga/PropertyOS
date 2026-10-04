import { NextResponse } from 'next/server';
import { buildStatement, DomainError, renderStatementPdf } from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

/**
 * Operator view of a resident statement as a PDF.
 *
 * Built from exactly the Statement that `buildStatement` returned, under the
 * caller's own RLS context. There is no second query, so the PDF cannot
 * disagree with the screen, and a lease the caller cannot see produces the same
 * "not found" as one that does not exist.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ org: string; leaseId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { org, leaseId } = await context.params;
  const organisation = viewer.organisations.find((o) => o.slug === org);
  if (!organisation) return new NextResponse('Not found', { status: 404 });

  const cutOff = new URL(request.url).searchParams.get('cutOff')
    ?? new Date().toISOString().slice(0, 10);

  try {
    const { statement, pdf } = await readAs(viewer, async (tx) => {
      const built = await buildStatement(tx, organisation.id, { leaseId, cutOff });
      const [detail] = await tx<
        { property_label: string; resident_name: string | null }[]
      >`
        select p.name || ' / ' || u.code as property_label,
               (rp.first_name || ' ' || rp.last_name) as resident_name
        from leases l
        join properties p on p.id = l.property_id
        join units u on u.id = l.unit_id
        left join lease_parties lp on lp.lease_id = l.id
          and lp.role = 'primary_resident' and lp.removed_on is null
        left join resident_profiles rp on rp.id = lp.resident_id
        where l.id = ${leaseId}::uuid
      `;
      return {
        statement: built,
        pdf: renderStatementPdf(built, {
          organisationName: organisation.name,
          propertyLabel: detail?.property_label ?? 'Property',
          residentName: detail?.resident_name ?? 'Resident',
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
