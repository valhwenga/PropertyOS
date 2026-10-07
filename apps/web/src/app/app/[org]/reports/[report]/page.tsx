import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Card, DataTable, EmptyState, Money, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import {
  arrearsAgeing, collectionReport, depositRegister, expenseReport,
  journalLinesExport, leaseExpiryReport, occupancyReport, rentRoll,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

const VALID = new Set([
  'rent-roll', 'arrears', 'collection', 'expenses', 'deposits',
  'lease-expiry', 'occupancy', 'journal-lines',
]);

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    .toISOString().slice(0, 10);
  return { start, end };
}

export default async function ReportPage({
  params, searchParams,
}: {
  params: Promise<{ org: string; report: string }>;
  searchParams: Promise<{ from?: string; to?: string; overdue?: string }>;
}) {
  const { org, report } = await params;
  const { from, to } = await searchParams;
  if (!VALID.has(report)) notFound();

  const context = await requireOperator(org);
  const period = defaultPeriod();
  const periodStart = from ?? period.start;
  const periodEnd = to ?? period.end;

  const data = await readAs(context.viewer, async (tx) => {
    switch (report) {
      case 'rent-roll':     return { kind: 'rent-roll' as const, ...(await rentRoll(tx, context.organisationId)) };
      case 'arrears':       return { kind: 'arrears' as const, ...(await arrearsAgeing(tx, context.organisationId)) };
      case 'collection':    return { kind: 'collection' as const, ...(await collectionReport(tx, context.organisationId, { periodStart, periodEnd })) };
      case 'expenses':      return { kind: 'expenses' as const, ...(await expenseReport(tx, context.organisationId, { periodStart, periodEnd })) };
      case 'deposits':      return { kind: 'deposits' as const, ...(await depositRegister(tx, context.organisationId)) };
      case 'lease-expiry':  return { kind: 'lease-expiry' as const, ...(await leaseExpiryReport(tx, context.organisationId, { withinDays: 180 })) };
      case 'occupancy':     return { kind: 'occupancy' as const, ...(await occupancyReport(tx, context.organisationId, { periodStart, periodEnd })) };
      default:              return { kind: 'journal-lines' as const, ...(await journalLinesExport(tx, context.organisationId, { periodStart, periodEnd })) };
    }
  });

  const currency = data.meta.currencyCode;

  return (
    <div className="space-y-6">
      <PageHeader
        title={data.meta.name}
        description={`Within your assigned scope · generated ${formatDate(data.meta.generatedAt, context.timeZone)}`}
        actions={
          <>
            <Link href={`/app/${org}/reports`} className="rounded-lg border border-ink-200 bg-surface px-3.5 py-2 text-sm font-medium text-ink-700">
              All reports
            </Link>
            <a
              href={`/app/${org}/reports/${report}/export.csv?from=${periodStart}&to=${periodEnd}`}
              className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
            >
              Export CSV
            </a>
          </>
        }
      />

      {/* The definitions travel with the figures, on screen and in the export. */}
      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm font-semibold text-info-700">How to read this report</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-700">
          {data.meta.qualifications.map((q) => <li key={q}>{q}</li>)}
        </ul>
      </Card>

      {data.kind === 'occupancy' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Physical occupancy</p>
            <p className="mt-1 text-3xl font-semibold">
              {data.physicalOccupancyPercent === null ? '—' : `${data.physicalOccupancyPercent}%`}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Occupied unit days</p>
            <p className="tabular mt-1 text-3xl font-semibold">{data.occupiedUnitDays}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Available unit days</p>
            <p className="tabular mt-1 text-3xl font-semibold">{data.availableUnitDays}</p>
            <p className="mt-1 text-xs text-ink-400">
              {data.outOfServiceUnitDays} day{data.outOfServiceUnitDays === 1 ? '' : 's'} out of service excluded
            </p>
          </Card>
        </div>
      ) : null}

      {data.kind === 'rent-roll' ? (
        data.rows.length === 0 ? <EmptyState title="No units in scope" description="Add a property and a unit to see a rent roll." /> : (
          <DataTable
            caption="Rent roll"
            head={<tr><Th>Property</Th><Th>Unit</Th><Th>Resident</Th><Th>Lease</Th><Th>Occupied</Th><Th numeric>Rent</Th><Th numeric>Receivable</Th></tr>}
          >
            {data.rows.map((r, i) => (
              <tr key={`${r.propertyName}-${r.unitCode}-${i}`} className="hover:bg-ink-50">
                <Td>{r.propertyName}</Td>
                <Td className="tabular">{r.unitCode}</Td>
                <Td>{r.residentName ?? <span className="text-ink-400">Vacant</span>}</Td>
                <Td className="text-ink-500">{r.leaseReference ?? '—'}</Td>
                <Td>{r.occupied
                  ? <StatusBadge tone="positive" glyph="●">Occupied</StatusBadge>
                  : <StatusBadge tone="neutral" glyph="○">Vacant</StatusBadge>}</Td>
                <Td numeric><Money minor={r.contractedRentMinor} currency={currency} /></Td>
                <Td numeric><Money minor={r.receivableMinor} currency={currency} emphasise={r.receivableMinor > 0n} /></Td>
              </tr>
            ))}
            <tr className="border-t-2 border-ink-200 bg-ink-50/60 font-semibold">
              <Td>Total</Td><Td> </Td><Td> </Td><Td> </Td><Td> </Td>
              <Td numeric><Money minor={data.totalRentMinor} currency={currency} emphasise /></Td>
              <Td numeric><Money minor={data.totalReceivableMinor} currency={currency} emphasise /></Td>
            </tr>
          </DataTable>
        )
      ) : null}

      {data.kind === 'arrears' ? (
        data.rows.length === 0 ? <EmptyState title="No arrears" description="Every posted charge with a past due date has been settled." /> : (
          <DataTable
            caption="Arrears ageing"
            head={<tr><Th>Resident</Th><Th>Unit</Th><Th numeric>Not yet due</Th><Th numeric>1–30</Th><Th numeric>31–60</Th><Th numeric>61–90</Th><Th numeric>Over 90</Th><Th numeric>Total</Th></tr>}
          >
            {data.rows.map((r) => (
              <tr key={r.leaseId} className="hover:bg-ink-50">
                <Td>
                  <Link href={`/app/${org}/leases/${r.leaseId}`} className="font-medium text-spike-600 hover:underline">
                    {r.residentName ?? r.leaseReference}
                  </Link>
                  {r.disputed ? <StatusBadge tone="caution" glyph="▲">Disputed</StatusBadge> : null}
                </Td>
                <Td className="text-ink-500">{r.unitLabel}</Td>
                <Td numeric><Money minor={r.notYetDueMinor} currency={currency} /></Td>
                <Td numeric><Money minor={r.days1to30Minor} currency={currency} /></Td>
                <Td numeric><Money minor={r.days31to60Minor} currency={currency} /></Td>
                <Td numeric><Money minor={r.days61to90Minor} currency={currency} /></Td>
                <Td numeric><Money minor={r.daysOver90Minor} currency={currency} emphasise={r.daysOver90Minor > 0n} /></Td>
                <Td numeric><Money minor={r.totalMinor} currency={currency} emphasise /></Td>
              </tr>
            ))}
            <tr className="border-t-2 border-ink-200 bg-ink-50/60 font-semibold">
              <Td>Total</Td><Td> </Td>
              <Td numeric><Money minor={data.totals.notYetDueMinor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.days1to30Minor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.days31to60Minor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.days61to90Minor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.daysOver90Minor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.totalMinor!} currency={currency} emphasise /></Td>
            </tr>
          </DataTable>
        )
      ) : null}

      {data.kind === 'collection' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Billed</p>
              <p className="mt-1 text-2xl font-semibold"><Money minor={data.totalBilledMinor} currency={currency} /></p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Collected</p>
              <p className="mt-1 text-2xl font-semibold"><Money minor={data.totalCollectedMinor} currency={currency} /></p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Collection rate</p>
              <p className="mt-1 text-2xl font-semibold">
                {data.collectionRatePercent === null ? '—' : `${data.collectionRatePercent}%`}
              </p>
              {data.collectionRatePercent === null ? (
                <p className="mt-1 text-xs text-ink-400">Nothing was billed in this period.</p>
              ) : null}
            </Card>
          </div>
          <DataTable
            caption="Collection by lease"
            head={<tr><Th>Resident</Th><Th>Unit</Th><Th numeric>Billed</Th><Th numeric>Collected</Th><Th numeric>Outstanding</Th></tr>}
          >
            {data.rows.map((r, i) => (
              <tr key={`${r.leaseReference}-${i}`}>
                <Td>{r.residentName ?? r.leaseReference}</Td>
                <Td className="text-ink-500">{r.unitLabel}</Td>
                <Td numeric><Money minor={r.billedMinor} currency={currency} /></Td>
                <Td numeric><Money minor={r.collectedMinor} currency={currency} /></Td>
                <Td numeric><Money minor={r.outstandingMinor} currency={currency} emphasise={r.outstandingMinor > 0n} /></Td>
              </tr>
            ))}
          </DataTable>
        </>
      ) : null}

      {data.kind === 'expenses' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Operating</p>
              <p className="mt-1 text-2xl font-semibold"><Money minor={data.totalOperatingMinor} currency={currency} /></p>
              <p className="mt-1 text-xs text-ink-400">Counts towards net operating income</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Capital</p>
              <p className="mt-1 text-2xl font-semibold"><Money minor={data.totalCapitalMinor} currency={currency} /></p>
              <p className="mt-1 text-xs text-ink-400">Excluded from net operating income</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">All costs</p>
              <p className="mt-1 text-2xl font-semibold"><Money minor={data.totalMinor} currency={currency} /></p>
            </Card>
          </div>
          <DataTable
            caption="Expenses"
            head={<tr><Th>Date</Th><Th>Property</Th><Th>Description</Th><Th>Supplier</Th><Th>Class</Th><Th numeric>Amount</Th><Th>Status</Th></tr>}
          >
            {data.rows.map((r, i) => (
              <tr key={i}>
                <Td className="whitespace-nowrap text-ink-500">{formatDate(r.expenseDate, context.timeZone)}</Td>
                <Td>{r.propertyName ?? '—'}</Td>
                <Td>{r.description}</Td>
                <Td className="text-ink-500">{r.vendorName ?? '—'}</Td>
                <Td className="capitalize">{r.costClass}</Td>
                <Td numeric><Money minor={r.amountMinor} currency={currency} /></Td>
                <Td>{r.status === 'draft'
                  ? <StatusBadge tone="caution" glyph="◐">Draft</StatusBadge>
                  : <StatusBadge tone="positive" glyph="✓">{r.status}</StatusBadge>}</Td>
              </tr>
            ))}
          </DataTable>
        </>
      ) : null}

      {data.kind === 'deposits' ? (
        data.rows.length === 0 ? <EmptyState title="No deposits recorded" description="Deposit liabilities appear here once received." /> : (
          <DataTable
            caption="Deposit register"
            head={<tr><Th>Resident</Th><Th>Unit</Th><Th>Holder</Th><Th numeric>Required</Th><Th numeric>Held</Th><Th numeric>Interest</Th><Th numeric>Deductions</Th><Th numeric>Refunded</Th></tr>}
          >
            {data.rows.map((r, i) => (
              <tr key={i}>
                <Td>{r.residentName ?? r.leaseReference}</Td>
                <Td className="text-ink-500">{r.unitLabel}</Td>
                <Td className="capitalize">{r.holder.replace(/_/g, ' ')}</Td>
                <Td numeric><Money minor={r.requiredMinor} currency={currency} /></Td>
                <Td numeric><Money minor={r.heldMinor} currency={currency} emphasise /></Td>
                <Td numeric><Money minor={r.interestCreditedMinor} currency={currency} /></Td>
                <Td numeric><Money minor={r.deductionsMinor} currency={currency} /></Td>
                <Td numeric><Money minor={r.refundedMinor} currency={currency} /></Td>
              </tr>
            ))}
          </DataTable>
        )
      ) : null}

      {data.kind === 'lease-expiry' ? (
        data.rows.length === 0 ? <EmptyState title="No leases expiring" description="Nothing in your scope ends within 180 days." /> : (
          <DataTable
            caption="Lease expiry"
            head={<tr><Th>Resident</Th><Th>Unit</Th><Th>Ends</Th><Th numeric>Days</Th><Th>Lease status</Th><Th>Occupied</Th><Th numeric>Receivable</Th></tr>}
          >
            {data.rows.map((r) => (
              <tr key={r.leaseId}>
                <Td>
                  <Link href={`/app/${org}/leases/${r.leaseId}`} className="font-medium text-spike-600 hover:underline">
                    {r.residentName ?? r.leaseReference}
                  </Link>
                </Td>
                <Td className="text-ink-500">{r.unitLabel}</Td>
                <Td className="whitespace-nowrap">{formatDate(r.endDate, context.timeZone)}</Td>
                <Td numeric className="tabular">{r.daysRemaining}</Td>
                <Td className="capitalize">{r.status.replace(/_/g, ' ')}</Td>
                <Td>{r.stillOccupied
                  ? <StatusBadge tone="caution" glyph="●">Still occupied</StatusBadge>
                  : <StatusBadge tone="neutral" glyph="○">Vacated</StatusBadge>}</Td>
                <Td numeric><Money minor={r.receivableMinor} currency={currency} emphasise={r.receivableMinor > 0n} /></Td>
              </tr>
            ))}
          </DataTable>
        )
      ) : null}

      {data.kind === 'journal-lines' ? (
        <>
          <Card className={data.balanced ? 'border-positive-600/25 bg-positive-50 p-4' : 'border-critical-700/25 bg-critical-50 p-4'}>
            <p className="text-sm font-semibold">
              {data.balanced
                ? '✓ This extract balances'
                : '▲ This extract does not balance — contact support with the reference below'}
            </p>
            <p className="mt-1 text-sm text-ink-700">
              Debits <Money minor={data.totalDebitMinor} currency={currency} /> ·
              Credits <Money minor={data.totalCreditMinor} currency={currency} />
            </p>
          </Card>
          <DataTable
            caption="Journal lines"
            dense
            head={<tr><Th>Date</Th><Th>Source</Th><Th>Account</Th><Th>Description</Th><Th>Lease</Th><Th numeric>Debit</Th><Th numeric>Credit</Th></tr>}
          >
            {data.rows.map((r, i) => (
              <tr key={i}>
                <Td className="whitespace-nowrap text-ink-500">{formatDate(r.postingDate, context.timeZone)}</Td>
                <Td className="text-ink-500">{r.source.replace(/_/g, ' ')}</Td>
                <Td className="tabular">{r.accountCode}</Td>
                <Td>{r.description}</Td>
                <Td className="text-ink-500">{r.leaseReference ?? '—'}</Td>
                <Td numeric>{r.debitMinor > 0n ? <Money minor={r.debitMinor} currency={currency} /> : <span className="text-ink-300">—</span>}</Td>
                <Td numeric>{r.creditMinor > 0n ? <Money minor={r.creditMinor} currency={currency} /> : <span className="text-ink-300">—</span>}</Td>
              </tr>
            ))}
          </DataTable>
        </>
      ) : null}
    </div>
  );
}
