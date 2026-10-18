import Link from 'next/link';
import { Suspense } from 'react';
import {
  buttonClass, DataTable, Disclosure, EmptyState, Figure, LoadingState, MetricCard, Money,
  PageHeader, Panel, StatusBadge, TaskRow, Td, Th,
} from '@propertyos/ui';
import { hasPermission, listAuditEvents } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { ageingBucket, formatDate } from '@/lib/format';
import { loadArrears, loadDashboard } from '@/lib/queries';
import { splitEnvironmentLabel } from '@/components/environment-label';
import { QuickActions } from './quick-actions';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

function currentPeriodStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** "October 2026" from "2026-10-01", in the reader's language rather than ISO. */
function periodLabel(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-ZA', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
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
  const organisation = splitEnvironmentLabel(context.organisationName).name;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={`${organisation} — what was billed and collected this period, and what is waiting on somebody.`}
        meta={
          <>
            <span>
              Reporting period <strong className="font-semibold text-ink-700">{periodLabel(periodStart)}</strong>
            </span>
            <span aria-hidden="true" className="text-ink-200">·</span>
            <span>Times in {context.timeZone}</span>
          </>
        }
        actions={<QuickActions org={org} periodStart={periodStart} />}
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
  const [metrics, arrears, activity] = await readAs(context.viewer, async (tx) => {
    const dashboard = await loadDashboard(tx, context.organisationId, periodStart);
    const oldest = await loadArrears(tx, context.organisationId, 6);
    // The audit trail is a permission of its own, and an organisation-wide
    // read: a property-scoped manager is refused it rather than shown a
    // filtered version that would misrepresent what happened.
    const mayReadAudit = await hasPermission(tx, context.organisationId, 'audit.read');
    const recent = mayReadAudit
      ? await listAuditEvents(tx, context.organisationId, { limit: 6 }).catch(() => null)
      : null;
    return [dashboard, oldest, recent] as const;
  });

  if (!metrics.hasActivity) {
    return (
      <EmptyState
        title="No financial activity yet"
        description={
          'Once you add a property and a unit, create a resident and activate a lease, '
          + 'this overview will show real billed, collected and outstanding figures. '
          + 'Nothing here is ever a sample total.'
        }
        action={
          <Link href={`${base}/portfolio/new`} className={buttonClass('primary')}>
            Add your first property
          </Link>
        }
      />
    );
  }

  const occupancyPercent = metrics.rentableUnits === 0
    ? null
    : Math.round((metrics.occupiedUnits / metrics.rentableUnits) * 100);
  const vacantUnits = metrics.rentableUnits - metrics.occupiedUnits;

  // Both rates are already computed by the shared definition. Nothing is
  // recalculated here: a percentage worked out in a React component is a second
  // definition of collection, and two definitions is how this went wrong before.
  const { rent, total } = metrics.collection;
  const currency = context.currencyCode;
  const asAt = formatDate(metrics.collection.asOf, context.timeZone);
  const arrearsMinor = BigInt(metrics.arrearsMinor);

  const queue = [
    {
      label: 'Payment evidence to verify',
      count: metrics.unverifiedEvidence,
      href: `${base}/reconciliation?filter=evidence`,
      detail: 'Resident uploads. No balance has moved.',
      priority: 'attention' as const,
      action: 'Review',
    },
    {
      label: 'Approvals waiting',
      count: metrics.pendingApprovals,
      href: `${base}/approvals`,
      detail: 'Quotations, deposit payouts, costs and billing runs.',
      priority: 'attention' as const,
      action: 'Decide',
    },
    {
      label: 'Receipts not applied',
      count: metrics.unmatchedReceipts,
      href: `${base}/reconciliation?filter=unmatched`,
      detail: metrics.suspenseMinor === '0'
        ? 'Nothing in suspense.'
        : 'Money received and not yet on a charge.',
      priority: 'urgent' as const,
      action: 'Apply',
    },
    {
      label: 'Maintenance to triage',
      count: metrics.maintenanceNeedingAttention,
      href: `${base}/maintenance?filter=open`,
      detail: 'Submitted, triaged or awaiting approval.',
      priority: 'attention' as const,
      action: 'Open',
    },
    {
      label: 'Leases expiring within 90 days',
      count: metrics.expiringLeases,
      href: `${base}/leases?expiring=90`,
      detail: 'Active or holdover, ending soon.',
      priority: 'routine' as const,
      action: 'Open',
    },
    {
      label: 'Leases awaiting activation',
      count: metrics.leasesAwaitingActivation,
      href: `${base}/leases?status=awaiting_execution`,
      detail: 'Signed off, so nobody is being billed yet.',
      priority: 'urgent' as const,
      action: 'Activate',
    },
    {
      label: 'Quarantined files',
      count: metrics.quarantinedDocuments,
      href: `${base}/documents?held=yes`,
      detail: 'Nothing has scanned them, so they cannot be shared.',
      priority: 'routine' as const,
      action: 'Open',
    },
  ];
  // Work first, quiet rows after: a queue sorted by whether it needs doing.
  const rank = { urgent: 0, attention: 1, routine: 2 } as const;
  const sortedQueue = [...queue].sort((a, b) =>
    (a.count === 0 ? 1 : 0) - (b.count === 0 ? 1 : 0)
    || rank[a.priority] - rank[b.priority]
    || b.count - a.count);
  const outstandingItems = queue.reduce((n, item) => n + (item.count > 0 ? 1 : 0), 0);

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------ headline metrics */}
      <section aria-labelledby="headline" className="space-y-2.5">
        <h2 id="headline" className="sr-only">Headline figures</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Rent billed"
            href={`${base}/billing?period=${periodStart}`}
            value={<Money minor={rent.billedMinor.toString()} currency={currency} tone="plain" />}
            qualification="Posted rent charges, less rent credits"
          />
          <MetricCard
            label="Rent collected"
            href={`${base}/reports/collection?from=${periodStart}&to=${metrics.collection.periodEnd}`}
            value={<Money minor={rent.collectedMinor.toString()} currency={currency} tone="plain" />}
            qualification={
              rent.ratePercent === null
                ? 'No rent billed this period'
                : `${rent.ratePercent.toFixed(1)}% of rent billed`
            }
          />
          <MetricCard
            label="Outstanding receivable"
            href={`${base}/reports/arrears`}
            value={<Money minor={metrics.receivableMinor} currency={currency} tone="plain" />}
            qualification={
              arrearsMinor > 0n
                ? <>Including <Money minor={metrics.arrearsMinor} currency={currency} tone="plain" className="font-semibold text-caution-700" /> overdue</>
                : 'Nothing is past its due date'
            }
            tone={arrearsMinor > 0n ? 'attention' : 'default'}
          />
          <MetricCard
            label="Occupancy"
            href={`${base}/portfolio`}
            value={occupancyPercent === null ? 'Not available' : `${occupancyPercent}%`}
            qualification={
              occupancyPercent === null
                ? 'No rentable units recorded'
                : `${metrics.occupiedUnits} occupied · ${vacantUnits} available`
            }
          />
        </div>
      </section>

      {/* ------------------------------------------------ the two columns */}
      <div className="grid gap-5 lg:grid-cols-5">
        <Panel
          className="lg:col-span-3"
          titleId="attention"
          title="Needs attention"
          description={
            outstandingItems === 0
              ? 'Nothing is waiting on anybody today.'
              : `${outstandingItems} ${outstandingItems === 1 ? 'queue has' : 'queues have'} work in them.`
          }
        >
          <ul className="divide-y divide-ink-100">
            {sortedQueue.map((item) => (
              <TaskRow
                key={item.label}
                label={item.label}
                count={item.count}
                href={item.href}
                detail={item.detail}
                priority={item.priority}
                actionLabel={item.action}
              />
            ))}
          </ul>
        </Panel>

        <Panel
          className="lg:col-span-2"
          titleId="performance"
          title="Financial performance"
          description={`Stated as at ${asAt}`}
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 px-4 py-4">
            <Figure
              label="Total billed"
              value={<Money minor={total.billedMinor.toString()} currency={currency} tone="plain" />}
              hint="Rent, utilities and every other charge"
            />
            <Figure
              label="Total collected"
              value={<Money minor={total.collectedMinor.toString()} currency={currency} tone="plain" />}
              hint={
                total.ratePercent === null
                  ? 'No charges billed this period'
                  : `${total.ratePercent.toFixed(1)}% of charges billed`
              }
            />
            <Figure
              label="Cash banked"
              value={<Money minor={metrics.collection.receiptsBankedMinor.toString()} currency={currency} tone="plain" />}
              hint="Received this period, whatever it paid for"
            />
            <Figure
              label="Applied to earlier periods"
              value={<Money minor={metrics.collection.priorPeriodCollectedMinor.toString()} currency={currency} tone="plain" />}
              hint="Allocated now against older arrears"
            />
            <Figure
              label="Unapplied or in suspense"
              value={<Money minor={metrics.suspenseMinor} currency={currency} tone="plain" />}
              hint="Money in hand, not yet on a charge"
            />
            <Figure
              label="Approved, not yet paid"
              value={<Money minor={metrics.unpaidExpensesMinor} currency={currency} tone="plain" />}
              hint={
                metrics.unpaidExpenses === 0
                  ? 'No supplier costs waiting'
                  : `${metrics.unpaidExpenses} supplier cost${metrics.unpaidExpenses === 1 ? '' : 's'}`
              }
            />
          </dl>

          <div className="border-t border-ink-100 p-3">
            <Disclosure summary="How these are calculated" className="border-0 shadow-none">
              <ul className="list-disc space-y-1.5 pl-5">
                <li>
                  <strong>Collected</strong> is money allocated to charges billed for this period.
                  <strong> Cash banked</strong> is a different measure: it includes payments that
                  cleared earlier arrears and money still unapplied.
                </li>
                <li>
                  <strong>Rent</strong> excludes deposits and utilities, so a resident who pays the
                  water bill and not the rent never reads as having paid.
                </li>
                <li>
                  <strong>Outstanding receivable</strong> is every unpaid charge balance whatever its
                  due date; the overdue figure is the part already past it.
                </li>
                <li>
                  A deposit is a liability held on the resident&rsquo;s behalf and never reduces
                  what they owe. It is not in any figure on this page.
                </li>
                <li>Every figure is stated as at {asAt} and links to the records behind it.</li>
              </ul>
            </Disclosure>
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------------ lower section */}
      <div className="grid gap-5 lg:grid-cols-5">
        <Panel
          className="lg:col-span-3"
          titleId="arrears"
          title="Oldest arrears"
          description="Leases with the longest-standing overdue balance."
          action={
            <Link
              // The same scope as the rows beside it: past due, not every
              // unpaid charge including this morning's invoice.
              href={`${base}/reports/arrears?overdue=true`}
              className="text-[length:var(--text-meta)] font-medium text-spike-600 hover:underline"
            >
              Full ageing →
            </Link>
          }
        >
          {arrears.length === 0 ? (
            <p className="px-4 py-6 text-center text-[length:var(--text-table)] text-ink-500">
              No overdue balances. Every posted charge past its due date has been settled.
            </p>
          ) : (
            <DataTable
              caption="Leases with the oldest overdue balances"
              dense
              minWidth="34rem"
              head={
                <tr>
                  <Th>Resident</Th>
                  <Th>Unit</Th>
                  <Th>Oldest due</Th>
                  <Th>Ageing</Th>
                  <Th numeric>Outstanding</Th>
                </tr>
              }
            >
              {arrears.map((row) => {
                const bucket = ageingBucket(row.oldestDueDate);
                return (
                  <tr key={row.leaseId} className="hover:bg-ink-50">
                    <Td>
                      <Link
                        href={`${base}/leases/${row.leaseId}`}
                        className="font-medium text-ink-900 hover:text-spike-600 hover:underline"
                      >
                        {row.residentName}
                      </Link>
                      <span className="block technical text-ink-400">{row.leaseReference}</span>
                    </Td>
                    <Td className="text-ink-500">{row.unitLabel}</Td>
                    <Td className="whitespace-nowrap text-ink-500">
                      {formatDate(row.oldestDueDate, context.timeZone)}
                    </Td>
                    <Td>
                      <StatusBadge
                        tone={bucket === 'Over 90 days' ? 'critical' : 'caution'}
                        glyph={bucket === 'Over 90 days' ? '▲' : '●'}
                      >
                        {bucket}
                      </StatusBadge>
                    </Td>
                    <Td numeric>
                      <Money minor={row.outstandingMinor} currency={row.currencyCode} tone="debt" emphasise />
                    </Td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </Panel>

        <Panel
          className="lg:col-span-2"
          titleId="activity"
          title="Recent activity"
          description={activity ? 'Every change, as the audit trail recorded it.' : undefined}
          action={
            activity ? (
              <Link
                href={`${base}/settings/audit`}
                className="text-[length:var(--text-meta)] font-medium text-spike-600 hover:underline"
              >
                Full trail →
              </Link>
            ) : undefined
          }
        >
          {activity === null ? (
            <p className="px-4 py-6 text-[length:var(--text-table)] text-ink-500">
              Reading the audit trail needs the audit permission, which your roles do not
              include. Nothing is hidden selectively: it is all or none, because a partial
              history would misrepresent what happened.
            </p>
          ) : activity.entries.length === 0 ? (
            <p className="px-4 py-6 text-[length:var(--text-table)] text-ink-500">
              Nothing has been changed yet.
            </p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {activity.entries.map((entry) => (
                <li key={entry.id} className="px-4 py-2.5">
                  <p className="text-[length:var(--text-table)] text-ink-900">
                    <span className="font-medium">{entry.actorName ?? 'Somebody'}</span>
                    {' · '}
                    <span className="technical text-ink-700">{entry.action}</span>
                  </p>
                  <p className="text-[length:var(--text-meta)] text-ink-500">
                    {entry.resourceType.replace(/_/g, ' ')}
                    {' · '}
                    {formatDate(entry.occurredAt, context.timeZone)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
