import { DataTable, EmptyState, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadInspections } from '@/lib/operations-queries';

export const metadata = { title: 'Inspections' };
export const dynamic = 'force-dynamic';

const STATUS: Record<string, { tone: StatusTone; label: string; glyph: string }> = {
  draft:        { tone: 'neutral',  label: 'Draft',        glyph: '○' },
  finalised:    { tone: 'info',     label: 'Finalised',    glyph: '●' },
  acknowledged: { tone: 'positive', label: 'Acknowledged', glyph: '✓' },
  disputed:     { tone: 'critical', label: 'Disputed',     glyph: '▲' },
  superseded:   { tone: 'neutral',  label: 'Superseded',   glyph: '↻' },
};

export default async function InspectionsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const inspections = await readAs(context.viewer, (tx) =>
    loadInspections(tx, context.organisationId),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inspections"
        description="Checklists are versioned. A finalised inspection is never edited — a correction creates a new version with a reason, and the original stays readable."
      />

      {inspections.length === 0 ? (
        <EmptyState
          title="No inspections yet"
          description="Move-in and move-out inspections record condition, photos and the resident's acknowledgement or dispute."
        />
      ) : (
        <DataTable
          caption="Inspections"
          head={
            <tr>
              <Th>Unit</Th><Th>Type</Th><Th>Checklist</Th>
              <Th numeric>Items</Th><Th>Performed</Th><Th>Status</Th><Th>Resident response</Th>
            </tr>
          }
        >
          {inspections.map((i) => {
            const status = STATUS[i.status] ?? STATUS.draft!;
            return (
              <tr key={i.id} className="hover:bg-ink-50">
                <Td className="font-medium">{i.unit_label}</Td>
                <Td className="capitalize">{i.inspection_type.replace(/_/g, ' ')}</Td>
                <Td className="text-ink-500">
                  {i.template_name}{' '}
                  <span className="text-xs text-ink-400">v{i.template_version}</span>
                </Td>
                <Td numeric className="tabular">{i.item_count}</Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {i.performed_on ? formatDate(i.performed_on, context.timeZone)
                    : i.scheduled_for ? `scheduled ${formatDate(i.scheduled_for, context.timeZone)}`
                    : '—'}
                </Td>
                <Td><StatusBadge tone={status.tone} glyph={status.glyph}>{status.label}</StatusBadge></Td>
                <Td>
                  {i.response === 'disputed' ? (
                    <StatusBadge tone="critical" glyph="▲">Disputed</StatusBadge>
                  ) : i.response === 'acknowledged' ? (
                    <StatusBadge tone="positive" glyph="✓">Acknowledged</StatusBadge>
                  ) : (
                    <span className="text-sm text-ink-400">Awaiting response</span>
                  )}
                </Td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </div>
  );
}
