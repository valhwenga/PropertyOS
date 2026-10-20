import { notFound } from 'next/navigation';
import { Card, DataTable, Money, Td, Th } from '@propertyos/ui';
import { buildStatement, DomainError, listInvoicesForLease } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadTenancy } from '@/lib/portal-queries';
import { groupStatementEntries, splitDescription, summariseStatement } from '@/lib/statement-view';
import { todayIn } from '@/lib/today';
import { SectionHeading } from '../section';

export const metadata = { title: 'Your statement' };
export const dynamic = 'force-dynamic';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every charge and every payment, with the balance after each.
 *
 * Two things a resident could not do before: see what the period adds up to
 * without reading every row, and choose the period at all. The period they
 * choose is the period the PDF carries, because a statement somebody prints
 * and a statement they are looking at must be the same document.
 *
 * The allocations of one receipt are shown as one payment, with the detail
 * underneath. The R7,500 that cleared two charges is one thing that happened
 * to the person who paid it; the ledger still holds both allocations and the
 * running balance is the one after the last of them.
 */
export default async function StatementPage({
  params, searchParams,
}: {
  params: Promise<{ leaseId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { leaseId } = await params;
  const query = await searchParams;
  const viewer = await requireViewer();
  const link = viewer.residentLeases.find((l) => l.leaseId === leaseId);
  if (!link) notFound();

  const tenancy = await readAs(viewer, (tx) => loadTenancy(tx, leaseId));
  if (!tenancy) notFound();

  // A mistyped date shows the default and says so, rather than reaching
  // PostgreSQL as 'banana'::date and answering 500.
  const today = todayIn(tenancy.time_zone);
  const from = ISO.test(query.from ?? '') ? query.from : undefined;
  const to = ISO.test(query.to ?? '') ? query.to! : today;
  const reversed = Boolean(from && from > to);
  const ignored = (query.from && !from) || (query.to && !ISO.test(query.to)) || reversed;
  const cutOff = reversed ? today : to;
  const window = reversed ? undefined : from;

  const statement = await readAs(viewer, async (tx) => {
    try {
      return await buildStatement(tx, link.organisationId, {
        leaseId, from: window, cutOff,
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not_found') return null;
      throw error;
    }
  });
  if (!statement) notFound();

  // The invoices themselves, as documents. A statement says what the account
  // has done; an invoice says what was charged on one date and what reference
  // to quote — and a tenant asked for one often means the second.
  const invoices = await readAs(viewer, (tx) => listInvoicesForLease(tx, leaseId));

  const summary = summariseStatement(statement);
  const entries = groupStatementEntries(statement.lines);
  const currency = statement.currencyCode;
  const pdfQuery = new URLSearchParams({ cutOff, ...(window ? { from: window } : {}) });

  return (
    <section aria-labelledby="statement-heading" className="space-y-4">
      <SectionHeading
        id="statement-heading"
        action={
          <a
            href={`/portal/${leaseId}/statement.pdf?${pdfQuery.toString()}`}
            className="min-h-11 rounded-lg border border-ink-200 bg-surface px-3.5 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500"
          >
            Download PDF
          </a>
        }
      >
        Statement
      </SectionHeading>

      {/* ------------------------------------------------------- the period */}
      <Card className="p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink-700">From</span>
            <input type="date" name="from" defaultValue={window ?? ''}
                   className="min-h-11 rounded-lg border border-ink-200 bg-surface px-3 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink-700">As at</span>
            <input type="date" name="to" defaultValue={cutOff}
                   className="min-h-11 rounded-lg border border-ink-200 bg-surface px-3 text-sm" />
          </label>
          <button type="submit"
                  className="min-h-11 rounded-lg bg-spike-500 px-4 text-sm font-medium text-white hover:bg-spike-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500">
            Apply
          </button>
        </form>
        <p className="mt-3 text-xs text-ink-500">
          {window
            ? `Showing ${formatDate(window)} to ${formatDate(cutOff)}.`
            : `Showing everything up to ${formatDate(cutOff)}.`}
          {' '}The PDF covers the same period.
        </p>
        {ignored ? (
          <p className="mt-2 rounded-lg bg-caution-50 px-3 py-2 text-sm text-caution-700">
            Those dates could not be read, so this shows the default period.
          </p>
        ) : null}
      </Card>

      {/* ------------------------------------------------------- the totals */}
      <Card className="p-0">
        <dl className="grid grid-cols-2 divide-ink-100 sm:grid-cols-4 sm:divide-x">
          {([
            ['Opening balance', summary.openingMinor,
              statement.openingBalanceSource === 'no_prior_activity'
                ? 'Nothing before this period' : 'Carried into this period'],
            ['Charges', summary.chargesMinor, 'Rent, utilities and other charges raised'],
            ['Payments and credits', summary.paymentsMinor, 'Applied to those charges'],
            ['Closing balance', summary.closingMinor, 'What the account stands at'],
          ] as const).map(([label, value, hint], index) => (
            <div key={label} className={index < 2 ? 'border-b border-ink-100 p-4 sm:border-b-0' : 'p-4'}>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
              <dd className="mt-1 text-lg font-semibold text-ink-900">
                <Money minor={value} currency={currency} />
              </dd>
              <dd className="mt-0.5 text-xs text-ink-500">{hint}</dd>
            </div>
          ))}
        </dl>
        {!summary.balanced ? (
          <p className="border-t border-ink-100 bg-critical-50 px-4 py-3 text-sm text-critical-700">
            These totals do not reconcile with the closing balance. Please tell your landlord
            before relying on this statement.
          </p>
        ) : null}
      </Card>

      {entries.length === 0 ? (
        <Card className="px-4 py-8 text-center text-sm text-ink-500">
          Nothing was charged or paid in this period.
        </Card>
      ) : (
        <>
          {/* A phone first. `DataTable` is 640px wide at minimum and scrolls
              sideways inside its own box, which is right for an operator with a
              wide screen and wrong here: the two columns that matter were the
              two off the right-hand edge. */}
          <Card className="divide-y divide-ink-100 p-0 sm:hidden">
            {entries.map((entry) => (
              <div key={`m-${entry.key}`} className="px-4 py-3">
                <div className="flex gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink-900">{entry.description}</p>
                    <p className="text-xs text-ink-400">
                      {formatDate(entry.entryDate)} ·{' '}
                      <span className="tabular">{entry.reference}</span>
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium tabular">
                      {entry.debitMinor > 0n ? (
                        <Money minor={entry.debitMinor} currency={currency} />
                      ) : (
                        <span className="text-positive-600">
                          −<Money minor={entry.creditMinor} currency={currency} />
                        </span>
                      )}
                    </p>
                    <p className="text-xs tabular text-ink-400">
                      balance <Money minor={entry.runningBalanceMinor} currency={currency} />
                    </p>
                  </div>
                </div>
                {entry.parts.length > 0 || entry.note ? (
                  <details className="mt-2">
                    <summary className="min-h-11 cursor-pointer py-2 text-xs font-medium text-spike-600">
                      {entry.parts.length > 0 ? 'What this paid' : 'More detail'}
                    </summary>
                    <ul className="space-y-1">
                      {entry.parts.map((part, i) => (
                        <li key={`${part.reference}-${i}`} className="flex justify-between gap-3 text-xs text-ink-600">
                          <span>{splitDescription(part.description).lead}</span>
                          <span className="tabular">
                            <Money minor={part.creditMinor} currency={currency} />
                          </span>
                        </li>
                      ))}
                      {entry.note ? (
                        <li className="text-xs text-ink-500">{entry.note}</li>
                      ) : null}
                    </ul>
                  </details>
                ) : null}
              </div>
            ))}
          </Card>

          <div className="hidden sm:block">
            <DataTable
              caption={`Statement for lease ${statement.leaseReference}`}
              dense
              head={
                <tr>
                  <Th>Date</Th><Th>Description</Th><Th>Reference</Th>
                  <Th numeric>Charges</Th><Th numeric>Payments and credits</Th>
                  <Th numeric>Balance</Th>
                </tr>
              }
            >
              {entries.map((entry) => (
                <tr key={entry.key}>
                  <Td className="whitespace-nowrap text-ink-500">{formatDate(entry.entryDate)}</Td>
                  <Td>
                    <span className="block">{entry.description}</span>
                    {entry.parts.length > 0 || entry.note ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs font-medium text-spike-600">
                          {entry.parts.length > 0 ? 'What this paid' : 'More detail'}
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {entry.parts.map((part, i) => (
                            <li key={`${part.reference}-${i}`} className="text-xs text-ink-600">
                              <Money minor={part.creditMinor} currency={currency} /> —{' '}
                              {splitDescription(part.description).lead}
                            </li>
                          ))}
                          {entry.note ? (
                            <li className="text-xs text-ink-500">{entry.note}</li>
                          ) : null}
                        </ul>
                      </details>
                    ) : null}
                  </Td>
                  <Td className="tabular text-xs text-ink-400">{entry.reference}</Td>
                  <Td numeric className="tabular">
                    {entry.debitMinor > 0n
                      ? <Money minor={entry.debitMinor} currency={currency} />
                      : <span className="text-ink-300">—</span>}
                  </Td>
                  <Td numeric className="tabular">
                    {entry.creditMinor > 0n
                      ? <span className="text-positive-600">
                          −<Money minor={entry.creditMinor} currency={currency} />
                        </span>
                      : <span className="text-ink-300">—</span>}
                  </Td>
                  <Td numeric className="tabular">
                    <Money minor={entry.runningBalanceMinor} currency={currency} />
                  </Td>
                </tr>
              ))}
            </DataTable>
          </div>
        </>
      )}

      {invoices.length > 0 ? (
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-ink-900">Your invoices</h3>
          <p className="mt-0.5 text-xs text-ink-500">
            Each one is the document your landlord issued, with the reference to quote when
            you pay. It shows what was charged on its own date, not what is outstanding now.
          </p>
          <ul className="mt-3 divide-y divide-ink-100">
            {invoices.map((invoice) => (
              <li key={invoice.documentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <a
                  href={`/portal/${leaseId}/invoices/${invoice.documentId}/invoice.pdf`}
                  className="min-h-11 content-center text-sm font-medium text-spike-600 hover:underline"
                >
                  {invoice.documentNumber} (PDF)
                </a>
                <span className="text-xs text-ink-500">
                  issued {formatDate(invoice.issueDate)} · due {formatDate(invoice.dueDate)}
                </span>
                <span className="ml-auto text-sm tabular text-ink-700">
                  <Money minor={invoice.totalMinor} currency={invoice.currencyCode} />
                </span>
                {invoice.reversed ? (
                  <span className="w-full text-xs font-medium text-caution-700">
                    Cancelled by a credit note — do not pay this one.
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <p className="text-xs text-ink-500">
        Built from posted records as at {formatDate(cutOff)}. A payment you have told us about
        is not on this statement until it has been confirmed and applied.
      </p>
    </section>
  );
}
