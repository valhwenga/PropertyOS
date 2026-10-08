import Link from 'next/link';
import { Suspense } from 'react';
import {
  Card, DataTable, EmptyState, LoadingState, Money, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import { MetricTile, MoneyMetric } from '@/components/metric';
import { readAs, requireOperator } from '@/lib/auth';
import { ageingBucket, formatDate } from '@/lib/format';
import { loadArrears, loadDashboard } from '@/lib/queries';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

function currentPeriodStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export default async function OverviewPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { org } = await params;
  const { period } = await searchParams;
  const context = await requireOperator(org);
  const periodStart = period ?? currentPeriodStart();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={`${context.organisationName} · period ${periodStart.slice(0, 7)} · times shown in ${context.timeZone}`}
      />
      <Suspense fallback={<LoadingState label="Loading overview metrics" />}>
        <Metrics org={org} periodStart={periodStart} context={context} />
      </Suspense>
    </div>
  );
}

async function Metrics({
  org, periodStart, context,
}: {
  org: string; periodStart: string;
  context: Awaited<ReturnType<typeof requireOperator>>;
}) {
  const base = `/app/${org}`;
  const [metrics, arrears] = await readAs(context.viewer, async (tx) => [
    await loadDashboard(tx, context.organisationId, periodStart),
    await loadArrears(tx, context.organisationId, 8),
  ] as const);

  if (!metrics.hasActivity) {
    return (
      <EmptyState
        title="No financial activity yet"
        description={
          'Once you add a property and a unit, create a resident and activate a lease, ' +
          'this overview will show real billed, collected and outstanding figures. ' +
          'Nothing here is ever a sample total.'
        }
        action={
          <Link href={`${base}/portfolio/new`} className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
            Add your first property
          </Link>
        }
      />
    );
  }

  const occupancyPercent = metrics.rentableUnits === 0
    ? null
    : Math.round((metrics.occupiedUnits / metrics.rentableUnits) * 100);

  // Both rates are already computed by the shared definition. Nothing is
  // recalculated here: a percentage worked out in a React component is a second
  // definition of collection, and two definitions is how this went wrong before.
  const { rent, total } = metrics.collection;
  const rate = (p: number | null, what: string): string =>
    p === null ? `No ${what} billed for this period` : `${p.toFixed(2)}% of ${what} billed`;

  return (
    <div className="space-y-6">
      {/* Money. Every tile links to the records it was computed from, with the
          same period filter applied. Rent and all-category collection are shown
          as two separate measures, because a resident who pays the water bill
          but not the rent must not read as having paid. */}
      <section aria-labelledby="money-heading" className="space-y-3">
        <h2 id="money-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Billed and collected for {periodStart.slice(0, 7)}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MoneyMetric
            label="Rent billed" minor={rent.billedMinor.toString()} currency={context.currencyCode}
            href={`${base}/billing?period=${periodStart}`}
            qualification="Posted rent charges less rent credits. Excludes deposits and utilities."
          />
          <MoneyMetric
            label="Rent collected" minor={rent.collectedMinor.toString()} currency={context.currencyCode}
            href={`${base}/reports/collection?from=${periodStart}&to=${metrics.collection.periodEnd}`}
            qualification={rate(rent.ratePercent, 'rent')}
          />
          <MoneyMetric
            label="Total billed" minor={total.billedMinor.toString()} currency={context.currencyCode}
            href={`${base}/billing?period=${periodStart}`}
            qualification="Rent, utilities and every other charge raised for this period."
          />
          <MoneyMetric
            label="Total collected" minor={total.collectedMinor.toString()} currency={context.currencyCode}
            href={`${base}/reports/collection?from=${periodStart}&to=${metrics.collection.periodEnd}`}
            qualification={rate(total.ratePercent, 'charges')}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MoneyMetric
            label="Cash banked" minor={metrics.collection.receiptsBankedMinor.toString()}
            currency={context.currencyCode}
            href={`${base}/reconciliation?period=${periodStart}`}
            qualification="Confirmed receipts received in this period, whatever they paid for."
          />
          <MoneyMetric
            label="Applied to earlier periods"
            minor={metrics.collection.priorPeriodCollectedMinor.toString()}
            currency={context.currencyCode}
            href={`${base}/reports/arrears`}
            qualification="Allocated this period against arrears billed before it."
          />
          <MoneyMetric
            label="Outstanding receivable" minor={metrics.receivableMinor} currency={context.currencyCode}
            href={`${base}/reports/arrears`}
            qualification="All unpaid charge balances, every due date."
          />
          <MoneyMetric
            label="Arrears" minor={metrics.arrearsMinor} currency={context.currencyCode}
            href={`${base}/reports/arrears?overdue=true`}
            qualification="Unpaid balances already past their due date."
            tone={BigInt(metrics.arrearsMinor) > 0n ? 'attention' : 'default'}
          />
        </div>

        <p className="text-xs text-ink-400">
          Collected means money allocated to charges billed for this period. Cash banked is a
          different measure: it includes payments that cleared earlier arrears and money still
          unapplied. Stated as at {formatDate(metrics.collection.asOf, context.timeZone)}.
        </p>
      </section>

      {/* Action queues. */}
      <section aria-labelledby="attention-heading" className="space-y-3">
        <h2 id="attention-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Needs attention
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Occupancy" href={`${base}/portfolio`}
            qualification={
              occupancyPercent === null
                ? 'No rentable units recorded yet'
                : `${metrics.occupiedUnits} of ${metrics.rentableUnits} units occupied today`
            }
          >
            {occupancyPercent === null ? '—' : `${occupancyPercent}%`}
          </MetricTile>
          <MetricTile
            label="Expiring leases" href={`${base}/leases?expiring=90`}
            qualification="Active or holdover leases ending within 90 days"
            tone={metrics.expiringLeases > 0 ? 'attention' : 'default'}
          >
            {metrics.expiringLeases}
          </MetricTile>
          <MetricTile
            label="Unmatched receipts" href={`${base}/reconciliation?filter=unmatched`}
            qualification={`Suspense balance ${metrics.suspenseMinor === '0' ? 'nil' : 'held'}`}
            tone={metrics.unmatchedReceipts > 0 ? 'attention' : 'default'}
          >
            {metrics.unmatchedReceipts}
          </MetricTile>
          <MetricTile
            label="Pending approvals" href={`${base}/approvals`}
            qualification="Quotes, deposit refunds, draft expenses and validated billing runs"
            tone={metrics.pendingApprovals > 0 ? 'attention' : 'default'}
          >
            {metrics.pendingApprovals}
          </MetricTile>
          <MetricTile
            label="Maintenance to triage" href={`${base}/maintenance?filter=open`}
            qualification="Submitted, triaged or awaiting approval"
            tone={metrics.maintenanceNeedingAttention > 0 ? 'attention' : 'default'}
          >
            {metrics.maintenanceNeedingAttention}
          </MetricTile>
          <MetricTile
            label="Unverified payment evidence" href={`${base}/reconciliation?filter=evidence`}
            qualification="Resident uploads awaiting bank verification — no balance effect"
            tone={metrics.unverifiedEvidence > 0 ? 'attention' : 'default'}
          >
            {metrics.unverifiedEvidence}
          </MetricTile>
        </div>
      </section>

      <section aria-labelledby="arrears-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="arrears-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Oldest arrears
          </h2>
          <Link href={`${base}/reports/arrears`} className="text-sm font-medium text-spike-600 hover:underline">
            Full arrears ageing →
          </Link>
        </div>

        {arrears.length === 0 ? (
          <Card className="px-5 py-8 text-center text-sm text-ink-500">
            No overdue balances. Every posted charge with a past due date has been settled.
          </Card>
        ) : (
          <DataTable
            caption="Leases with the oldest overdue balances"
            head={
              <tr>
                <Th>Resident</Th>
                <Th>Unit</Th>
                <Th>Lease</Th>
                <Th>Oldest due</Th>
                <Th>Ageing</Th>
                <Th numeric>Outstanding</Th>
              </tr>
            }
          >
            {arrears.map((row) => (
              <tr key={row.leaseId} className="hover:bg-ink-50">
                <Td>{row.residentName}</Td>
                <Td className="text-ink-500">{row.unitLabel}</Td>
                <Td>
                  <Link href={`${base}/leases/${row.leaseId}`} className="font-medium text-spike-600 hover:underline">
                    {row.leaseReference}
                  </Link>
                </Td>
                <Td className="text-ink-500">{formatDate(row.oldestDueDate, context.timeZone)}</Td>
                <Td>
                  <StatusBadge
                    tone={ageingBucket(row.oldestDueDate) === 'Over 90 days' ? 'critical' : 'caution'}
                    glyph={ageingBucket(row.oldestDueDate) === 'Over 90 days' ? '▲' : '●'}
                  >
                    {ageingBucket(row.oldestDueDate)}
                  </StatusBadge>
                </Td>
                <Td numeric>
                  <Money minor={row.outstandingMinor} currency={row.currencyCode} emphasise />
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </div>
  );
}
