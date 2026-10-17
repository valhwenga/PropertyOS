import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, StatusBadge } from '@propertyos/ui';
import { residentEmergencyContact } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadResidentRequests } from '@/lib/portal-queries';
import { SectionHeading } from '../section';
import { OPEN_STATES, requestPriority, requestStatus, requestTitle } from './status';

export const metadata = { title: 'Maintenance' };
export const dynamic = 'force-dynamic';

/**
 * What the resident has reported, and what has happened to it.
 *
 * Each card opens the request itself, because a list that shows a status and
 * nothing else leaves "when is somebody coming?" unanswered.
 */
export default async function RequestsPage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) notFound();

  const { requests, emergency } = await readAs(viewer, async (tx) => ({
    requests: await loadResidentRequests(tx, leaseId),
    emergency: await residentEmergencyContact(tx, leaseId),
  }));
  const open = requests.filter((r) => OPEN_STATES.includes(r.status));

  return (
    <section aria-labelledby="requests-heading" className="space-y-3">
      <SectionHeading
        id="requests-heading"
        action={
          <Link href={`/portal/${leaseId}/requests/new`}
                className="min-h-11 rounded-lg bg-spike-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-spike-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500">
            Report a problem
          </Link>
        }
      >
        Maintenance{open.length > 0 ? ` (${open.length} open)` : ''}
      </SectionHeading>

      {/* Who to phone when it cannot wait. Only when the landlord has recorded
          somebody: a number invented by the product is worse than none, and an
          unconfigured organisation is told what is missing rather than shown a
          placeholder. */}
      <Card className="border-caution-700/25 bg-caution-50 p-4">
        <p className="text-sm font-semibold text-caution-700">If it cannot wait</p>
        <p className="mt-1 text-sm text-ink-700">
          A request logged here is not an emergency service.{' '}
          {emergency ? (
            <>
              For a burst pipe, an electrical danger, a fire or a security risk, phone{' '}
              <a href={`tel:${emergency.replace(/[^+\d]/g, '')}`}
                 className="font-medium text-spike-700 underline">
                {emergency}
              </a>{' '}
              as well as reporting it here.
            </>
          ) : (
            <>
              Your landlord has not given an emergency number for this portal. For a burst pipe,
              an electrical danger, a fire or a security risk, use the emergency contact details
              on your lease agreement as well as reporting it here.
            </>
          )}
        </p>
      </Card>

      {requests.length === 0 ? (
        <Card className="px-4 py-8 text-center text-sm text-ink-500">
          Nothing reported. If something in the property needs fixing, tell your landlord here
          so there is a record of when you reported it.
        </Card>
      ) : (
        <Card className="divide-y divide-ink-100 p-0">
          {requests.map((request) => {
            const status = requestStatus(request.status);
            const priority = requestPriority(request.urgency, null);
            return (
              <Link
                key={request.id}
                href={`/portal/${leaseId}/requests/${request.id}`}
                className="block px-4 py-3 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-spike-500"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-medium text-ink-900">
                    {requestTitle(request.description)}
                  </p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {priority ? (
                      <StatusBadge tone={priority.tone} glyph="▲">{priority.label}</StatusBadge>
                    ) : null}
                    <StatusBadge tone={status.tone} glyph={status.glyph}>{status.label}</StatusBadge>
                  </div>
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  <span className="tabular">{request.reference}</span> · reported{' '}
                  {formatDate(request.created_at)}
                  {request.last_update_at
                    ? ` · last update ${formatDate(request.last_update_at)}`
                    : ''}
                </p>
                {request.last_update ? (
                  <p className="mt-1.5 line-clamp-2 text-sm text-ink-600">{request.last_update}</p>
                ) : null}
              </Link>
            );
          })}
        </Card>
      )}
    </section>
  );
}
