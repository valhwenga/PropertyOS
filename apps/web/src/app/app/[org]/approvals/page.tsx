import Link from 'next/link';
import { Card, EmptyState, Money, PageHeader } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadPendingApprovals } from '@/lib/operations-queries';

export const metadata = { title: 'Pending approvals' };
export const dynamic = 'force-dynamic';

/**
 * The approvals queue.
 *
 * It used to list four kinds of work and could resolve one of them: billing
 * runs linked to a screen that posts them, and the other three were read-only
 * cards. Maintenance quotations had no approval interface anywhere in the
 * product, and the deposit section read `deposit_events` where
 * `approved_at is null` — a row the database forbids — so it could never show
 * anything at all.
 *
 * Every row now goes to the screen that owns the decision, and says what the
 * decision is. The decision itself is not duplicated here: a financial rule
 * recreated in two places is a financial rule that will disagree with itself.
 */

/** One waiting item, rendered the same way whatever it is. */
function Row({
  title, detail, href, action, children,
}: {
  title: string; detail: string; href: string; action: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="font-medium text-ink-900">{title}</p>
        <p className="text-xs text-ink-500">{detail}</p>
      </div>
      <div className="flex items-center gap-4">
        {children}
        <Link
          href={href}
          className="whitespace-nowrap rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-spike-600"
        >
          {action}
        </Link>
      </div>
    </Card>
  );
}

export default async function ApprovalsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const { quotes, payoutRequests, expenses, runs } = await readAs(context.viewer, (tx) =>
    loadPendingApprovals(tx, context.organisationId),
  );

  const total = quotes.length + payoutRequests.length + expenses.length + runs.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pending approvals"
        description="Everything in your scope waiting on a decision. Each one opens where the decision is made and recorded — nothing is approved from this list."
      />

      {total === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="No quotations, deposit payouts, draft expenses or validated billing runs need a decision."
        />
      ) : (
        <div className="space-y-6">
          {runs.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Billing runs ready to post
              </h2>
              {runs.map((r) => (
                <Row
                  key={r.id}
                  title={`Period ${r.period_start.slice(0, 7)}`}
                  detail={`${r.line_count} charges prepared and validated, not yet posted`}
                  href={`/app/${org}/billing/${r.id}`}
                  action="Review and post"
                >
                  <Money minor={r.totals_minor} currency={context.currencyCode} emphasise />
                </Row>
              ))}
            </section>
          ) : null}

          {payoutRequests.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Deposit payouts
              </h2>
              <p className="text-sm text-ink-500">
                Somebody else&rsquo;s money. Nothing here has moved: a request holds nothing
                until it is approved, and the person who raised it cannot approve it.
              </p>
              {payoutRequests.map((d) => (
                <Row
                  key={d.id}
                  title={`${d.kind.replace(/_/g, ' ')} — ${d.description}`}
                  detail={
                    `${d.unit_label ?? 'No unit'} · requested by `
                    + `${d.requested_by_name ?? 'a colleague'} on `
                    + formatDate(d.requested_at, context.timeZone)
                  }
                  href={`/app/${org}/deposits/${d.deposit_account_id}`}
                  action="Decide"
                >
                  <Money minor={d.amount_minor} currency={d.currency_code} emphasise />
                </Row>
              ))}
            </section>
          ) : null}

          {quotes.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Maintenance quotations
              </h2>
              <p className="text-sm text-ink-500">
                Approving one issues a work order with a spending ceiling. No cost reaches the
                books until the supplier&rsquo;s invoice is recorded against completed work.
              </p>
              {quotes.map((q) => (
                <Row
                  key={q.id}
                  title={q.vendor_name}
                  detail={`Request ${q.ticket_reference}`}
                  href={`/app/${org}/maintenance/${q.ticket_id}`}
                  action="Approve or decline"
                >
                  <Money minor={q.amount_minor} currency={q.currency_code} emphasise />
                </Row>
              ))}
            </section>
          ) : null}

          {expenses.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Draft expenses
              </h2>
              <p className="text-sm text-ink-500">
                Recorded but not in anyone&rsquo;s accounts. Approving posts the cost against
                the property and raises what the supplier is owed; it pays nobody.
              </p>
              {expenses.map((e) => (
                <Row
                  key={e.id}
                  title={e.description}
                  detail={
                    `${e.property_name ?? 'Unassigned'}`
                    + `${e.invoice_reference ? ` · invoice ${e.invoice_reference}` : ''}`
                  }
                  href={`/app/${org}/expenses/${e.id}`}
                  action="Approve or void"
                >
                  <Money minor={e.amount_minor} currency={e.currency_code} emphasise />
                </Row>
              ))}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
