import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, StatusBadge } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadLandlordContact, loadResidentRequests } from '@/lib/portal-queries';
import { SectionHeading } from '../section';

export const metadata = { title: 'Your requests' };
export const dynamic = 'force-dynamic';

/**
 * What happened to the thing they reported.
 *
 * A resident could log a request and then never see it again: nothing in the
 * product showed them its state. The status is in the resident's words rather
 * than the workflow's — "Being assessed" instead of "triaged" — and the latest
 * comment the landlord marked visible comes with it, because "we have ordered
 * the part" is the answer to the question they would otherwise phone about.
 */
const REQUEST_STATUS: Record<string, { tone: StatusTone; glyph: string; label: string }> = {
  submitted:             { tone: 'caution',  glyph: '◐', label: 'Received' },
  triaged:               { tone: 'caution',  glyph: '◐', label: 'Being assessed' },
  awaiting_approval:     { tone: 'caution',  glyph: '◐', label: 'Awaiting approval' },
  assigned:              { tone: 'info',     glyph: '◆', label: 'Contractor assigned' },
  in_progress:           { tone: 'info',     glyph: '◆', label: 'Work in progress' },
  awaiting_confirmation: { tone: 'info',     glyph: '◆', label: 'Waiting on you' },
  resolved:              { tone: 'positive', glyph: '✓', label: 'Resolved' },
  closed:                { tone: 'neutral',  glyph: '■', label: 'Closed' },
  cancelled:             { tone: 'neutral',  glyph: '✕', label: 'Cancelled' },
};

export default async function RequestsPage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) notFound();

  const { requests, contact } = await readAs(viewer, async (tx) => ({
    requests: await loadResidentRequests(tx, leaseId),
    contact: await loadLandlordContact(tx, leaseId),
  }));
  const open = requests.filter((r) => !['resolved', 'closed', 'cancelled'].includes(r.status));

  return (
    <section aria-labelledby="requests-heading" className="space-y-3">
      <SectionHeading
        id="requests-heading"
        action={
          <Link href={`/portal/${leaseId}/requests/new`}
                className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
            Report a problem
          </Link>
        }
      >
        Your requests{open.length > 0 ? ` (${open.length} open)` : ''}
      </SectionHeading>

      {requests.length === 0 ? (
        <Card className="px-4 py-8 text-center text-sm text-ink-500">
          Nothing reported. If something in the property needs fixing, tell your landlord here
          so there is a record of when you reported it.
        </Card>
      ) : (
        <Card className="divide-y divide-ink-100 p-0">
          {requests.map((request) => {
            const status = REQUEST_STATUS[request.status]
              ?? { tone: 'neutral' as StatusTone, glyph: '○', label: request.status };
            return (
              <div key={request.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-ink-900">{request.description}</p>
                  <StatusBadge tone={status.tone} glyph={status.glyph}>{status.label}</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  <span className="tabular">{request.reference}</span> · reported{' '}
                  {formatDate(request.created_at)}
                </p>
                {request.last_update ? (
                  <p className="mt-2 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">
                    {request.last_update}
                    <span className="mt-0.5 block text-xs text-ink-400">
                      {request.last_update_at ? formatDate(request.last_update_at) : null}
                    </span>
                  </p>
                ) : null}
              </div>
            );
          })}
        </Card>
      )}

      <p className="text-xs text-ink-500">
        A request logged here is not an emergency service. If somebody is in danger, or water
        or electricity is causing damage right now, phone
        {contact?.phone ? ` ${contact.phone}` : ' your landlord'} as well.
      </p>
    </section>
  );
}
