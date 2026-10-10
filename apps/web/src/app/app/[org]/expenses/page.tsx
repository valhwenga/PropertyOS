import Link from 'next/link';
import { DataTable, EmptyState, Money, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { expenseReport, hasPermission, listExpenses, listVendors } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadInvoiceChoices, loadPropertyChoices } from '@/lib/operations-queries';
import { AddVendorForm, RecordExpenseForm } from './expense-forms';

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

  const { data, expenses, properties, vendors, invoices, canRecord } =
    await readAs(context.viewer, async (tx) => ({
      data: await expenseReport(tx, context.organisationId, { periodStart, periodEnd }),
      expenses: await listExpenses(tx, context.organisationId),
      properties: await loadPropertyChoices(tx, context.organisationId),
      vendors: await listVendors(tx, context.organisationId),
      invoices: await loadInvoiceChoices(tx, context.organisationId),
      canRecord: await hasPermission(tx, context.organisationId, 'expense.record'),
    }));
  const currency = data.meta.currencyCode;
  const inPeriod = expenses.filter(
    (e) => e.expenseDate >= periodStart && e.expenseDate <= periodEnd,
  );
  const drafts = expenses.filter((e) => e.status === 'draft');
  const unpaid = expenses.filter((e) => e.status === 'posted');
  const propertyChoices = properties.map((p) => ({ id: p.id, label: `${p.name} (${p.code})` }));
  const vendorChoices = vendors.map((v) => ({ id: v.id, label: v.name }));
  const invoiceChoices = invoices.map((d) => ({
    id: d.id, label: `${d.title} — ${formatDate(d.uploaded_at, context.timeZone)}`,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        description={`Costs dated ${formatDate(periodStart, context.timeZone)} to ${formatDate(periodEnd, context.timeZone)}.`}
        actions={
          canRecord ? (
            <div className="flex flex-wrap gap-2">
              <AddVendorForm org={org} />
              <RecordExpenseForm
                org={org} properties={propertyChoices} vendors={vendorChoices}
                invoices={invoiceChoices} today={today}
              />
            </div>
          ) : undefined
        }
      />

      {drafts.length > 0 || unpaid.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {drafts.length > 0 ? (
            <div className="rounded-[var(--radius-card)] border border-caution-700/30 bg-caution-50 p-4">
              <p className="text-sm font-semibold text-caution-700">
                {drafts.length} cost{drafts.length === 1 ? '' : 's'} awaiting approval
              </p>
              <p className="mt-1 text-sm text-ink-700">
                A draft is in nobody&rsquo;s accounts yet. It reaches the ledger when it is
                approved.
              </p>
              <ul className="mt-2 space-y-1">
                {drafts.slice(0, 5).map((e) => (
                  <li key={e.id} className="text-sm">
                    <Link
                      href={`/app/${org}/expenses/${e.id}`}
                      className="font-medium text-spike-600 hover:underline"
                    >
                      {e.description}
                    </Link>
                    <span className="ml-1.5 text-ink-500">
                      <Money minor={e.amountMinor} currency={e.currencyCode} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {unpaid.length > 0 ? (
            <div className="rounded-[var(--radius-card)] border border-ink-100 bg-surface p-4">
              <p className="text-sm font-semibold text-ink-900">
                {unpaid.length} approved and unpaid
              </p>
              <p className="mt-1 text-sm text-ink-500">
                Owed to suppliers. The cost is already in the result; the money has not left the
                bank.
              </p>
              <ul className="mt-2 space-y-1">
                {unpaid.slice(0, 5).map((e) => (
                  <li key={e.id} className="text-sm">
                    <Link
                      href={`/app/${org}/expenses/${e.id}`}
                      className="font-medium text-spike-600 hover:underline"
                    >
                      {e.description}
                    </Link>
                    <span className="ml-1.5 text-ink-500">
                      <Money minor={e.amountMinor} currency={e.currencyCode} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

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

      {/* The rows come from the expense list rather than the report, because a
          row a reader cannot open is a row they cannot check. The totals above
          stay with the report, which carries its own qualifications. */}
      {inPeriod.length === 0 ? (
        <EmptyState
          title="No expenses in this period"
          description="Recorded property costs appear here, with operating and capital kept apart."
          action={
            canRecord ? (
              <RecordExpenseForm
                org={org} properties={propertyChoices} vendors={vendorChoices}
                invoices={invoiceChoices} today={today}
              />
            ) : undefined
          }
        />
      ) : (
        <DataTable
          caption={`Expenses ${periodStart} to ${periodEnd}`}
          head={
            <tr>
              <Th>Date</Th><Th>Property</Th><Th>Description</Th><Th>Supplier</Th>
              <Th>Class</Th><Th>Status</Th><Th numeric>Amount</Th>
            </tr>
          }
        >
          {inPeriod.map((e) => (
            <tr key={e.id} className="hover:bg-ink-50">
              <Td className="whitespace-nowrap text-ink-500">
                {formatDate(e.expenseDate, context.timeZone)}
              </Td>
              <Td>{e.propertyName ?? '—'}</Td>
              <Td>
                <Link
                  href={`/app/${org}/expenses/${e.id}`}
                  className="font-medium text-spike-600 hover:underline"
                >
                  {e.description}
                </Link>
                <span className="block text-xs capitalize text-ink-400">
                  {e.category.replace(/_/g, ' ')}
                </span>
              </Td>
              <Td className="text-ink-500">{e.vendorName ?? '—'}</Td>
              <Td className="capitalize">{e.costClass.replace(/_/g, ' ')}</Td>
              <Td>
                <StatusBadge
                  tone={
                    e.status === 'draft' ? 'caution'
                      : e.status === 'paid' ? 'positive'
                        : e.status === 'void' ? 'neutral' : 'info'
                  }
                >
                  {e.status}
                </StatusBadge>
              </Td>
              <Td numeric><Money minor={e.amountMinor} currency={e.currencyCode} /></Td>
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
