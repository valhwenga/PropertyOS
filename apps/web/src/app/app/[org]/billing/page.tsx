import Link from 'next/link';
import { Card, DataTable, EmptyState, Money, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { previewBillingRun, DomainError, hasPermission } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadBillingRuns } from '@/lib/operations-queries';
import { PrepareRunForm } from './billing-forms';

export const metadata = { title: 'Billing' };
export const dynamic = 'force-dynamic';

function currentPeriodStart(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

/**
 * The billing preview for a period.
 *
 * READ ONLY. Nothing here posts a charge. The preview is the point: it shows
 * exactly what a run would raise, what it would skip because it is already
 * billed, and what it refuses to touch — before anyone commits a figure to a
 * resident's account.
 *
 * Posting is a separate act on a separate screen, under a separate permission.
 * Preparing a run from this preview records what the period would raise and
 * pins it to a preview version; approving and posting that run is the financial
 * write, and the domain refuses it if the data has moved since.
 */
export default async function BillingPage({
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

  const { result, runs, canPrepare } = await readAs(context.viewer, async (tx) => ({
    result: await (async () => {
      try {
        return {
          ok: true as const,
          preview: await previewBillingRun(tx, context.organisationId, { periodStart }),
        };
      } catch (error) {
        if (error instanceof DomainError) return { ok: false as const, message: error.message };
        throw error;
      }
    })(),
    runs: await loadBillingRuns(tx, context.organisationId),
    canPrepare: await hasPermission(tx, context.organisationId, 'billing.preview'),
  }));

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="Billing" description="Charges a run would raise for a period." />
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <StatusBadge tone="caution" glyph="▲">Cannot preview this period</StatusBadge>
          <p className="mt-2 text-sm text-ink-700">{result.message}</p>
        </Card>
      </div>
    );
  }

  const { preview } = result;
  const blocking = preview.exceptions.filter((e) => e.severity === 'blocking');
  const warnings = preview.exceptions.filter((e) => e.severity === 'warning');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description={`What a run would raise for ${formatDate(preview.periodStart, context.timeZone)} to ${formatDate(preview.periodEnd, context.timeZone)}. Nothing on this page posts a charge.`}
        actions={
          canPrepare && preview.billableLineCount > 0 ? (
            <PrepareRunForm
              org={org} periodStart={preview.periodStart} blockingCount={blocking.length}
            />
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Would be raised</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            <Money minor={preview.totalMinor} currency={preview.currencyCode} />
          </p>
          <p className="mt-1 text-xs text-ink-500">
            {preview.billableLineCount} {preview.billableLineCount === 1 ? 'charge' : 'charges'}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Already billed</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">{preview.skippedLineCount}</p>
          <p className="mt-1 text-xs text-ink-500">
            Skipped, so a second run cannot double-charge.
          </p>
        </Card>
        <Card className={blocking.length > 0 ? 'border-critical-700/25 bg-critical-50 p-4' : 'p-4'}>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Blocking exceptions</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">{blocking.length}</p>
          <p className="mt-1 text-xs text-ink-500">
            {blocking.length === 0 ? 'Nothing is holding this period back.' : 'These must be resolved first.'}
          </p>
        </Card>
      </div>

      {preview.exceptions.length > 0 ? (
        <section aria-labelledby="exceptions" className="space-y-2">
          <h2 id="exceptions" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Exceptions
          </h2>
          <Card className="divide-y divide-ink-100 p-0">
            {[...blocking, ...warnings].map((e, i) => (
              <div key={`${e.code}-${i}`} className="flex items-start gap-3 px-4 py-3">
                <StatusBadge
                  tone={e.severity === 'blocking' ? 'critical' : 'caution'}
                  glyph={e.severity === 'blocking' ? '✕' : '▲'}
                >
                  {e.severity}
                </StatusBadge>
                <div className="min-w-0">
                  <p className="text-sm text-ink-900">{e.message}</p>
                  <p className="text-xs text-ink-400">
                    {e.leaseReference ? `${e.leaseReference} · ` : ''}{e.code}
                  </p>
                </div>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {preview.lines.length === 0 ? (
        <EmptyState
          title="Nothing to bill in this period"
          description="Charges appear here once a lease has a schedule covering these dates."
        />
      ) : (
        <DataTable
          caption={`Billing preview for ${preview.periodStart}`}
          head={
            <tr>
              <Th>Lease</Th><Th>Unit</Th><Th>Charge</Th><Th>Service period</Th>
              <Th>Due</Th><Th numeric>Amount</Th>
            </tr>
          }
        >
          {preview.lines.map((l) => (
            <tr key={`${l.scheduleId}-${l.servicePeriodStart}`} className={l.alreadyBilled ? 'text-ink-400' : ''}>
              <Td>{l.leaseReference}</Td>
              <Td className="text-ink-500">{l.unitLabel}</Td>
              <Td>
                <span className="block">{l.description}</span>
                <span className="text-xs text-ink-400">
                  {l.alreadyBilled ? 'already billed — would be skipped' : null}
                  {!l.alreadyBilled && l.prorated
                    ? `pro-rated ${l.prorationNumerator}/${l.prorationDenominator} of a full ${''}`
                    : null}
                  {!l.alreadyBilled && l.prorated ? (
                    <Money minor={l.fullAmountMinor} currency={preview.currencyCode} />
                  ) : null}
                </span>
              </Td>
              <Td className="whitespace-nowrap text-ink-500">
                {formatDate(l.servicePeriodStart, context.timeZone)} – {formatDate(l.servicePeriodEnd, context.timeZone)}
              </Td>
              <Td className="whitespace-nowrap">{formatDate(l.dueDate, context.timeZone)}</Td>
              <Td numeric><Money minor={l.amountMinor} currency={preview.currencyCode} /></Td>
            </tr>
          ))}
        </DataTable>
      )}

      <Card className="p-4">
        <p className="text-sm font-medium text-ink-900">Nothing on this page posts a charge</p>
        <p className="mt-1 text-sm text-ink-500">
          The figures above are computed from live schedules, not from stored totals. Preparing a
          run records them as a numbered batch with its own validation report; approving and
          posting that batch is a separate act on its own screen, under a separate permission.
        </p>
        <Link href={`/app/${org}/reports/collection`} className="mt-2 inline-block text-sm text-spike-700">
          See what has actually been billed and collected →
        </Link>
      </Card>

      <section aria-labelledby="runs" className="space-y-3">
        <h2 id="runs" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Billing runs
        </h2>
        {runs.length === 0 ? (
          <Card className="px-5 py-8 text-center text-sm text-ink-500">
            No run has been prepared yet. A run is the record that a period was billed: who
            prepared it, who posted it, and what it raised.
          </Card>
        ) : (
          <DataTable
            caption="Billing runs"
            head={
              <tr>
                <Th>Period</Th><Th>Status</Th><Th>Prepared by</Th>
                <Th>Posted by</Th><Th numeric>Charges</Th><Th numeric>Total</Th>
              </tr>
            }
          >
            {runs.map((r) => (
              <tr key={r.id} className="hover:bg-ink-50">
                <Td>
                  <Link
                    href={`/app/${org}/billing/${r.id}`}
                    className="font-medium text-spike-600 hover:underline"
                  >
                    {r.period_start.slice(0, 7)}
                  </Link>
                </Td>
                <Td>
                  <StatusBadge
                    tone={
                      r.status === 'posted' ? 'positive'
                        : r.status === 'validated' ? 'info'
                          : r.status === 'failed' ? 'critical' : 'caution'
                    }
                  >
                    {r.status}
                  </StatusBadge>
                </Td>
                <Td className="text-ink-500">{r.created_by_name ?? '—'}</Td>
                <Td className="text-ink-500">{r.posted_by_name ?? '—'}</Td>
                <Td numeric className="tabular text-ink-500">{r.line_count}</Td>
                <Td numeric>
                  <Money minor={BigInt(r.totals_minor)} currency={context.currencyCode} />
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </div>
  );
}
