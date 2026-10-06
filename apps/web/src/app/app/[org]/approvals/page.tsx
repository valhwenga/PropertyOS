import Link from 'next/link';
import { Card, EmptyState, Money, PageHeader, StatusBadge } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { loadPendingApprovals } from '@/lib/operations-queries';

export const metadata = { title: 'Pending approvals' };
export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const { quotes, deposits, expenses, runs } = await readAs(context.viewer, (tx) =>
    loadPendingApprovals(tx, context.organisationId),
  );

  const total = quotes.length + deposits.length + expenses.length + runs.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pending approvals"
        description="Everything in your scope waiting on an approval decision."
      />

      {total === 0 ? (
        <EmptyState title="Nothing waiting" description="No quotations, deposit movements, draft expenses or validated billing runs need a decision." />
      ) : (
        <div className="space-y-6">
          {runs.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Billing runs ready to post
              </h2>
              {runs.map((r) => (
                <Card key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-medium text-ink-900">Period {r.period_start.slice(0, 7)}</p>
                    <p className="text-xs text-ink-500">{r.line_count} charges</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <Money minor={r.totals_minor} currency={context.currencyCode} emphasise />
                    <Link href={`/app/${org}/billing/${r.id}`} className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
                      Review and post
                    </Link>
                  </div>
                </Card>
              ))}
            </section>
          ) : null}

          {quotes.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Maintenance quotations
              </h2>
              {quotes.map((q) => (
                <Card key={q.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-medium text-ink-900">{q.vendor_name}</p>
                    <p className="text-xs text-ink-500">Request {q.ticket_reference}</p>
                  </div>
                  <Money minor={q.amount_minor} currency={q.currency_code} emphasise />
                </Card>
              ))}
            </section>
          ) : null}

          {deposits.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Deposit movements
              </h2>
              {deposits.map((d) => (
                <Card key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-medium capitalize text-ink-900">{d.event_type}</p>
                    <p className="text-xs text-ink-500">{d.description}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Money minor={d.amount_minor} currency={d.currency_code} emphasise />
                    <StatusBadge tone="caution" glyph="◐">Needs evidence and approval</StatusBadge>
                  </div>
                </Card>
              ))}
            </section>
          ) : null}

          {expenses.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Draft expenses
              </h2>
              {expenses.map((e) => (
                <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-medium text-ink-900">{e.description}</p>
                    <p className="text-xs text-ink-500">
                      {e.property_name ?? 'Unassigned'}
                      {e.invoice_reference ? ` · invoice ${e.invoice_reference}` : ''}
                    </p>
                  </div>
                  <Money minor={e.amount_minor} currency={e.currency_code} emphasise />
                </Card>
              ))}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
