import Link from 'next/link';
import { DataTable, EmptyState, Money, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import {
  countExpenses, expenseReport, hasPermission, listExpenses, listVendors,
} from '@propertyos/domain';
import { pageHref, readPaging, summarise } from '@/lib/listing';
import { ListSelect, ListToolbar, PageBar } from '@/components/list-controls';
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
/**
 * The states a cost passes through, as the queues that matter.
 *
 * Draft is waiting for an approver; posted is waiting for the money to leave
 * the bank. Both are somebody's work, which is why each has its own tile on
 * the overview and its own link here.
 *
 * The check constraint also allows 'approved', and nothing writes it: approval
 * posts the cost to accounts payable in the same step, so a cost is never
 * approved and unposted. Offering it would be a filter that can never match.
 */
const STATUSES = [
  { value: 'draft', label: 'Awaiting approval' },
  { value: 'posted', label: 'Approved, unpaid' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
] as const;

export default async function ExpensesPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ period?: string; status?: string; page?: string }>;
}) {
  const { org } = await params;
  const query = await searchParams;
  const { period } = query;
  const context = await requireOperator(org);

  const today = new Date().toISOString().slice(0, 10);
  const { periodStart, periodEnd } = monthBounds(
    /^\d{4}-\d{2}/.test(period ?? '') ? `${period}-01` : today,
  );

  // A status asked for from the dashboard means "every one of these, whatever
  // its date": an approver clicking "approved, not yet paid" wants the whole
  // payables queue, not the part of it that happens to fall in this month.
  // The period still governs the totals above, which are a period measure.
  const status = STATUSES.some((s) => s.value === query.status) ? query.status : undefined;
  const paging = readPaging(query.page);
  const bounds = status ? {} : { from: periodStart, to: periodEnd };

  const { data, expenses, listTotal, drafts, unpaid, properties, vendors, invoices, canRecord } =
    await readAs(context.viewer, async (tx) => ({
      data: await expenseReport(tx, context.organisationId, { periodStart, periodEnd }),
      expenses: await listExpenses(tx, context.organisationId, {
        ...bounds, status, limit: paging.limit, offset: paging.offset,
      }),
      listTotal: await countExpenses(tx, context.organisationId, { ...bounds, status }),
      drafts: await countExpenses(tx, context.organisationId, { status: 'draft' }),
      unpaid: await countExpenses(tx, context.organisationId, { status: 'posted' }),
      properties: await loadPropertyChoices(tx, context.organisationId),
      vendors: await listVendors(tx, context.organisationId),
      invoices: await loadInvoiceChoices(tx, context.organisationId),
      canRecord: await hasPermission(tx, context.organisationId, 'expense.record'),
    }));
  const currency = data.meta.currencyCode;
  const inPeriod = expenses;
  const summary = summarise(paging, expenses.length, listTotal, Boolean(status));
  const propertyChoices = properties.map((p) => ({ id: p.id, label: `${p.name} (${p.code})` }));
  const vendorChoices = vendors.map((v) => ({ id: v.id, label: v.name }));
  const invoiceChoices = invoices.map((d) => ({
    id: d.id, label: `${d.title} — ${formatDate(d.uploaded_at, context.timeZone)}`,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        description={status
          ? `Every ${STATUSES.find((s) => s.value === status)!.label.toLowerCase()} cost, whatever its date.`
          : `Costs dated ${formatDate(periodStart, context.timeZone)} to ${formatDate(periodEnd, context.timeZone)}.`}
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

      {/* Two queues, each a link into the list filtered to it. They used to
          print the first five and stop, which answers "what is waiting?" with
          a number and then shows a different, smaller one. */}
      {drafts > 0 || unpaid > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {drafts > 0 ? (
            <Link
              href={`/app/${org}/expenses?status=draft`}
              className="block rounded-[var(--radius-card)] border border-caution-700/30 bg-surface p-4 hover:border-spike-300"
            >
              <p className="text-sm font-semibold text-ink-900">
                {drafts} cost{drafts === 1 ? '' : 's'} awaiting approval
              </p>
              <p className="mt-1 text-sm text-ink-500">
                A draft is in nobody&rsquo;s accounts yet. It reaches the ledger when it is
                approved.
              </p>
              <p className="mt-2 text-sm font-medium text-spike-600">Work the queue →</p>
            </Link>
          ) : null}
          {unpaid > 0 ? (
            <Link
              href={`/app/${org}/expenses?status=posted`}
              className="block rounded-[var(--radius-card)] border border-caution-700/30 bg-surface p-4 hover:border-spike-300"
            >
              <p className="text-sm font-semibold text-ink-900">
                {unpaid} approved and unpaid
              </p>
              <p className="mt-1 text-sm text-ink-500">
                Owed to suppliers. The cost is already in the result; the money has not left the
                bank.
              </p>
              <p className="mt-2 text-sm font-medium text-spike-600">Work the queue →</p>
            </Link>
          ) : null}
        </div>
      ) : null}

      <ListToolbar
        action={`/app/${org}/expenses`}
        query={undefined}
        placeholder=""
        customised={Object.keys(query).length > 0}
      >
        <ListSelect
          name="status"
          label="Status"
          value={status}
          anyLabel="This period, any status"
          options={STATUSES}
        />
        {period ? <input type="hidden" name="period" value={period} /> : null}
      </ListToolbar>

      <PageBar summary={summary} href={(page) => `/app/${org}/expenses${pageHref(query, page)}`} />

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
        <>
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
        </>
      )}

      {data.meta.qualifications.length > 0 ? (
        <ul className="space-y-1 text-xs text-ink-500">
          {data.meta.qualifications.map((q) => <li key={q}>{q}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
