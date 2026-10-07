import { Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { listSystemLeaseTemplates } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { NewSystemTemplate, NewVersionForm, PublishButton } from './template-upload';

export const metadata = { title: 'Lease templates' };
export const dynamic = 'force-dynamic';

/**
 * Lease templates Spike publishes to every customer.
 *
 * This is Spike's own content, which is why a platform operator may write it.
 * Customer records stay closed to them: the write policies here name
 * app.is_platform_operator(), and nothing on this page touches a customer table.
 */
export default async function SystemLeaseTemplatesPage() {
  const viewer = await requireViewer();
  const templates = await readAs(viewer, (tx) => listSystemLeaseTemplates(tx));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lease templates"
        description="Wording Spike offers every customer as a starting point. A customer copies one into their own templates; it never changes their wording afterwards."
      />

      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm font-semibold text-info-700">Publishing is a commitment</p>
        <p className="mt-1 text-sm text-ink-700">
          A published version is immutable and visible to every customer. Only publish wording Spike
          is entitled to distribute — if it came from a commercial lease pack, check that the licence
          permits redistribution to your customers, not just use by you. Record the source: customers
          see it before adopting.
        </p>
      </Card>

      <NewSystemTemplate />

      {templates.length === 0 ? (
        <EmptyState
          title="No system templates yet"
          description="Add one and publish it to make it available to every customer."
        />
      ) : (
        <DataTable
          caption="System lease templates"
          head={
            <tr>
              <Th>Name</Th><Th>Source</Th><Th>Status</Th>
              <Th>Published</Th><Th>Latest</Th><Th>Updated</Th><Th>Actions</Th>
            </tr>
          }
        >
          {templates.map((t) => (
            <tr key={t.id}>
              <Td>
                <span className="block font-medium text-ink-900">{t.name}</span>
                <span className="text-xs text-ink-500">{t.summary}</span>
              </Td>
              <Td className="max-w-[18rem] text-xs text-ink-500">{t.provenance}</Td>
              <Td>
                <StatusBadge tone={t.status === 'published' ? 'positive' : 'caution'}>
                  {t.status}
                </StatusBadge>
              </Td>
              <Td>{t.publishedVersion ? `v${t.publishedVersion}` : '—'}</Td>
              <Td>{t.latestVersion ? `v${t.latestVersion}` : '—'}</Td>
              <Td className="whitespace-nowrap text-ink-500">{formatDateTime(t.updatedAt)}</Td>
              <Td>
                <div className="space-y-1">
                  {t.latestVersion !== t.publishedVersion ? (
                    <PublishButton templateId={t.id} label={`Publish v${t.latestVersion}`} />
                  ) : (
                    <NewVersionForm templateId={t.id} />
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
