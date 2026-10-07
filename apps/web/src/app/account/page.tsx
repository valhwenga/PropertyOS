import Link from 'next/link';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import { countUnreadNotifications } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { ProfileForm } from './profile-form';

export const metadata = { title: 'Your profile' };
export const dynamic = 'force-dynamic';

/**
 * Everyone's own profile — operator, finance preparer, resident or Spike
 * operator alike. There is no organisation in the path because a resident does
 * not belong to one.
 */
export default async function AccountPage() {
  const viewer = await requireViewer();
  const [unread, profile] = await readAs(viewer, async (tx) => [
    await countUnreadNotifications(tx, viewer.authUserId),
    // The phone is not part of the session, so it is read here rather than
    // carried around on every request that does not need it.
    (await tx<{ phone: string | null }[]>`
      select phone from user_profiles where auth_user_id = ${viewer.authUserId}::uuid
    `)[0] ?? { phone: null },
  ] as const);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <PageHeader title="Your profile" description="Your details, and how PropertyOS reaches you." />

      <ProfileForm
        fullName={viewer.fullName}
        email={viewer.email}
        phone={profile.phone ?? ''}
      />

      <Card className="flex items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium text-ink-900">Notifications</p>
          <p className="text-sm text-ink-500">
            {unread === 0 ? 'Nothing unread.' : `${unread} unread.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unread > 0 ? <StatusBadge tone="info">{String(unread)}</StatusBadge> : null}
          <Link href="/account/notifications"
                className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm text-ink-700">
            Open inbox
          </Link>
        </div>
      </Card>

      <Card className="p-4">
        <p className="text-sm font-medium text-ink-900">Second factor</p>
        <p className="mt-1 text-sm text-ink-500">
          {viewer.assuranceLevel === 'aal2'
            ? 'You signed in with a second factor on this session.'
            : 'This session has no second factor. Elevated permissions stay withheld until you provide one.'}
        </p>
      </Card>
    </div>
  );
}
