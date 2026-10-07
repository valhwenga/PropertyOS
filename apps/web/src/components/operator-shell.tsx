import Link from 'next/link';
import { OperatorNav } from './operator-nav';
import { Wordmark } from './wordmark';

/**
 * The operator console's chrome: a left sidebar on a wide screen, the original
 * stacked header on a narrow one.
 *
 * Thirteen sections never fitted across the top — they scrolled sideways, so
 * the later ones were invisible until you dragged the bar. Down the side they
 * are all legible at once, which is what a console with this many areas needs.
 *
 * One set of markup, re-arranged by CSS at the `lg` breakpoint. A collapsible
 * drawer would need client state, and the narrow layout is unchanged from
 * before, so a phone keeps the horizontally scrolling bar it already had rather
 * than gaining a sidebar that would eat the screen.
 *
 * This shell stays a server component. Only the section list is a client
 * component, because marking the current section means reading the pathname.
 */
export function OperatorShell({
  slug, organisationName, userName, children,
}: {
  slug: string; organisationName: string; userName: string; children: React.ReactNode;
}) {
  const base = `/app/${slug}`;
  return (
    <div className="min-h-dvh bg-ink-50 lg:flex">
      <header
        className="
          border-b border-ink-100 bg-white
          lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0
          lg:flex lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-r
        "
      >
        <div
          className="
            flex items-center justify-between gap-4 px-4 py-3
            lg:block lg:space-y-3 lg:py-4
          "
        >
          <div className="flex min-w-0 items-center gap-3 lg:block lg:space-y-1">
            <Link href="/app" className="text-base"><Wordmark /></Link>
            <span aria-hidden="true" className="text-ink-200 lg:hidden">/</span>
            <span className="block truncate text-sm font-medium text-ink-700">
              {organisationName}
            </span>
          </div>
          <div className="flex items-center gap-3 lg:justify-between">
            <span className="hidden truncate text-sm text-ink-500 sm:inline">{userName}</span>
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
