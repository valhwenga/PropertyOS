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
  { href: '/settings', label: 'Settings' },
] as const;

export function OperatorShell({
  slug, organisationName, userName, children,
}: {
  slug: string; organisationName: string; userName: string; children: React.ReactNode;
}) {
  const base = `/app/${slug}`;
  return (
    <div className="min-h-dvh bg-ink-50">
      <header className="border-b border-ink-100 bg-white">
        <div className="mx-auto flex max-w-[90rem] items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/app" className="text-base"><Wordmark /></Link>
            <span aria-hidden="true" className="text-ink-200">/</span>
            <span className="truncate text-sm font-medium text-ink-700">{organisationName}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-ink-500 sm:inline">{userName}</span>
            <form action="/sign-out" method="post">
              <button type="submit" className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <nav aria-label="Sections" className="mx-auto max-w-[90rem] overflow-x-auto px-4">
          <ul className="flex gap-1 pb-2">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={`${base}${item.href}`}
                  className="block whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-ink-700 hover:bg-spike-50 hover:text-spike-700"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-[90rem] px-4 py-6">{children}</main>
    </div>
  );
}
