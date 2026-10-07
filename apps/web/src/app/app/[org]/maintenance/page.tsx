import Link from 'next/link';
import { DataTable, EmptyState, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadTickets } from '@/lib/operations-queries';

export const metadata = { title: 'Maintenance' };
export const dynamic = 'force-dynamic';

const STATUS: Record<string, { tone: StatusTone; glyph: string; label: string }> = {
  submitted:             { tone: 'info',     glyph: '●', label: 'Submitted' },
  triaged:               { tone: 'info',     glyph: '◐', label: 'Triaged' },
  awaiting_approval:     { tone: 'caution',  glyph: '◐', label: 'Awaiting approval' },
  assigned:              { tone: 'info',     glyph: '◑', label: 'Assigned' },
  in_progress:           { tone: 'info',     glyph: '◕', label: 'In progress' },
  awaiting_confirmation: { tone: 'caution',  glyph: '◕', label: 'Awaiting confirmation' },
  resolved:              { tone: 'positive', glyph: '✓', label: 'Resolved' },
  closed:                { tone: 'neutral',  glyph: '■', label: 'Closed' },
  on_hold:               { tone: 'caution',  glyph: '⏸', label: 'On hold' },
  cancelled:             { tone: 'neutral',  glyph: '✕', label: 'Cancelled' },
};

const URGENCY: Record<string, { tone: StatusTone; glyph: string }> = {
  emergency: { tone: 'critical', glyph: '▲' },
  high:      { tone: 'caution',  glyph: '▲' },
  normal:    { tone: 'neutral',  glyph: '●' },
  low:       { tone: 'neutral',  glyph: '○' },
};

export default async function MaintenancePage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { org } = await params;
  const { filter } = await searchParams;
  const context = await requireOperator(org);
  const scope = filter === 'open' ? 'open' : 'all';
  const tickets = await readAs(context.viewer, (tx) =>
    loadTickets(tx, context.organisationId, scope),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Maintenance"
        description="Reported issues across your assigned properties. Internal notes are never visible to residents or contractors."
        actions={
          <>
            <Link
              href={`/app/${org}/maintenance${scope === 'open' ? '' : '?filter=open'}`}
              className="rounded-lg border border-ink-200 bg-surface px-3.5 py-2 text-sm font-medium text-ink-700"
            >
              {scope === 'open' ? 'Show all' : 'Show open only'}
            </Link>
            <Link
              href={`/app/${org}/maintenance/new`}
              className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
            >
              Log a request
            </Link>
          </>
        }
      />

      {tickets.length === 0 ? (
        <EmptyState
          title={scope === 'open' ? 'Nothing open' : 'No maintenance requests yet'}
          description={
            scope === 'open'
              ? 'Every request in your scope is resolved, closed or cancelled.'
              : 'Requests logged by you or submitted by residents through the portal will appear here.'
          }
        />
      ) : (
        <DataTable
          caption="Maintenance requests"
          head={
            <tr>
              <Th>Reference</Th><Th>Unit</Th><Th>Issue</Th><Th>Reported by</Th>
              <Th>Urgency</Th><Th>Status</Th><Th>Logged</Th>
            </tr>
          }
        >
          {tickets.map((t) => {
            const status = STATUS[t.status] ?? { tone: 'neutral' as StatusTone, glyph: '○', label: t.status };
            const effective = t.triaged_urgency ?? t.urgency;
            const urgency = URGENCY[effective] ?? URGENCY.normal!;
            return (
              <tr key={t.id} className="hover:bg-ink-50">
                <Td>
                  <Link href={`/app/${org}/maintenance/${t.id}`} className="font-medium text-spike-600 hover:underline">
                    {t.reference}
                  </Link>
                </Td>
                <Td className="text-ink-500">{t.unit_label}</Td>
                <Td>
                  <span className="block capitalize">{t.category.replace(/_/g, ' ')}</span>
                  <span className="line-clamp-1 text-xs text-ink-400">{t.description}</span>
                </Td>
                <Td className="text-ink-500">{t.resident_name ?? 'Operator'}</Td>
                <Td>
                  <StatusBadge tone={urgency.tone} glyph={urgency.glyph}>
                    {effective}
                  </StatusBadge>
                  {t.triaged_urgency && t.triaged_urgency !== t.urgency ? (
                    <span className="mt-0.5 block text-xs text-ink-400">
                      resident reported {t.urgency}
                    </span>
                  ) : null}
                </Td>
                <Td><StatusBadge tone={status.tone} glyph={status.glyph}>{status.label}</StatusBadge></Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDate(t.created_at, context.timeZone)}
                </Td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </div>
  );
}
