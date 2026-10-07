import Link from 'next/link';

/**
 * The way to your own profile and inbox, from any chrome.
 *
 * The unread count is passed in rather than queried here, so a shell that
 * already loaded it does not pay for a second query, and a shell that cannot
 * (an unauthenticated page) simply does not render this.
 */
export function AccountLink({ unread, compact = false }: { unread: number; compact?: boolean }) {
  return (
    <Link
      href="/account/notifications"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      className="relative inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 text-sm text-ink-700 hover:bg-ink-50"
    >
      <span aria-hidden="true">✉</span>
      {compact ? null : <span className="hidden sm:inline">Inbox</span>}
      {unread > 0 ? (
        <span className="ml-0.5 rounded-full bg-spike-500 px-1.5 text-xs font-medium text-white tabular">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Link>
  );
}
