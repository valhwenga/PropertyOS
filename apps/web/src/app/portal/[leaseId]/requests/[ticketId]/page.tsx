import { BackLink } from '@/components/back-link';
import { notFound } from 'next/navigation';
import { Card, StatusBadge } from '@propertyos/ui';
import { residentTicketWork } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';
import { loadResidentRequest, loadTenancy } from '@/lib/portal-queries';
import { Row, SectionHeading } from '../../section';
import { AttachPhotoForm } from './attach-photo';
import { requestPriority, requestStatus, requestTitle } from '../status';

export const metadata = { title: 'Your request' };
export const dynamic = 'force-dynamic';

/**
 * One maintenance request, from the resident's side.
 *
 * Everything here is recorded: the status history is `maintenance_ticket_events`,
 * the updates are the comments an operator marked resident-visible, the photos
 * are the attachments marked the same way, and the appointment, contractor and
 * completion note come from the work order through a function that returns
 * those fields and nothing else.
 *
 * What is deliberately absent: internal comments, quotations, the approved
 * spending ceiling, who approved it, and the contractor's own contact details.
 * A resident who needs to reach somebody reaches their landlord.
 */
export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ leaseId: string; ticketId: string }>;
}) {
  const { leaseId, ticketId } = await params;
  const viewer = await requireViewer();
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) notFound();

  const data = await readAs(viewer, async (tx) => ({
    request: await loadResidentRequest(tx, leaseId, ticketId),
    work: await residentTicketWork(tx, ticketId),
    tenancy: await loadTenancy(tx, leaseId),
  }));
  if (!data.request) notFound();

  const { ticket, events, updates, photos } = data.request;
  const { work, tenancy } = data;
  const status = requestStatus(ticket.status);
  const priority = requestPriority(ticket.urgency, ticket.triaged_urgency);
  const zone = tenancy?.time_zone ?? 'Africa/Johannesburg';

  return (
    <div className="space-y-5">
      <BackLink href={`/portal/${leaseId}/requests`} label="All your requests" />

      <div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-lg font-semibold tracking-tight text-ink-900">
            {requestTitle(ticket.description)}
          </h2>
          <div className="flex shrink-0 items-center gap-1.5">
            {priority ? (
              <StatusBadge tone={priority.tone} glyph="▲">{priority.label}</StatusBadge>
            ) : null}
            <StatusBadge tone={status.tone} glyph={status.glyph}>{status.label}</StatusBadge>
          </div>
        </div>
        <p className="mt-1 text-xs text-ink-500">
          <span className="tabular">{ticket.reference}</span> · reported{' '}
          {formatDate(ticket.created_at)}
        </p>
      </div>

      <Card className="p-0">
        <dl className="divide-y divide-ink-100">
          <Row label="What you told us">{ticket.description}</Row>
          {ticket.location ? <Row label="Where">{ticket.location}</Row> : null}
          <Row label="Kind">{ticket.category.replace(/_/g, ' ')}</Row>
        </dl>
      </Card>

      {/* ------------------------------------------------- the appointment */}
      {work && (work.appointment_at || work.vendor_name || work.completed_at) ? (
        <section aria-labelledby="visit-heading" className="space-y-3">
          <SectionHeading id="visit-heading">The visit</SectionHeading>
          <Card className="p-0">
            <dl className="divide-y divide-ink-100">
              {work.appointment_at ? (
                <Row label="Booked for">{formatDateTime(work.appointment_at, zone)}</Row>
              ) : null}
              {work.vendor_name ? (
                <Row label="Who is coming">
                  {work.vendor_name}
                  {work.vendor_category ? (
                    <span className="mt-0.5 block text-xs font-normal capitalize text-ink-500">
                      {work.vendor_category.replace(/_/g, ' ')}
                    </span>
                  ) : null}
                </Row>
              ) : null}
              {work.completed_at ? (
                <Row label="Completed">{formatDate(work.completed_at)}</Row>
              ) : null}
              {work.completion_note ? (
                <Row label="What was done">{work.completion_note}</Row>
              ) : null}
            </dl>
          </Card>
          <p className="text-xs text-ink-500">
            To change an appointment, tell your landlord — the contractor is working to their
            instruction, not yours.
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------- the updates */}
      <section aria-labelledby="updates-heading" className="space-y-3">
        <SectionHeading id="updates-heading">Updates</SectionHeading>
        {updates.length === 0 ? (
          <Card className="px-4 py-6 text-center text-sm text-ink-500">
            No updates have been written for you yet. The history below shows what has happened
            to the request itself.
          </Card>
        ) : (
          <Card className="divide-y divide-ink-100 p-0">
            {updates.map((update, index) => (
              <div key={`${update.created_at}-${index}`} className="px-4 py-3">
                <p className="text-sm text-ink-900">{update.body}</p>
                <p className="mt-1 text-xs text-ink-500">
                  {update.author ? `${update.author} · ` : ''}
                  {formatDate(update.created_at)}
                </p>
              </div>
            ))}
          </Card>
        )}
      </section>

      {/* ------------------------------------------------ attaching one more */}
      <AttachPhotoForm
        leaseId={leaseId}
        ticketId={ticketId}
        scannerConfigured={Boolean(process.env.MALWARE_SCANNER)}
      />

      {/* -------------------------------------------------------- the photos */}
      {photos.length > 0 ? (
        <section aria-labelledby="photos-heading" className="space-y-3">
          <SectionHeading id="photos-heading">Photographs</SectionHeading>
          <Card className="divide-y divide-ink-100 p-0">
            {photos.map((photo) => (
              <a
                key={photo.document_id}
                href={`/portal/${leaseId}/requests/${ticketId}/photos/${photo.document_id}`}
                className="flex min-h-11 items-center justify-between gap-3 px-4 py-3 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-spike-500"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-900">{photo.title}</p>
                  <p className="text-xs text-ink-500">Added {formatDate(photo.created_at)}</p>
                </div>
                <span aria-hidden="true" className="text-spike-500">↓</span>
              </a>
            ))}
          </Card>
          <p className="text-xs text-ink-500">
            Photographs download rather than opening here. An uploaded file is never displayed
            inside the portal, whatever it says it is.
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------- the history */}
      <section aria-labelledby="history-heading" className="space-y-3">
        <SectionHeading id="history-heading">History</SectionHeading>
        <Card className="p-4">
          <ol className="space-y-2.5">
            <li className="flex items-start gap-2.5 text-sm">
              <span aria-hidden="true" className="mt-1 text-positive-600">●</span>
              <span>
                <span className="text-ink-900">You reported this</span>
                <span className="block text-xs text-ink-500">
                  {formatDateTime(ticket.created_at, zone)}
                </span>
              </span>
            </li>
            {events.map((event, index) => (
              <li key={`${event.occurred_at}-${index}`} className="flex items-start gap-2.5 text-sm">
                <span aria-hidden="true" className="mt-1 text-positive-600">●</span>
                <span>
                  <span className="text-ink-900">{requestStatus(event.to_status).label}</span>
                  <span className="block text-xs text-ink-500">
                    {formatDateTime(event.occurred_at, zone)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </section>
    </div>
  );
}
