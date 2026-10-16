import { NextResponse } from 'next/server';
import { formatMinor, toCsv } from '@propertyos/domain';
import { getViewer, readAs } from '@/lib/auth';
import { loadReportPropertyChoices } from '@/lib/operations-queries';
import {
  periodLabel, REPORT_SHAPES, resolveReport, todayIn,
} from '@/lib/report-shapes';
import { runReport } from '@/lib/reports';

/**
 * CSV export for any report.
 *
 * Runs under the caller's own RLS context, so an export describes exactly the
 * scope its requester can see — a financial export is private data in its own
 * right. The report's filters and qualifications are written into the file, so
 * a figure never travels without its definition.
 *
 * It reads the query string with the SAME resolver the screen uses and runs
 * the report through the same function. Before that they were two
 * implementations of one question: the page read `from` and `to` while several
 * reports were called here with no filters at all, so a file downloaded from a
 * filtered screen could quietly contain everything. The file is the thing that
 * gets forwarded to an accountant, which makes that the worst place for the
 * two to disagree.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ org: string; report: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { org, report } = await context.params;
  const organisation = viewer.organisations.find((o) => o.slug === org);
  if (!organisation) return new NextResponse('Not found', { status: 404 });

  const shape = REPORT_SHAPES[report];
  if (!shape) return new NextResponse('Not found', { status: 404 });

  const url = new URL(request.url);
  const properties = await readAs(viewer, (tx) =>
    loadReportPropertyChoices(tx, organisation.id));
  const resolved = resolveReport(
    shape,
    {
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      asAt: url.searchParams.get('asAt') ?? undefined,
      within: url.searchParams.get('within') ?? undefined,
      property: url.searchParams.getAll('property'),
    },
    organisation.timeZone,
    new Set(properties.map((p) => p.id)),
  );
  const label = periodLabel(shape, resolved.filters, todayIn(organisation.timeZone));

  const money = (v: bigint) => formatMinor(v, organisation.currencyCode);

  // The same two sentences the screen shows, written into the file, because a
  // spreadsheet outlives the tab it came from.
  const chosen = resolved.filters.propertyIds ?? [];
  const coverage = [
    label.sentence,
    chosen.length === 0
      ? 'Every property within the scope of whoever exported this'
      : chosen
        .map((id) => properties.find((p) => p.id === id)?.name ?? id)
        .join(', '),
  ];

  const csv = await readAs(viewer, async (tx) => {
    const r = await runReport(tx, organisation.id, report, resolved.filters);
    if (!r) return null;
    switch (r.kind) {
      case 'rent-roll': {
        return toCsv(r.meta, [
          { key: 'propertyName', label: 'Property' },
          { key: 'unitCode', label: 'Unit' },
          { key: 'residentName', label: 'Resident' },
          { key: 'leaseReference', label: 'Lease' },
          { key: 'leaseStatus', label: 'Lease status' },
          { key: 'startDate', label: 'Start' },
          { key: 'endDate', label: 'End' },
          { key: 'occupied', label: 'Occupied' },
          { key: 'rent', label: 'Contracted rent' },
          { key: 'receivable', label: 'Receivable' },
        ], r.rows.map((row) => ({
          ...row,
          occupied: row.occupied ? 'yes' : 'no',
          rent: money(row.contractedRentMinor),
          receivable: money(row.receivableMinor),
        })), coverage);
      }
      case 'arrears': {
        return toCsv(r.meta, [
          { key: 'residentName', label: 'Resident' },
          { key: 'leaseReference', label: 'Lease' },
          { key: 'unitLabel', label: 'Unit' },
          { key: 'notYetDue', label: 'Not yet due' },
          { key: 'd1', label: '1-30 days' },
          { key: 'd2', label: '31-60 days' },
          { key: 'd3', label: '61-90 days' },
          { key: 'd4', label: 'Over 90 days' },
          { key: 'total', label: 'Total outstanding' },
          { key: 'disputed', label: 'Disputed' },
        ], r.rows.map((row) => ({
          ...row,
          notYetDue: money(row.notYetDueMinor),
          d1: money(row.days1to30Minor), d2: money(row.days31to60Minor),
          d3: money(row.days61to90Minor), d4: money(row.daysOver90Minor),
          total: money(row.totalMinor), disputed: row.disputed ? 'yes' : 'no',
        })), coverage);
      }
      case 'collection': {
        // Rent and all-category columns are exported separately. A single
        // "collected" column would leave the accountant to guess which it was.
        return toCsv(r.meta, [
          { key: 'residentName', label: 'Resident' },
          { key: 'leaseReference', label: 'Lease' },
          { key: 'unitLabel', label: 'Unit' },
          { key: 'rentBilled', label: 'Rent billed' },
          { key: 'rentCollected', label: 'Rent collected' },
          { key: 'billed', label: 'All charges billed' },
          { key: 'collected', label: 'All charges collected' },
          { key: 'outstanding', label: 'Outstanding' },
        ], r.rows.map((row) => ({
          ...row,
          rentBilled: money(row.rentBilledMinor), rentCollected: money(row.rentCollectedMinor),
          billed: money(row.billedMinor), collected: money(row.collectedMinor),
          outstanding: money(row.outstandingMinor),
        })), coverage);
      }
      case 'expenses': {
        return toCsv(r.meta, [
          { key: 'expenseDate', label: 'Date' },
          { key: 'propertyName', label: 'Property' },
          { key: 'category', label: 'Category' },
          { key: 'costClass', label: 'Cost class' },
          { key: 'description', label: 'Description' },
          { key: 'vendorName', label: 'Supplier' },
          { key: 'amount', label: 'Amount' },
          { key: 'status', label: 'Status' },
        ], r.rows.map((row) => ({ ...row, amount: money(row.amountMinor) })), coverage);
      }
      case 'deposits': {
        return toCsv(r.meta, [
          { key: 'residentName', label: 'Resident' },
          { key: 'leaseReference', label: 'Lease' },
          { key: 'unitLabel', label: 'Unit' },
          { key: 'holder', label: 'Held by' },
          { key: 'required', label: 'Required' },
          { key: 'held', label: 'Held' },
          { key: 'interest', label: 'Interest credited' },
          { key: 'deductions', label: 'Deductions' },
          { key: 'refunded', label: 'Refunded' },
        ], r.rows.map((row) => ({
          ...row,
          required: money(row.requiredMinor), held: money(row.heldMinor),
          interest: money(row.interestCreditedMinor),
          deductions: money(row.deductionsMinor), refunded: money(row.refundedMinor),
        })), coverage);
      }
      case 'lease-expiry': {
        return toCsv(r.meta, [
          { key: 'residentName', label: 'Resident' },
          { key: 'leaseReference', label: 'Lease' },
          { key: 'unitLabel', label: 'Unit' },
          { key: 'endDate', label: 'Ends' },
          { key: 'daysRemaining', label: 'Days remaining' },
          { key: 'status', label: 'Lease status' },
          { key: 'stillOccupied', label: 'Still occupied' },
          { key: 'receivable', label: 'Receivable' },
        ], r.rows.map((row) => ({
          ...row,
          stillOccupied: row.stillOccupied ? 'yes' : 'no',
          receivable: money(row.receivableMinor),
        })), coverage);
      }
      case 'occupancy': {
        return toCsv(r.meta, [
          { key: 'metric', label: 'Metric' },
          { key: 'value', label: 'Value' },
        ], [
          { metric: 'Occupied unit days', value: r.occupiedUnitDays },
          { metric: 'Available unit days', value: r.availableUnitDays },
          { metric: 'Out of service unit days (excluded from denominator)', value: r.outOfServiceUnitDays },
          { metric: 'Physical occupancy %', value: r.physicalOccupancyPercent ?? 'not calculable' },
        ], coverage);
      }
      case 'journal-lines': {
        return toCsv(r.meta, [
          { key: 'postingDate', label: 'Posting date' },
          { key: 'journalId', label: 'Journal' },
          { key: 'source', label: 'Source' },
          { key: 'accountCode', label: 'Account code' },
          { key: 'accountName', label: 'Account' },
          { key: 'description', label: 'Description' },
          { key: 'leaseReference', label: 'Lease' },
          { key: 'propertyName', label: 'Property' },
          { key: 'debit', label: 'Debit' },
          { key: 'credit', label: 'Credit' },
        ], r.rows.map((row) => ({
          ...row,
          debit: row.debitMinor > 0n ? money(row.debitMinor) : '',
          credit: row.creditMinor > 0n ? money(row.creditMinor) : '',
        })), coverage);
      }
      default:
        return null;
    }
  });

  if (csv === null) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // The name carries what the report actually covers. A rent roll filed
      // as "rent-roll-2026-10-01-to-2026-10-31" claims a period it never had.
      'Content-Disposition': `attachment; filename="${report}-${label.fileSuffix}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
