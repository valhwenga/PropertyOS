import { notFound } from 'next/navigation';
import { Card } from '@propertyos/ui';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadSharedDocuments } from '@/lib/portal-queries';
import { SectionHeading } from '../section';

export const metadata = { title: 'Your documents' };
export const dynamic = 'force-dynamic';

/**
 * Files the landlord shared with this lease.
 *
 * Each one is fetched through an authorised download that is recorded: the
 * link is not a public URL, and a document that was never shared with this
 * resident is "not found" rather than "forbidden".
 */
export default async function DocumentsPage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) notFound();

  const documents = await readAs(viewer, (tx) => loadSharedDocuments(tx, leaseId));

  return (
    <section aria-labelledby="documents-heading" className="space-y-3">
      <SectionHeading id="documents-heading">Your documents</SectionHeading>
      {documents.length === 0 ? (
        <Card className="px-4 py-8 text-center text-sm text-ink-500">
          No documents have been shared with you yet. Your signed lease, notices and any
          inspection report appear here once your landlord shares them.
        </Card>
      ) : (
        <Card className="divide-y divide-ink-100 p-0">
          {documents.map((doc) => (
            <a key={doc.id} href={`/portal/${leaseId}/documents/${doc.id}`}
               className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-50">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-900">{doc.title}</p>
                <p className="text-xs capitalize text-ink-500">
                  {doc.classification.replace(/_/g, ' ')} · {formatDate(doc.uploaded_at)}
                </p>
              </div>
              <span aria-hidden="true" className="text-spike-500">↓</span>
            </a>
          ))}
        </Card>
      )}
    </section>
  );
}
