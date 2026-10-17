/**
 * The resident portal's sections, and which one a page belongs to.
 *
 * The portal was one long page. On a phone that is right — a resident scrolls
 * once and has their whole tenancy — but on a laptop it meant scrolling past
 * four sections to reach a statement, with no way to link anybody to one.
 * Splitting it also means a page loads only its own queries: the statement is
 * the expensive read, and it was being built on every visit whatever the
 * resident came for.
 *
 * Free of JSX and of React, so the rule can be tested on its own.
 */

export interface PortalSection {
  /** Appended to /portal/<leaseId>. Empty is the tenancy's own front page. */
  href: string;
  label: string;
  /** What this section answers, for the narrow-screen list. */
  hint: string;
}

export const PORTAL_SECTIONS: readonly PortalSection[] = [
  { href: '', label: 'Overview', hint: 'What you owe and how to pay it' },
  { href: '/statement', label: 'Statement', hint: 'Every charge and payment' },
  { href: '/requests', label: 'Requests', hint: 'Problems you have reported' },
  { href: '/documents', label: 'Documents', hint: 'Files shared with you' },
  { href: '/lease', label: 'Your lease', hint: 'Terms, dates and who to contact' },
] as const;

/**
 * Whether a section contains the current page.
 *
 * Overview is the section root, so it matches only itself; a prefix test would
 * light it up everywhere. The others claim their descendants, so the form at
 * /requests/new keeps Requests marked.
 *
 * The boundary is a whole path segment: /lease never claims /lease-archive.
 */
export function isCurrentPortalSection(
  pathname: string, base: string, href: string,
): boolean {
  const here = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
  const target = `${base}${href}`;
  if (href === '') return here === target;
  return here === target || here.startsWith(`${target}/`);
}
