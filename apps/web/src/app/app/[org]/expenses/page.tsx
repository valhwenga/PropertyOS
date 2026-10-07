import { DataTable, EmptyState, Money, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { expenseReport } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';

export const metadata = { title: 'Expenses' };
export const dynamic = 'force-dynamic';

/** First and last day of the month a date falls in, as stored date strings. */
function monthBounds(iso: string): { periodStart: string; periodEnd: string } {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { periodStart: `${y}-${mm}-01`, periodEnd: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/**
 * Property costs for a period.
 *
 * Operating and capital are reported separately and never summed into a single
 * "spend" figure: one reduces the period's result, the other is added to the
 * asset. A reader who needs the combined number can add them deliberately.
 */
export default async function ExpensesPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { org } = await params;
  const { period } = await searchParams;
  const context = await requireOperator(org);

  const today = new Date().toISOString().slice(0, 10);
  const { periodStart, periodEnd } = monthBounds(
    /^\d{4}-\d{2}/.test(period ?? '') ? `${period}-01` : today,
  );

  const data = await readAs(context.viewer, (tx) =>
    expenseReport(tx, context.organisationId, { periodStart, periodEnd }));
  const currency = data.meta.currencyCode;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        description={`Costs dated ${formatDate(periodStart, context.timeZone)} to ${formatDate(periodEnd, context.timeZone)}.`}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Operating', value: data.totalOperatingMinor,
            note: 'Reduces the result for this period.' },
          { label: 'Capital', value: data.totalCapitalMinor,
            note: 'Added to the asset, not to this period.' },
          { label: 'All recorded costs', value: data.totalMinor,
            note: 'Operating and capital together.' },
        ].map((t) => (
          <div key={t.label} className="rounded-[var(--radius-card)] border border-ink-100 bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{t.label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">
              <Money minor={t.value} currency={currency} />
            </p>
            <p className="mt-1 text-xs text-ink-500">{t.note}</p>
          </div>
        ))}
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          title="No expenses in this period"
          description="Recorded property costs appear here, with operating and capital kept apart."
        />
      ) : (
        <DataTable
          caption={`Expenses ${periodStart} to ${periodEnd}`}
          head={
            <tr>
              <Th>Date</Th><Th>Property</Th><Th>Description</Th><Th>Vendor</Th>
              <Th>Class</Th><Th>Status</Th><Th numeric>Amount</Th>
            </tr>
          }
        >
          {data.rows.map((r, i) => (
            <tr key={`${r.expenseDate}-${i}`}>
              <Td className="whitespace-nowrap text-ink-500">
                {formatDate(r.expenseDate, context.timeZone)}
              </Td>
              <Td>{r.propertyName ?? '—'}</Td>
              <Td>
                <span className="block">{r.description}</span>
                <span className="text-xs capitalize text-ink-400">{r.category.replace(/_/g, ' ')}</span>
              </Td>
              <Td className="text-ink-500">{r.vendorName ?? '—'}</Td>
              <Td className="capitalize">{r.costClass.replace(/_/g, ' ')}</Td>
              <Td>
                <StatusBadge tone={r.status === 'draft' ? 'caution' : 'neutral'}>
                  {r.status.replace(/_/g, ' ')}
                </StatusBadge>
              </Td>
              <Td numeric><Money minor={r.amountMinor} currency={currency} /></Td>
            </tr>
          ))}
        </DataTable>
      )}

      {data.meta.qualifications.length > 0 ? (
        <ul className="space-y-1 text-xs text-ink-500">
          {data.meta.qualifications.map((q) => <li key={q}>{q}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
