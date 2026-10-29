import Link from 'next/link';
import {
  Card, EmptyState, Money, PageHeader, buttonClass,
} from '@propertyos/ui';
import {
  CHARGE_CATEGORIES, formatMoney, hasPermission, leasesToCapture, pendingCharges,
} from '@propertyos/domain';
import { BackLink } from '@/components/back-link';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { CaptureRow, DiscardCapture, type LeaseRow } from './capture-forms';

export const metadata = { title: 'Capture the month' };
export const dynamic = 'force-dynamic';

function currentPeriodStart(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

/**
 * The month's utilities, in one pass.
 *
 * What this replaces: opening each lease, opening its charges panel, typing
 * the readings and posting — forty times, with each posting producing its own
 * final invoice. Here the whole month is typed first, against every active
 * lease on one screen, with last month's reading already in the box.
 *
 * Nothing here charges anybody. Every figure is a draft until the billing run
 * posts it, and the run groups a lease's drafts into ONE invoice. That is the
 * whole design: the editable part happens before the ledger, because after the
 * ledger a document is immutable and the only correction is a credit note.
 */
export default async function CaptureMonthPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { org } = await params;
  const { period } = await searchParams;
  const context = await requireOperator(org);

  const periodStart = /^\d{4}-\d{2}-01$/.test(period ?? '')
    ? period!
    : /^\d{4}-\d{2}$/.test(period ?? '') ? `${period}-01` : currentPeriodStart();

  const { leases, captured, canCapture } = await readAs(context.viewer, async (tx) => ({
    leases: await leasesToCapture(tx, context.organisationId, { periodStart }),
    captured: await pendingCharges(tx, context.organisationId, { periodStart }),
    canCapture: await hasPermission(tx, context.organisationId, 'billing.preview'),
  }));

  // Everything but rent, which comes from the lease and its schedule: changing
  // what somebody pays monthly is a change to their lease, not a line typed
  // into this month.
  const categories = CHARGE_CATEGORIES
    .filter((c) => c.key !== 'rent')
    .map((c) => ({ key: c.key, label: c.label, measured: c.measured, unit: c.unit ?? null }));

  const byLease = new Map<string, LeaseRow['captured']>();
  for (const line of captured) {
    const list = byLease.get(line.leaseId) ?? [];
    list.push({
      id: line.id,
      categoryLabel: line.categoryLabel,
      amount: formatMoney(line.amountMinor, line.currencyCode),
    });
    byLease.set(line.leaseId, list);
  }

  const total = captured.reduce((sum, line) => sum + line.amountMinor, 0);
  const currency = captured[0]?.currencyCode ?? 'ZAR';
  const month = periodStart.slice(0, 7);

  return (
    <div className="space-y-6">
      <BackLink href={`/app/${org}/billing?period=${month}`} label="Billing" />

      <PageHeader
        title="Capture the month"
        description={`Water, refuse and anything else to recover for ${formatDate(periodStart, context.timeZone)}. Nothing here charges anybody: the billing run turns it into one invoice per tenancy.`}
      />

      <form method="get" className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-sm font-medium text-ink-700" htmlFor="period">
            Billing month
          </label>
          <input
            id="period" name="period" type="month" defaultValue={month}
            className="mt-1 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm"
          />
        </div>
        <button type="submit" className={buttonClass('secondary')}>Show</button>
      </form>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Captured, not yet billed
          </p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            <Money minor={BigInt(total)} currency={currency} />
          </p>
          <p className="mt-1 text-xs text-ink-500">
            across {captured.length} {captured.length === 1 ? 'line' : 'lines'}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Tenancies</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">{leases.length}</p>
          <p className="mt-1 text-xs text-ink-500">
            {byLease.size} with something captured
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Next</p>
          <p className="mt-2 text-sm text-ink-700">
            When the month is captured, open the{' '}
            <Link
              href={`/app/${org}/billing?period=${month}`}
              className="font-medium text-spike-600 underline underline-offset-2"
            >
              billing preview
            </Link>
            , check it, and post the run. Then mark the invoices ready and send them all.
          </p>
        </Card>
      </div>

      {!canCapture ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm text-ink-700">
            You can see this month but not add to it. Capturing charges needs the same
            permission as preparing a billing run.
          </p>
        </Card>
      ) : null}

      {captured.length > 0 ? (
        <section aria-labelledby="captured" className="space-y-2">
          <h2 id="captured" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Captured this month
          </h2>
          <Card className="divide-y divide-ink-100 p-0">
            {captured.map((line) => (
              <div
                key={line.id}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5"
                data-captured={line.id}
              >
                <div className="min-w-0">
                  <p className="text-sm text-ink-900">
                    <span className="font-medium">{line.unitLabel}</span>
                    <span className="ml-2 text-ink-500">{line.categoryLabel}</span>
                  </p>
                  <p className="text-xs text-ink-500">
                    {line.description}
                    {line.quantity !== null && line.unit
                      ? ` · ${line.quantity} ${line.unit}`
                      : ''}
                    {line.meterPrevious !== null && line.meterCurrent !== null
                      ? ` · ${line.meterPrevious} → ${line.meterCurrent}`
                      : ''}
                    {line.capturedByName ? ` · ${line.capturedByName}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular text-sm font-medium text-ink-900">
                    {formatMoney(line.amountMinor, line.currencyCode)}
                  </span>
                  {canCapture ? <DiscardCapture org={org} pendingChargeId={line.id} /> : null}
                </div>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      <section aria-labelledby="leases" className="space-y-3">
        <h2 id="leases" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Tenancies live in {formatDate(periodStart, context.timeZone)}
        </h2>
        {leases.length === 0 ? (
          <EmptyState
            title="No tenancy was live in this month"
            description="A lease that started after the month ended, or ended before it began, has nothing to recover."
          />
        ) : (
          leases.map((lease) => (
            <CaptureRow
              key={lease.leaseId}
              org={org}
              periodStart={periodStart}
              categories={categories}
              lease={{
                leaseId: lease.leaseId,
                leaseReference: lease.leaseReference,
                unitLabel: lease.unitLabel,
                residentName: lease.residentName,
                lastReadings: lease.lastReadings,
                captured: byLease.get(lease.leaseId) ?? [],
              }}
            />
          ))
        )}
      </section>
    </div>
  );
}
