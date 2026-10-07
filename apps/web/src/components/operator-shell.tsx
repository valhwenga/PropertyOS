import Link from 'next/link';
import { Wordmark } from './wordmark';

const NAV = [
  { href: '', label: 'Overview' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/residents', label: 'Residents' },
  { href: '/leases', label: 'Leases' },
  { href: '/billing', label: 'Billing' },
  { href: '/reconciliation', label: 'Reconciliation' },
  { href: '/deposits', label: 'Deposits' },
  { href: '/expenses', label: 'Expenses' },
  { href: '/maintenance', label: 'Maintenance' },
  { href: '/documents', label: 'Documents' },
  { href: '/reports', label: 'Reports' },
  { href: '/onboarding', label: 'Import' },
  { href: '/settings', label: 'Settings' },
] as const;

/**
 * The operator console's chrome: a left sidebar on a wide screen, the original
 * stacked header on a narrow one.
 *
 * Thirteen sections never fitted across the top — they scrolled sideways, so
 * the later ones were invisible until you dragged the bar. Down the side they
 * are all legible at once, which is what a console with this many areas needs.
 *
 * Deliberately no JavaScript: one set of markup, re-arranged by CSS at the `lg`
 * breakpoint. A collapsible drawer would need client state, and this is a
 * server component — the narrow layout is unchanged from before, so a phone
 * keeps the horizontally scrolling bar it already had rather than gaining a
 * sidebar that would eat the screen.
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

        <nav
          aria-label="Sections"
          className="overflow-x-auto px-4 lg:overflow-x-visible lg:pb-4"
        >
          <ul className="flex gap-1 pb-2 lg:flex-col lg:gap-0.5 lg:pb-0">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={`${base}${item.href}`}
                  className="
                    block whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-ink-700
                    hover:bg-spike-50 hover:text-spike-700
                  "
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      {/* min-w-0 matters: without it a wide table — the lease statement, for one
          — stretches this flex item and pushes the whole page sideways. */}
      <div className="min-w-0 flex-1">
        <main id="main" className="mx-auto max-w-[80rem] px-4 py-6">{children}</main>
      </div>
    </div>
  );
}
