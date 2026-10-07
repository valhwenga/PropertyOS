import Link from 'next/link';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import { previewLeaseAgreement, DomainError } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';

export const metadata = { title: 'Agreement preview' };
export const dynamic = 'force-dynamic';

/**
 * What the agreement will say, before anyone receives it.
 *
 * Nothing is written by opening this page: no document, no generation record,
 * no disclosure. It exists so a missing field is found before a resident gets
 * the lease, rather than after they have signed it.
 */
export default async function AgreementPreviewPage({
  params, searchParams,
}: {
  params: Promise<{ org: string; leaseId: string }>;
  searchParams: Promise<{ template?: string }>;
}) {
  const { org, leaseId } = await params;
  const { template } = await searchParams;
  const context = await requireOperator(org);
  const back = `/app/${org}/leases/${leaseId}`;

  if (!template) {
    return (
      <div className="space-y-4">
        <PageHeader title="Agreement preview" description="Choose a template on the lease first." />
        <Link href={back} className="text-sm text-spike-700 hover:underline">← Back to the lease</Link>
      </div>
    );
  }

  const result = await readAs(context.viewer, async (tx) => {
    try {
      return { ok: true as const, preview: await previewLeaseAgreement(tx, context.organisationId, { leaseId, templateId: template }) };
    } catch (error) {
      if (error instanceof DomainError) return { ok: false as const, message: error.message };
      throw error;
    }
  });

  if (!result.ok) {
    return (
      <div className="space-y-4">
        <PageHeader title="Agreement preview" description="This agreement cannot be previewed yet." />
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm text-ink-700">{result.message}</p>
        </Card>
        <Link href={back} className="text-sm text-spike-700 hover:underline">← Back to the lease</Link>
      </div>
    );
  }

  const { preview } = result;
  const incomplete = preview.missing.length > 0 || preview.unknown.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Preview · ${preview.leaseReference}`}
        description={`${preview.templateName} v${preview.version}. Nothing has been generated or sent.`}
      />

      <Link href={back} className="inline-block text-sm text-spike-700 hover:underline">
        ← Back to the lease
      </Link>

      {incomplete ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <StatusBadge tone="caution" glyph="▲">Incomplete</StatusBadge>
          {preview.missing.length > 0 ? (
            <>
              <p className="mt-2 text-sm font-medium text-ink-900">
                {preview.missing.length} field{preview.missing.length === 1 ? '' : 's'} this lease
                cannot supply
              </p>
              <p className="mt-1 text-sm text-ink-700">
                Each prints in the document as <code>[field.name]</code>. Fill them in on the lease,
                the landlord particulars or the resident before you send this.
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {preview.missing.map((m) => (
                  <li key={m} className="tabular rounded bg-surface px-2 py-0.5 text-xs text-ink-700">{m}</li>
                ))}
              </ul>
            </>
          ) : null}
          {preview.unknown.length > 0 ? (
            <>
              <p className="mt-3 text-sm font-medium text-ink-900">
                {preview.unknown.length} placeholder{preview.unknown.length === 1 ? '' : 's'} that
                {preview.unknown.length === 1 ? ' is' : ' are'} not a field
              </p>
              <p className="mt-1 text-sm text-ink-700">
                Usually a typo in the template wording. These can never be filled.
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {preview.unknown.map((m) => (
                  <li key={m} className="tabular rounded bg-surface px-2 py-0.5 text-xs text-critical-700">{m}</li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      ) : (
        <Card className="border-positive-600/25 bg-positive-50 p-4">
          <StatusBadge tone="positive" glyph="✓">Every field is filled</StatusBadge>
          <p className="mt-2 text-sm text-ink-700">
            Nothing in this agreement is left blank or unresolved.
          </p>
        </Card>
      )}

      <Card className="p-0">
        <div className="border-b border-ink-100 px-4 py-2">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            The document, as it will read
          </p>
        </div>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap px-4 py-3 text-xs leading-relaxed text-ink-900">
          {preview.text}
        </pre>
      </Card>

      <Card className="p-4">
        <p className="text-sm font-medium text-ink-900">Generating is the next step</p>
        <p className="mt-1 text-sm text-ink-500">
          This page wrote nothing. Go back to the lease to generate the PDF, then send it — the
          resident only receives it when you choose to send.
        </p>
      </Card>
    </div>
  );
}
