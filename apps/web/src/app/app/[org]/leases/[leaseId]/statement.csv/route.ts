import { NextResponse } from 'next/server';
import { buildStatement, DomainError, formatMinor } from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';

/**
 * CSV export of a lease statement.
 *
 * Runs under the caller's RLS context, so the export is subject to exactly the
 * same scope as the screen. A financial export is private data in its own right.
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
    const statement = await readAs(viewer, (tx) =>
      buildStatement(tx, organisation.id, { leaseId, cutOff }),
    );

    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const money = (v: bigint) => formatMinor(v, statement.currencyCode);
    const rows = [
      ['Lease', statement.leaseReference].map(escape).join(','),
      ['Currency', statement.currencyCode].map(escape).join(','),
      ['Cut off', statement.cutOff].map(escape).join(','),
      ['Generated at', statement.generatedAt].map(escape).join(','),
      '',
      ['Date', 'Reference', 'Description', 'Debit', 'Credit', 'Balance'].map(escape).join(','),
      ['', '', 'Opening balance', '', '', money(statement.openingBalanceMinor)].map(escape).join(','),
      ...statement.lines.map((l) =>
        [
          l.entryDate, l.reference, l.description,
          l.debitMinor > 0n ? money(l.debitMinor) : '',
          l.creditMinor > 0n ? money(l.creditMinor) : '',
          money(l.runningBalanceMinor),
        ].map(escape).join(','),
      ),
      ['', '', 'Closing receivable', '', '', money(statement.closingReceivableMinor)].map(escape).join(','),
      ['', '', 'Unapplied credit (not applied to any charge)', '', '',
        money(statement.unappliedCreditMinor)].map(escape).join(','),
      ['', '', 'Deposit held (separate liability)', '', '',
        money(statement.depositHeldMinor)].map(escape).join(','),
    ];

    return new NextResponse(rows.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="statement-${statement.leaseReference}-${cutOff}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'not_found') {
      return new NextResponse('Not found', { status: 404 });
    }
    throw error;
  }
}
