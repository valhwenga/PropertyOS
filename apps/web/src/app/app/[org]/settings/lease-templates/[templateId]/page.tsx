import Link from 'next/link';
import { PageHeader, StatusBadge } from '@propertyos/ui';
import { LEASE_MERGE_FIELDS, getLeaseTemplate } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { TemplateEditor } from './template-editor';

export const metadata = { title: 'Edit lease template' };
export const dynamic = 'force-dynamic';

export default async function TemplatePage({
  params,
}: {
  params: Promise<{ org: string; templateId: string }>;
}) {
  const { org, templateId } = await params;
  const context = await requireOperator(org);
  const template = await readAs(context.viewer, (tx) =>
    getLeaseTemplate(tx, context.organisationId, templateId),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={template.name}
        description={template.sourceNote ?? 'Your lease wording, with placeholders PropertyOS fills in.'}
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link className="text-spike-600 hover:underline" href={`/app/${org}/settings/lease-templates`}>
          ← All templates
        </Link>
        <span className="text-ink-200">·</span>
        {template.publishedVersion ? (
          <StatusBadge tone="positive">Published v{template.publishedVersion}</StatusBadge>
        ) : (
          <StatusBadge tone="caution">Never published</StatusBadge>
        )}
        {template.draftVersionId ? (
          <StatusBadge tone="info">Draft v{template.latestVersion}</StatusBadge>
        ) : null}
      </div>

      <TemplateEditor
        org={org}
        templateId={templateId}
        body={template.body}
        draftVersionId={template.draftVersionId}
        publishedVersion={template.publishedVersion}
        fields={LEASE_MERGE_FIELDS.map((f) => ({
          key: f.key, label: f.label, group: f.group, sensitive: f.sensitive,
        }))}
      />
    </div>
  );
}
