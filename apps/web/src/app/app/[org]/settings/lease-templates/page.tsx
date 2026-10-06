import Link from 'next/link';
import { Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { listLeaseTemplates } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { NewTemplateForm } from './new-template-form';

export const metadata = { title: 'Lease templates' };
export const dynamic = 'force-dynamic';

export default async function LeaseTemplatesPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);
  const templates = await readAs(context.viewer, (tx) =>
    listLeaseTemplates(tx, context.organisationId),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lease templates"
        description="Your own lease wording, with placeholders PropertyOS fills from the lease, the parties and the property."
      />

      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm font-semibold text-info-700">The wording is yours</p>
        <p className="mt-1 text-sm text-ink-700">
          PropertyOS supplies the fields, never the clauses. Paste in the agreement your
          attorney or your lease pack provider gives you — if it is licensed to you, check
          whether that licence also covers adapting it. Record where it came from in
          &ldquo;source&rdquo; so anyone reading it later knows.
        </p>
      </Card>

      {templates.length === 0 ? (
        <EmptyState
          title="No templates yet"
          description="Create one, paste your lease wording, drop in the placeholders, then publish it."
        />
      ) : (
        <DataTable
          caption="Lease agreement templates"
          head={
            <tr>
              <Th>Template</Th>
              <Th>Layout</Th>
              <Th>Published</Th>
              <Th>Latest draft</Th>
              <Th>Updated</Th>
            </tr>
          }
        >
          {templates.map((t) => (
              <tr key={t.id}>
                <Td>
                  <Link
                    className="font-medium text-spike-600 hover:underline"
                    href={`/app/${org}/settings/lease-templates/${t.id}`}
                  >
                    {t.name}
                  </Link>
                  {t.sourceNote ? (
                    <span className="block text-xs text-ink-500">{t.sourceNote}</span>
                  ) : null}
                </Td>
                <Td>{t.layout === 'schedule' ? 'Schedule' : 'Inline'}</Td>
                <Td>
                  {t.publishedVersion ? (
                    <StatusBadge tone="positive">v{t.publishedVersion}</StatusBadge>
                  ) : (
                    <StatusBadge tone="caution">Not published</StatusBadge>
                  )}
                </Td>
                <Td>{t.latestVersion ? `v${t.latestVersion}` : '—'}</Td>
                <Td>{formatDateTime(t.updatedAt)}</Td>
              </tr>
          ))}
        </DataTable>
      )}

      <NewTemplateForm org={org} />
    </div>
  );
}
