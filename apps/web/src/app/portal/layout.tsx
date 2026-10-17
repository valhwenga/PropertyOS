import Link from 'next/link';
import { AccountLink } from '@/components/account-link';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';
import { countUnreadNotifications } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';

/**
 * Resident portal shell.
 *
 * Mobile-first: usable one-handed at 360px with no horizontal scrolling, and
 * with the sections along the bottom where a thumb already is.
 *
 * The header carries the person and their account controls. It deliberately
 * does NOT carry the landlord's name — that belongs beside the property, in
 * the tenancy itself, because a resident with two tenancies has two landlords.
 *
 * Platform attribution sits in the footer, once, quietly. The portal is the
 * landlord's front door; Spike is the machinery.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();
  const unread = await readAs(viewer, (tx) =>
    countUnreadNotifications(tx, viewer.authUserId));
  // The bottom padding clears the fixed section bar and, beneath it, the home
  // indicator on a phone that has one. It lives on the whole column so the
  // footer clears the bar as well — padding only the page content would leave
  // the attribution underneath it.
  return (
    <div
      className="flex min-h-dvh flex-col bg-ink-50"
      style={{ paddingBottom: 'calc(4.5rem + env(safe-area-inset-bottom))' }}
    >
      <header className="border-b border-ink-100 bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <Link
            href="/portal"
            className="rounded text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500"
          >
            <Wordmark compact />
            <span className="sr-only">Your tenancies</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/account"
              className="hidden rounded text-sm text-ink-500 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500 sm:inline"
            >
              {viewer.fullName}
            </Link>
            <AccountLink unread={unread} compact />
            <ThemeToggle />
            {/* On a phone this lives under More, where the rest of the account
                actions are; two sign-out buttons on one screen is one too many. */}
            <form action="/sign-out" method="post" className="hidden md:block">
              <button
                type="submit"
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-5">{children}</main>

      <footer className="mx-auto w-full max-w-4xl px-4 pb-6 pt-2">
        <p className="text-xs text-ink-400">Powered by Spike Technologies</p>
      </footer>
    </div>
  );
}
