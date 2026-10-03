import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Money, PageHeader, StatusBadge, Td, Th, DataTable } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { loadTicketDetail } from '@/lib/operations-queries';
import { TicketActions } from './ticket-actions';

export const metadata = { title: 'Maintenance request' };
export const dynamic = 'force-dynamic';

const AUDIENCE: Record<string, { tone: 'neutral' | 'info' | 'caution'; label: string; glyph: string }> = {
  internal:           { tone: 'neutral', label: 'Internal only',      glyph: '🔒' },
  resident_visible:   { tone: 'info',    label: 'Visible to resident', glyph: '👤' },
  contractor_visible: { tone: 'caution', label: 'Visible to contractor', glyph: '🔧' },
};

export default async function TicketPage({
  params,
}: {
  params: Promise<{ org: string; ticketId: string }>;
}) {
  const { org, ticketId } = await params;
  const context = await requireOperator(org);
  const data = await readAs(context.viewer, (tx) =>
    loadTicketDetail(tx, context.organisationId, ticketId),
  );
  if (!data) notFound();
  const { ticket, events, comments, quotes, workOrders } = data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Request ${ticket.reference}`}
        description={`${ticket.unit_label} · ${ticket.category.replace(/_/g, ' ')}`}
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
              What was reported
            </h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink-900">{ticket.description}</p>
            {ticket.location ? (
              <p className="mt-3 text-sm text-ink-500">Location: {ticket.location}</p>
            ) : null}
            {ticket.access_notes ? (
              <p className="mt-1 text-sm text-ink-500">Access: {ticket.access_notes}</p>
            ) : null}
            <p className="mt-3 text-xs text-ink-400">
              Reported by {ticket.resident_name ?? 'an operator'} on{' '}
              {formatDateTime(ticket.created_at, context.timeZone)} as{' '}
              <strong>{ticket.urgency}</strong>
              {ticket.triaged_urgency && ticket.triaged_urgency !== ticket.urgency ? (
                <> · assessed by a manager as <strong>{ticket.triaged_urgency}</strong></>
              ) : null}
            </p>
          </Card>

          {/* Comments, with the audience shown on every single one so an
              operator can never be unsure who will read what they write. */}
          <section aria-labelledby="comments-heading" className="space-y-3">
            <h2 id="comments-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
              Comments
            </h2>
            {comments.length === 0 ? (
              <Card className="px-5 py-6 text-center text-sm text-ink-500">No comments yet.</Card>
            ) : (
              <div className="space-y-3">
                {comments.map((c) => {
                  const audience = AUDIENCE[c.audience] ?? AUDIENCE.internal!;
                  return (
                    <Card
                      key={c.id}
                      className={c.audience === 'internal' ? 'border-ink-200 bg-ink-50/70 p-4' : 'p-4'}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink-900">{c.author ?? 'Resident'}</span>
                        <StatusBadge tone={audience.tone} glyph={audience.glyph}>
                          {audience.label}
                        </StatusBadge>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-ink-700">{c.body}</p>
                      <p className="mt-2 text-xs text-ink-400">
                        {formatDateTime(c.created_at, context.timeZone)}
                      </p>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {quotes.length > 0 ? (
            <section aria-labelledby="quotes-heading" className="space-y-3">
              <h2 id="quotes-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Quotations
              </h2>
              <DataTable
                caption="Quotations for this request"
                dense
                head={<tr><Th>Contractor</Th><Th numeric>Amount</Th><Th>Status</Th></tr>}
              >
                {quotes.map((q) => (
                  <tr key={q.id}>
                    <Td>{q.vendor_name}</Td>
                    <Td numeric><Money minor={q.amount_minor} currency={q.currency_code} /></Td>
                    <Td className="capitalize">{q.status}</Td>
                  </tr>
                ))}
              </DataTable>
            </section>
          ) : null}

          {workOrders.length > 0 ? (
            <section aria-labelledby="orders-heading" className="space-y-3">
              <h2 id="orders-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Work orders and linked expense
              </h2>
              {workOrders.map((w) => (
                <Card key={w.id} className="p-4">
                  <p className="text-sm font-medium text-ink-900">{w.scope}</p>
                  <p className="mt-1 text-xs text-ink-500">
                    {w.vendor_name ?? 'Unassigned'} · {w.status}
                    {w.spending_ceiling_minor ? (
                      <> · ceiling <Money minor={w.spending_ceiling_minor} currency={w.currency_code} /></>
                    ) : null}
                  </p>
                  {w.expense_id ? (
                    <p className="mt-2 text-sm">
                      Expense recorded:{' '}
                      <Money minor={w.expense_amount_minor!} currency={w.currency_code} />{' '}
                      {w.expense_status === 'draft' ? (
                        <StatusBadge tone="caution" glyph="▲">
                          Over ceiling — awaiting approval
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="positive" glyph="✓">Approved</StatusBadge>
                      )}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-ink-500">No expense recorded yet.</p>
                  )}
                </Card>
              ))}
            </section>
          ) : null}
        </div>

        <div className="space-y-6">
          <TicketActions
            org={org}
            ticketId={ticketId}
            currentStatus={ticket.status}
          />

          {/* The complete transition history: submission, triage, approval,
              assignment, completion. Append-only, so reopening keeps it all. */}
          <section aria-labelledby="history-heading" className="space-y-3">
            <h2 id="history-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
              History
            </h2>
            <Card className="divide-y divide-ink-100">
              {events.map((e, index) => (
                <div key={index} className="px-4 py-3">
                  <p className="text-sm font-medium capitalize text-ink-900">
                    {e.from_status ? `${e.from_status.replace(/_/g, ' ')} → ` : ''}
                    {e.to_status.replace(/_/g, ' ')}
                  </p>
                  {e.note ? <p className="mt-1 text-sm text-ink-600">{e.note}</p> : null}
                  <p className="mt-1 text-xs text-ink-400">
                    {e.actor ?? 'Resident'} · {formatDateTime(e.occurred_at, context.timeZone)}
                  </p>
                </div>
              ))}
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
