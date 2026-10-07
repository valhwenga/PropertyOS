import Link from 'next/link';
import { AccountLink } from './account-link';
import { OperatorNav } from './operator-nav';
import { ThemeToggle } from './theme-toggle';
import { Wordmark } from './wordmark';

/**
 * The operator console's chrome: a left sidebar on a wide screen, the original
 * stacked header on a narrow one.
 *
 * Thirteen sections never fitted across the top — they scrolled sideways, so
 * the later ones were invisible until you dragged the bar. Down the side they
 * are all legible at once, which is what a console with this many areas needs.
 *
 * One set of markup, re-arranged by CSS at the `md` breakpoint (768px), so a
 * window at half the width of a laptop screen still gets the sidebar. A collapsible
 * drawer would need client state, and the narrow layout is unchanged from
 * before, so a phone keeps the horizontally scrolling bar it already had rather
 * than gaining a sidebar that would eat the screen.
 *
 * This shell stays a server component. Only the section list is a client
 * component, because marking the current section means reading the pathname.
 */
export function OperatorShell({
  slug, organisationName, userName, unreadNotices, children,
}: {
  slug: string; organisationName: string; userName: string;
  unreadNotices: number; children: React.ReactNode;
}) {
  const base = `/app/${slug}`;
  return (
    <div className="min-h-dvh bg-ink-50 md:flex">
      <header
        className="
          border-b border-ink-100 bg-surface
          md:sticky md:top-0 md:h-dvh md:w-56 md:shrink-0
          md:flex md:flex-col md:overflow-y-auto md:border-b-0 md:border-r
        "
      >
        <div
          className="
            flex items-center justify-between gap-4 px-4 py-3
            md:block md:space-y-3 md:py-4
          "
        >
          <div className="flex min-w-0 items-center gap-3 md:block md:space-y-1">
            <Link href="/app" className="text-base"><Wordmark /></Link>
            <span aria-hidden="true" className="text-ink-200 md:hidden">/</span>
            <span className="block truncate text-sm font-medium text-ink-700">
              {organisationName}
            </span>
          </div>
          {/* The sidebar is 15rem wide, so the name and both controls do not fit
              on one line there. Stacking them at lg keeps the name whole and
              stops "Sign out" wrapping onto two lines. */}
          <div className="flex items-center gap-2 md:flex-col md:items-start md:gap-2.5">
            <Link href="/account"
                  className="hidden truncate text-sm text-ink-500 hover:underline sm:inline md:max-w-full">
              {userName}
            </Link>
            <div className="flex items-center gap-2">
            <AccountLink unread={unreadNotices} compact />
            <ThemeToggle />
            <form action="/sign-out" method="post">
              <button
                type="submit"
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50"
              >
                Sign out
              </button>
            </form>
            </div>
          </div>
        </div>

        <OperatorNav base={base} />
      </header>

      {/* min-w-0 matters: without it a wide table — the lease statement, for one
          — stretches this flex item and pushes the whole page sideways. */}
      <div className="min-w-0 flex-1">
        <main id="main" className="mx-auto max-w-[80rem] px-4 py-6">{children}</main>
      </div>
    </div>
  );
}
