import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge } from '@propertyos/ui';
import { listMyNotifications } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { MarkAllRead, MarkRead } from './mark-read';

export const metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const viewer = await requireViewer();
  const notices = await readAs(viewer, (tx) => listMyNotifications(tx, viewer.authUserId));
  const unread = notices.filter((n) => !n.readAt).length;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <PageHeader
        title="Notifications"
        description="What PropertyOS has told you. Marking a notice read changes nothing about the thing it refers to."
      />

      <div className="flex items-center justify-between gap-3">
        <Link href="/account" className="text-sm text-spike-700 hover:underline">← Your profile</Link>
        {unread > 0 ? <MarkAllRead count={unread} /> : null}
      </div>

      {notices.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          description="Notices about your leases, documents and payments appear here."
        />
      ) : (
        <Card className="divide-y divide-ink-100 p-0">
          {notices.map((n) => (
            <article key={n.id} className={`px-4 py-3 ${n.readAt ? '' : 'bg-spike-50/40'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">
                    {n.title}
                    {n.readAt ? null : (
                      <span className="ml-2 align-middle">
                        <StatusBadge tone="info">New</StatusBadge>
                      </span>
                    )}
                  </p>
                  <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{n.body}</p>
                  <p className="mt-1 text-xs text-ink-400">{formatDateTime(n.createdAt)}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {n.linkPath ? (
                    <Link href={n.linkPath} className="text-sm text-spike-700 hover:underline">
                      Open →
                    </Link>
                  ) : null}
                  {n.readAt ? null : <MarkRead id={n.id} />}
                </div>
              </div>
            </article>
          ))}
        </Card>
      )}
    </div>
  );
}
