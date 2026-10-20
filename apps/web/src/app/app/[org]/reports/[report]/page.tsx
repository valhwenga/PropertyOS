import Link from 'next/link';
import { Icons } from '@/components/icons';
import { BackLink } from '@/components/back-link';
import { notFound } from 'next/navigation';
import {
  Card, DataTable, Disclosure, EmptyState, Figure, Money, PageHeader, Panel, StatusBadge,
  Td, Th, TotalRow, buttonClass,
} from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadReportPropertyChoices } from '@/lib/operations-queries';
import {
  periodLabel, REPORT_SHAPES, reportQueryString, resolveReport, todayIn,
} from '@/lib/report-shapes';
import { runReport } from '@/lib/reports';
import { ReportFiltersForm } from './report-filters';

export const dynamic = 'force-dynamic';

export default async function ReportPage({
  params, searchParams,
}: {
  params: Promise<{ org: string; report: string }>;
  searchParams: Promise<{
    from?: string; to?: string; asAt?: string; within?: string; property?: string | string[];
  }>;
}) {
  const { org, report } = await params;
  const query = await searchParams;
  const shape = REPORT_SHAPES[report];
  if (!shape) notFound();

  const context = await requireOperator(org);
  const properties = await readAs(context.viewer, (tx) =>
    loadReportPropertyChoices(tx, context.organisationId));

  // The ids offered are the ids accepted. Not an access control — the report
  // runs under the caller's own scope either way — but an id that was typed
  // rather than ticked should be reported back, not quietly narrow the figures.
  const resolved = resolveReport(
    shape, query, context.timeZone, new Set(properties.map((p) => p.id)),
  );
  const today = todayIn(context.timeZone);
  const label = periodLabel(shape, resolved.filters, today);

  const data = await readAs(context.viewer, (tx) =>
    runReport(tx, context.organisationId, report, resolved.filters));
  if (!data) notFound();

  const currency = data.meta.currencyCode;
  const chosen = resolved.filters.propertyIds ?? [];
  const scope = chosen.length === 0
    ? 'every property in your scope'
    : chosen.length === 1
      ? properties.find((p) => p.id === chosen[0])?.name ?? 'one property'
      : `${chosen.length} of ${properties.length} properties`;

  return (
    <div className="space-y-5">
      <BackLink href={`/app/${org}/reports`} label="All reports" />

      <PageHeader
        title={data.meta.name}
        // The period is the first thing the page says. A rent roll with no
        // date on it is a rent roll somebody will still be reading in March.
        meta={
          <>
            <span className="font-medium text-ink-700">{label.sentence}</span>
            <span aria-hidden="true">·</span>
            <span>{scope}</span>
            <span aria-hidden="true">·</span>
            <span>Generated {formatDate(data.meta.generatedAt, context.timeZone)}</span>
          </>
        }
        actions={
          <>
            <Link href={`/app/${org}/reports`} className={buttonClass('ghost')}>
              All reports
            </Link>
            <a
              href={`/app/${org}/reports/${report}/export.csv?${reportQueryString(shape, resolved.filters)}`}
              className={buttonClass('primary')}
            >
              <Icons.export className="h-4 w-4" />
              Export CSV
            </a>
          </>
        }
        toolbar={
          <ReportFiltersForm
            base={`/app/${org}`}
            shape={shape}
            resolved={resolved}
            properties={properties}
            customised={Object.keys(query).length > 0}
            scope={`${label.sentence} · ${scope}. The export covers exactly this.`}
          />
        }
      />

      {/* The definitions travel with the figures, on screen and in the export.
          Folded away by default: they are a reference, not the report. */}
      <Disclosure summary="How to read this report">
        <ul className="list-disc space-y-1 pl-5">
          {data.meta.qualifications.map((q) => <li key={q}>{q}</li>)}
        </ul>
      </Disclosure>

      {data.kind === 'occupancy' ? (
        <Panel title="Occupancy over the period" titleId="occupancy-summary">
          <dl className="grid gap-4 p-4 sm:grid-cols-3">
            <Figure
              label="Physical occupancy"
              value={data.physicalOccupancyPercent === null
                ? 'Not available'
                : `${data.physicalOccupancyPercent}%`}
              hint={data.physicalOccupancyPercent === null
                ? 'No unit was available for any day of this period.'
                : 'Occupied unit days over available unit days.'}
              numeric={data.physicalOccupancyPercent !== null}
            />
            <Figure label="Occupied unit days" value={data.occupiedUnitDays} />
            <Figure
              label="Available unit days"
              value={data.availableUnitDays}
              hint={`${data.outOfServiceUnitDays} day${data.outOfServiceUnitDays === 1 ? '' : 's'} out of service excluded`}
            />
          </dl>
        </Panel>
      ) : null}

      {data.kind === 'rent-roll' ? (
        data.rows.length === 0 ? (
          <EmptyState
            title="No units in scope"
            description={
              properties.length === 0
                ? 'Add a property and a unit to see a rent roll.'
                : 'Every unit was excluded by the properties chosen above, or none is active at this date.'
            }
          />
        ) : (
          <DataTable
            caption="Rent roll"
            stickyHead
            minWidth="56rem"
            head={(
              <tr>
                <Th>Property</Th><Th>Unit</Th><Th>Resident</Th><Th>Lease</Th>
                <Th>Lease status</Th><Th>Occupied</Th>
                <Th numeric>Rent</Th><Th numeric>Receivable</Th>
              </tr>
            )}
          >
            {data.rows.map((r, i) => (
              <tr key={`${r.propertyName}-${r.unitCode}-${i}`}>
                <Td>{r.propertyName}</Td>
                <Td className="technical">{r.unitCode}</Td>
                <Td>
                  {r.residentName ?? <span className="text-ink-400">No resident</span>}
                </Td>
                <Td className="technical text-ink-500">{r.leaseReference ?? '—'}</Td>
                {/* Lease status and physical occupancy are different questions
                    and are answered in separate columns. A unit can be let and
                    empty, or occupied under a lease that has expired. */}
                <Td className="capitalize text-ink-700">
                  {r.leaseStatus ? r.leaseStatus.replace(/_/g, ' ') : '—'}
                </Td>
                <Td>{r.occupied
                  ? <StatusBadge tone="positive">Occupied</StatusBadge>
                  : <StatusBadge tone="neutral">Vacant</StatusBadge>}</Td>
                <Td numeric><Money minor={r.contractedRentMinor} currency={currency} tone="plain" /></Td>
                <Td numeric><Money minor={r.receivableMinor} currency={currency} tone="debt" emphasise={r.receivableMinor > 0n} /></Td>
              </tr>
            ))}
            <TotalRow
              span={6}
              label={`Total · ${data.rows.length} unit${data.rows.length === 1 ? '' : 's'} in scope`}
            >
              <Td numeric><Money minor={data.totalRentMinor} currency={currency} emphasise tone="plain" /></Td>
              <Td numeric><Money minor={data.totalReceivableMinor} currency={currency} emphasise tone="plain" /></Td>
            </TotalRow>
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
            <TotalRow span={2} label={`Total · ${data.rows.length} lease${data.rows.length === 1 ? '' : 's'}`}>
              <Td numeric><Money minor={data.totals.notYetDueMinor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.days1to30Minor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.days31to60Minor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.days61to90Minor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.daysOver90Minor!} currency={currency} /></Td>
              <Td numeric><Money minor={data.totals.totalMinor!} currency={currency} emphasise tone="plain" /></Td>
            </TotalRow>
          </DataTable>
        )
      ) : null}

      {data.kind === 'collection' ? (
        <>
          {/* Two labelled measures. Rent collection is the one a landlord
              means; the all-category rate includes utilities and recoveries.
              They are never averaged together into a single "collection". */}
          <div className="grid gap-4 sm:grid-cols-2">
            {([
              { title: 'Rent', m: data.totals.rent, note: 'Rent charges only. Deposits and utilities excluded.' },
              { title: 'All charges', m: data.totals.total, note: 'Rent, utilities, recoveries and every other billed category.' },
            ] as const).map(({ title, m, note }) => (
              <Panel key={title} title={title} description={m.ratePercent === null ? 'Nothing was billed for this period.' : note}>
                <dl className="grid grid-cols-3 gap-3 p-4">
                  <Figure label="Billed" value={<Money minor={m.billedMinor} currency={currency} tone="plain" />} />
                  <Figure label="Collected" value={<Money minor={m.collectedMinor} currency={currency} tone="plain" />} />
                  <Figure
                    label="Rate"
                    value={m.ratePercent === null ? 'Not available' : `${m.ratePercent.toFixed(2)}%`}
                    numeric={m.ratePercent !== null}
                  />
                </dl>
              </Panel>
            ))}
          </div>

          {/* Cash is a different question from collection, so it is reported
              separately rather than folded into the rate above. */}
          <Panel title="Cash movement" titleId="cash-movement">
            <dl className="grid gap-4 p-4 sm:grid-cols-3">
              <Figure
                label="Cash banked"
                value={<Money minor={data.totals.receiptsBankedMinor} currency={currency} tone="plain" />}
                hint="Confirmed receipts received in this period."
              />
              <Figure
                label="Applied to earlier periods"
                value={<Money minor={data.totals.priorPeriodCollectedMinor} currency={currency} tone="plain" />}
                hint="Allocated this period against older arrears."
              />
              <Figure
                label="Unapplied credit"
                value={<Money minor={data.totals.unappliedCreditMinor} currency={currency} tone="plain" />}
                hint="Confirmed money not yet allocated. Not counted as collected."
              />
            </dl>
          </Panel>

          <DataTable
            caption="Collection by lease"
            head={(
              <tr>
                <Th>Resident</Th><Th>Unit</Th>
                <Th numeric>Rent billed</Th><Th numeric>Rent collected</Th>
                <Th numeric>All billed</Th><Th numeric>All collected</Th>
                <Th numeric>Outstanding</Th>
              </tr>
            )}
          >
            {data.rows.map((r) => (
              <tr key={r.leaseId}>
                <Td>
                  <Link
                    href={`/app/${org}/leases/${r.leaseId}`}
                    className="font-medium text-spike-600 hover:underline"
                  >
                    {r.residentName ?? r.leaseReference}
                  </Link>
                </Td>
                <Td className="text-ink-500">{r.unitLabel}</Td>
                <Td numeric><Money minor={r.rentBilledMinor} currency={currency} /></Td>
                <Td numeric><Money minor={r.rentCollectedMinor} currency={currency} /></Td>
                <Td numeric className="text-ink-500"><Money minor={r.billedMinor} currency={currency} /></Td>
                <Td numeric className="text-ink-500"><Money minor={r.collectedMinor} currency={currency} /></Td>
                <Td numeric><Money minor={r.outstandingMinor} currency={currency} emphasise={r.outstandingMinor > 0n} /></Td>
              </tr>
            ))}
          </DataTable>
        </>
      ) : null}

      {data.kind === 'expenses' ? (
        <>
          <Panel title="Cost summary" titleId="cost-summary">
            <dl className="grid gap-4 p-4 sm:grid-cols-3">
              <Figure
                label="Operating"
                value={<Money minor={data.totalOperatingMinor} currency={currency} tone="plain" />}
                hint="Counts towards net operating income"
              />
              <Figure
                label="Capital"
                value={<Money minor={data.totalCapitalMinor} currency={currency} tone="plain" />}
                hint="Excluded from net operating income"
              />
              <Figure
                label="All costs"
                value={<Money minor={data.totalMinor} currency={currency} tone="plain" />}
              />
            </dl>
          </Panel>
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
