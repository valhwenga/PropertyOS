/**
 * The operator console's sections, and the rule for which one a page belongs to.
 *
 * Deliberately free of JSX and of React, so the rule can be tested directly
 * without a component-rendering toolchain — and so nothing about it depends on
 * where it is rendered.
 */
export const NAV = [
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
 * Decides whether a section contains the current page.
 *
 * Overview is the section root, so it matches only itself — a prefix test would
 * light it up on every page in the console. Every other section also claims its
 * descendants, so a lease detail page keeps Leases marked.
 *
 * The boundary matters: the match is on a whole path segment, so /leases never
 * claims a sibling such as /leases-archive.
 */
export function isCurrentSection(pathname: string, base: string, href: string): boolean {
  const here = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
  const target = `${base}${href}`;
  if (href === '') return here === target;
  return here === target || here.startsWith(`${target}/`);
}
