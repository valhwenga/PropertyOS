import { NextResponse } from 'next/server';
import { formatMinor, formatMoney, requirePermission, toCsv } from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';
import { loadBillingRun } from '@/lib/operations-queries';

/**
 * The batch summary for a posted billing run.
 *
 * §15 lists this among what billing needs, and §31 is why: when an operator
 * reconciles a month with their accountant, "what did we bill, to whom, and
 * when" has to leave the product as a file. It runs under the caller's own RLS
 * context, so the export describes exactly the scope its requester can see —
 * a billing export is private financial data in its own right.
 *
 * Only a posted run has a summary. A preview is not a batch, and exporting one
 * as though it were invites it being filed as a record of charges that were
 * never raised.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ org: string; runId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { org, runId } = await context.params;
  const organisation = viewer.organisations.find((o) => o.slug === org);
  if (!organisation) return new NextResponse('Not found', { status: 404 });

  const result = await readAs(viewer, async (tx) => {
    await requirePermission(tx, organisation.id, 'report.read');
    const detail = await loadBillingRun(tx, organisation.id, runId);
    if (!detail) return undefined;
    return detail;
  });
  if (!result) return new NextResponse('Not found', { status: 404 });

  const { run, documents } = result;
  if (run.status !== 'posted') {
    return new NextResponse(
      'This run has not been posted, so it has no batch summary. '
        + 'A preview is not a record of charges raised.',
      { status: 409 },
    );
  }

  const currency = documents[0]?.currency_code ?? organisation.currencyCode;
  const total = documents.reduce((sum, d) => sum + BigInt(d.total_minor), 0n);

  const csv = toCsv(
    {
      name: `Billing batch summary ${run.period_start.slice(0, 7)}`,
      generatedAt: new Date().toISOString(),
      filters: { periodStart: run.period_start, periodEnd: run.period_end },
      currencyCode: currency,
      qualifications: [
        `Billing run ${runId}, preview version ${run.preview_version}.`,
        `Prepared by ${run.created_by_name ?? 'unknown'} on ${run.created_at}.`,
        `Posted by ${run.posted_by_name ?? 'unknown'} on ${run.posted_at ?? 'unknown'}.`,
        `${documents.length} charge documents totalling ${formatMoney(total, currency)}.`,
        'Within the requester\'s own scope: another operator may see a different set.',
        'Posted charges are immutable. A correction appears as a separate credit note, '
          + 'not as a change to the figures here.',
      ],
    },
    [
      { key: 'documentNumber', label: 'Document' },
      { key: 'leaseReference', label: 'Lease' },
      { key: 'residentName', label: 'Resident' },
      { key: 'unitLabel', label: 'Unit' },
      { key: 'issueDate', label: 'Issued' },
      { key: 'dueDate', label: 'Due' },
      { key: 'amount', label: 'Amount' },
    ],
    documents.map((d) => ({
      documentNumber: d.document_number,
      leaseReference: d.lease_reference,
      residentName: d.resident_name ?? '',
      unitLabel: d.unit_label,
      issueDate: d.issue_date,
      dueDate: d.due_date,
      amount: formatMinor(BigInt(d.total_minor), d.currency_code),
    })),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition':
        `attachment; filename="billing-${run.period_start.slice(0, 7)}-${runId.slice(0, 8)}.csv"`,
      // A financial export is private data: never cached by a shared proxy.
      'Cache-Control': 'no-store, private',
    },
  });
}
