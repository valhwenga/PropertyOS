import Link from 'next/link';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
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

  const groups = new Map<string, typeof LEASE_MERGE_FIELDS[number][]>();
  for (const field of LEASE_MERGE_FIELDS) {
    const list = groups.get(field.group) ?? [];
    list.push(field);
    groups.set(field.group, list);
  }

  const used = new Set(template.placeholders);

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

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <TemplateEditor
          org={org}
          templateId={templateId}
          body={template.body}
          draftVersionId={template.draftVersionId}
          publishedVersion={template.publishedVersion}
        />

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-ink-900">Placeholders</h2>
          <p className="mt-1 text-xs text-ink-500">
            Type any of these into the template. A field with no value is left visible as
            <code className="mx-1 rounded bg-ink-100 px-1">[its.name]</code> and listed on a
            final page — never silently blank.
          </p>
          <div className="mt-4 space-y-4">
            {[...groups].map(([group, fields]) => (
              <div key={group}>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{group}</p>
                <ul className="mt-1.5 space-y-1">
                  {fields.map((f) => (
                    <li key={f.key} className="text-xs">
                      <code
                        className={
                          used.has(f.key)
                            ? 'rounded bg-spike-50 px-1 text-spike-700'
                            : 'rounded bg-ink-100 px-1 text-ink-700'
                        }
                      >
                        {`{{${f.key}}}`}
                      </code>
                      <span className="ml-1.5 text-ink-500">{f.label}</span>
                      {f.sensitive ? (
                        <span className="ml-1 text-caution-700" title="Opens a sealed value">●</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-ink-500">
            <span className="text-caution-700">●</span> opens a sealed identity or account
            number. Generating is recorded in the audit trail.
          </p>
        </Card>
      </div>
    </div>
  );
}
