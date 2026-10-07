import Link from 'next/link';
import { AccountLink } from '@/components/account-link';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';
import { countUnreadNotifications } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';

/**
 * Resident portal shell.
 *
 * Designed mobile-first: the whole flow is usable one-handed at 360px with no
 * horizontal scrolling.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();
  const unread = await readAs(viewer, (tx) =>
    countUnreadNotifications(tx, viewer.authUserId));
  return (
    <div className="min-h-dvh bg-ink-50">
      <header className="border-b border-ink-100 bg-surface">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/portal" className="text-base"><Wordmark compact /></Link>
          <div className="flex items-center gap-2">
            <Link href="/account" className="hidden text-sm text-ink-500 hover:underline sm:inline">
              {viewer.fullName}
            </Link>
            <AccountLink unread={unread} compact />
            <ThemeToggle />
            <form action="/sign-out" method="post">
              <button type="submit" className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm text-ink-700">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-2xl px-4 py-5 pb-24">{children}</main>
    </div>
  );
}
